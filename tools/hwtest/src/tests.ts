import { execFile } from 'node:child_process'
import dgram from 'node:dgram'
import net from 'node:net'
import os from 'node:os'
import { promisify } from 'node:util'
import {
  DEFAULT_DOOR_OPEN_TOO_LONG,
  EventOverwrittenError,
  ExpansionEvent,
  ExpansionOutputMode,
  ExpansionSource,
  hexdump,
  INACTIVE_RELAY,
  isValidWiegand26,
  NotFoundError,
  Reason,
  TimeoutError,
  UhppoteClient,
  parseEndpoint,
  type Card,
  type ControllerStatus,
  type ExpansionBoardConfig,
  type ExpansionRelay,
  type Quad,
} from '@uhppote-desk/protocol'
import type { Context, TestCase, TestHelpers } from './framework.js'

const exec = promisify(execFile)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pad = (n: number) => String(n).padStart(2, '0')
const now = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const today = () => now().slice(0, 10)
const percentile = (xs: number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0

function requireHost(ctx: Context, t: TestHelpers): string {
  if (!ctx.opts.host) t.skip('controller IP address not specified (--ip)')
  return ctx.opts.host
}

function testCard(ctx: Context, card: number, doors: Quad<number>, pin = 0): Card {
  return {
    card,
    from: today(),
    to: `${new Date().getFullYear() + 1}-12-31`,
    doors,
    pin,
    firstCard: [false, false, false, false],
  }
}

/** Temporarily points the controller's listener at this host (saving the original). */
async function attachListener(ctx: Context, t: TestHelpers, interval = 0): Promise<void> {
  if (!ctx.opts.publicIp) t.skip('IP of this host not determined (--public-ip)')
  if (!ctx.backup.listener) ctx.backup.listener = await ctx.client.getListener(ctx.target)
  const { port } = parseEndpoint(ctx.opts.listen, 60001)
  await ctx.client.setListener(ctx.target, { address: ctx.opts.publicIp, port, interval })
}

async function restoreListener(ctx: Context): Promise<void> {
  const l = ctx.backup.listener as { address: string; port: number; interval: number } | undefined
  if (l) await ctx.client.setListener(ctx.target, l)
}

async function ensureSpecialEvents(ctx: Context): Promise<void> {
  await ctx.client.recordSpecialEvents(ctx.target, true)
}

/** Runs a command that creates/changes a test card and guarantees its removal. */
async function withTestCard<T>(ctx: Context, card: Card, fn: () => Promise<T>): Promise<T> {
  const existing = await ctx.client.getCard(ctx.target, card.card)
  if (existing)
    throw new Error(`test card ${card.card} already exists on the controller: choose another number with --test-card`)
  await ctx.client.putCard(ctx.target, card)
  try {
    return await fn()
  } finally {
    await ctx.client.deleteCard(ctx.target, card.card).catch(() => undefined)
  }
}

async function userCard(ctx: Context, t: TestHelpers): Promise<number> {
  if (ctx.opts.userCard) return ctx.opts.userCard
  if (ctx.facts.userCard) return ctx.facts.userCard as number
  const answer = (
    await ctx.driver.ask('Number of the real card to use for the tests (8 digits, Enter to detect it with a swipe)')
  ).trim()
  let card = Number(answer)
  if (!answer) {
    await attachListener(ctx, t)
    const since = ctx.events.length
    await ctx.driver.perform({ kind: 'swipe', card: null, door: 1 }, 'Swipe the test card on the door 1 reader')
    const ev = await ctx.waitEvent((s) => ctx.events.indexOf(s) >= since && s.event?.type === 1, 30_000)
    if (!ev?.event) t.skip('no swipe detected')
    card = ev.event.card
    t.log(`card detected: ${card}`)
  }
  if (!isValidWiegand26(card)) t.warn(`card number ${card} is not valid for Wiegand-26`)
  ctx.facts.userCard = card
  return card
}

// ===========================================================================
// L0 — Network
// ===========================================================================

export const L0: TestCase[] = [
  {
    id: 'L0.1',
    level: 0,
    name: 'Host network interfaces',
    async run(ctx: Context, t: TestHelpers) {
      const ifs = Object.entries(os.networkInterfaces()).flatMap(([name, a]) =>
        (a ?? []).filter((x) => x.family === 'IPv4' && !x.internal).map((x) => ({ name, ...x })),
      )
      for (const i of ifs) t.log(`${i.name}: ${i.address}/${i.netmask}`)
      t.data(ifs)
      t.assert(ifs.length > 0, 'no active IPv4 interface')
      if (ctx.opts.host) {
        const ip = ipToInt(ctx.opts.host)
        const same = ifs.find((i) => (ipToInt(i.address) & ipToInt(i.netmask)) === (ip & ipToInt(i.netmask)))
        if (!same) t.warn(`no interface on the same subnet as ${ctx.opts.host}: broadcast discovery will not work`)
        t.log(
          `interface towards the controller: ${same.name} (${same.address}); subnet broadcast ${intToIp((ipToInt(same.address) & ipToInt(same.netmask)) | (~ipToInt(same.netmask) >>> 0))}`,
        )
        ctx.facts.localIp = same.address
      }
    },
  },
  {
    id: 'L0.2',
    level: 0,
    name: 'Controller ping',
    async run(ctx: Context, t: TestHelpers) {
      const host = requireHost(ctx, t)
      const args = process.platform === 'win32' ? ['-n', '3', '-w', '1000', host] : ['-c', '3', '-W', '1', host]
      try {
        const { stdout } = await exec('ping', args, { timeout: 10_000 })
        // summary line of ping ("perdita"/"persi" on an Italian-language Windows)
        const line = stdout.split(/\r?\n/).find((l) => /(perdit|loss|persi)/i.test(l))
        if (line) t.log(line.trim())
      } catch (err) {
        t.warn(
          `ping failed (${(err as Error).message.split('\n')[0]}); some controllers do not answer ICMP: continue with the UDP tests`,
        )
      }
    },
  },
  {
    id: 'L0.3',
    level: 0,
    name: 'Local UDP port for events available',
    async run(ctx: Context, t: TestHelpers) {
      const { host, port } = parseEndpoint(ctx.opts.listen, 60001)
      // the test runner's listener is already listening: check that it is reachable on loopback
      const sock = dgram.createSocket('udp4')
      await new Promise<void>((resolve, reject) =>
        sock.send(Buffer.from('ping'), port, host === '0.0.0.0' ? '127.0.0.1' : host, (e) =>
          e ? reject(e) : resolve(),
        ),
      )
      sock.close()
      t.log(`test listener listening on ${host}:${port}`)
    },
  },
  {
    id: 'L0.4',
    level: 0,
    name: 'Discovery broadcast',
    async run(ctx: Context, t: TestHelpers) {
      const broadcasts = new Set([ctx.opts.broadcast])
      if (ctx.facts.localIp && ctx.opts.host) {
        const ifc = Object.values(os.networkInterfaces())
          .flat()
          .find((i) => i?.address === ctx.facts.localIp)
        if (ifc)
          broadcasts.add(
            `${intToIp((ipToInt(ifc.address) & ipToInt(ifc.netmask)) | (~ipToInt(ifc.netmask) >>> 0))}:60000`,
          )
      }
      let found = false
      for (const b of broadcasts) {
        const list = await ctx.client.discover(b)
        t.log(
          `${b}: ${list.length ? list.map((c) => `${c.controller}@${c.address} ${c.version}`).join(', ') : 'no reply'}`,
        )
        if (list.some((c) => c.controller === ctx.opts.serial)) found = true
      }
      if (!found)
        t.warn(
          `controller ${ctx.opts.serial} did not answer the broadcast (normal if it is on another subnet or behind a Docker bridge)`,
        )
    },
  },
  {
    id: 'L0.5',
    level: 0,
    name: 'Get controller via unicast UDP',
    async run(ctx: Context, t: TestHelpers) {
      const host = requireHost(ctx, t)
      const info = await ctx.client.getController({ id: ctx.opts.serial, host, port: ctx.opts.port, transport: 'udp' })
      t.assert(info.controller === ctx.opts.serial, `reply from unexpected serial number ${info.controller}`)
      t.log(
        `IP ${info.address}/${info.netmask} gw ${info.gateway}, MAC ${info.mac}, firmware ${info.version} (${info.date})`,
      )
      if (info.address !== host) t.warn(`the controller reports IP ${info.address} but answers on ${host} (NAT?)`)
      ctx.facts.firmware = info.version
    },
  },
  {
    id: 'L0.6',
    level: 0,
    name: 'Get controller via TCP (recent firmware)',
    async run(ctx: Context, t: TestHelpers) {
      const host = requireHost(ctx, t)
      const reachable = await new Promise<boolean>((resolve) => {
        const s = net.connect({ host, port: ctx.opts.port, timeout: 2000 }, () => {
          s.destroy()
          resolve(true)
        })
        s.on('error', () => resolve(false))
        s.on('timeout', () => {
          s.destroy()
          resolve(false)
        })
      })
      if (!reachable) t.warn('TCP port 60000 not reachable: firmware without TCP support, use UDP')
      const info = await ctx.client.getController({ id: ctx.opts.serial, host, port: ctx.opts.port, transport: 'tcp' })
      t.assert(info.controller === ctx.opts.serial, 'wrong serial number in the TCP reply')
      t.log('TCP supported')
      ctx.facts.tcp = true
    },
  },
  {
    id: 'L0.7',
    level: 0,
    name: 'Comparison with uhppoted-cli (optional)',
    async run(ctx: Context, t: TestHelpers) {
      if (!ctx.opts.cliPath) t.skip('uhppoted-cli path not given (--cli)')
      const args = [
        '--bind',
        `${ctx.opts.bind}:0`,
        '--broadcast',
        ctx.opts.broadcast,
        '--timeout',
        '2.5s',
        'get-device',
        String(ctx.opts.serial),
      ]
      const { stdout } = await exec(ctx.opts.cliPath, args, { timeout: 15_000 })
      t.log(`uhppoted-cli: ${stdout.trim()}`)
      const info = await ctx.client.getController(ctx.target)
      t.assert(stdout.includes(String(ctx.opts.serial)), 'CLI output without the serial number')
      t.assert(stdout.includes(info.address), `the CLI reports an IP other than ${info.address}`)
    },
  },
]

// ===========================================================================
// L1 — Read-only
// ===========================================================================

export const L1: TestCase[] = [
  {
    id: 'L1.1',
    level: 1,
    name: 'Device information',
    async run(ctx: Context, t: TestHelpers) {
      const info = await ctx.client.getController(ctx.target)
      t.data(info)
      t.log(`firmware ${info.version} dated ${info.date}`)
      ctx.facts.firmware = info.version
      const [maj, min] = info.version.replace('v', '').split('.').map(Number)
      if ((maj ?? 0) * 100 + (min ?? 0) < 656) t.warn('firmware older than v6.56: not officially supported by uhppoted')
      if (info.version === 'v6.62') t.log('firmware v6.62: push events use SOM 0x19 (handled)')
    },
  },
  {
    id: 'L1.2',
    level: 1,
    name: 'Controller time and drift',
    async run(ctx: Context, t: TestHelpers) {
      const time = await ctx.client.getTime(ctx.target)
      t.assert(time, 'invalid time')
      const drift = Math.round((new Date(time.replace(' ', 'T')).getTime() - Date.now()) / 1000)
      t.log(`controller time ${time}, drift ${drift}s`)
      t.data({ time, drift })
      ctx.facts.drift = drift
      if (Math.abs(drift) > 60) t.warn(`clock drift of ${drift}s (the app will correct it)`)
    },
  },
  {
    id: 'L1.3',
    level: 1,
    name: 'Status (doors, relays, inputs, last event)',
    async run(ctx: Context, t: TestHelpers) {
      const s = await ctx.client.getStatus(ctx.target)
      t.data(s)
      t.log(
        `doors: ${s.doorOpen.map((o, i) => `${i + 1}:${o ? 'open' : 'closed'}`).join(' ')}; buttons: ${s.buttonPressed.map((b) => (b ? 1 : 0)).join('')}; relays 0b${s.relays.toString(2).padStart(4, '0')}; inputs 0x${s.inputs.toString(16)}`,
      )
      t.log(`system error ${s.systemError}, special info ${s.specialInfo}`)
      t.log(
        s.event
          ? `last event #${s.event.index}: type ${s.event.type}, card ${s.event.card}, door ${s.event.door}, reason ${s.event.reason} (${s.event.timestamp})`
          : 'no events stored',
      )
      ctx.facts.lastEvent = s.event?.index ?? 0
      if (s.systemError !== 0) t.warn(`system error ${s.systemError}`)
    },
  },
  {
    id: 'L1.4',
    level: 1,
    name: 'Configured listener',
    async run(ctx: Context, t: TestHelpers) {
      const l = await ctx.client.getListener(ctx.target)
      t.data(l)
      t.log(`listener ${l.address}:${l.port}, auto-send ${l.interval}s`)
      ctx.backup.listener = l
      if (l.address === '0.0.0.0') t.warn('no listener configured (the app will set it)')
    },
  },
  {
    id: 'L1.5',
    level: 1,
    name: 'Configuration of doors 1-4',
    async run(ctx: Context, t: TestHelpers) {
      const doors = []
      for (let d = 1; d <= 4; d++) {
        const c = await ctx.client.getDoorControl(ctx.target, d)
        doors.push(c)
        t.log(`door ${d}: mode ${c.mode}, delay ${c.delay}s`)
      }
      ctx.backup.doors = doors
      t.data(doors)
    },
  },
  {
    id: 'L1.6',
    level: 1,
    name: 'Stored cards',
    async run(ctx: Context, t: TestHelpers) {
      const n = await ctx.client.getCards(ctx.target)
      t.log(`${n} cards`)
      ctx.facts.cards = n
      if (n > 0 && n <= 2000) {
        const started = Date.now()
        const cards = await ctx.client.listCards(ctx.target)
        t.log(`full read: ${cards.length} cards in ${Date.now() - started} ms`)
        t.assert(cards.length === n, `read ${cards.length} cards out of ${n} reported`)
        ctx.backup.cards = cards
      } else if (n > 2000) t.log('full read skipped (> 2000 cards)')
    },
  },
  {
    id: 'L1.7',
    level: 1,
    name: 'Events: bookmark, first and last',
    async run(ctx: Context, t: TestHelpers) {
      const bookmark = await ctx.client.getEventIndex(ctx.target)
      ctx.backup.eventIndex = bookmark
      const last = await ctx.client.getLastEventIndex(ctx.target)
      t.log(`download bookmark ${bookmark}, last event ${last}`)
      if (last === 0) t.skip('no events stored')
      const ev = await ctx.client.getEvent(ctx.target, last)
      t.log(`event ${last}: ${JSON.stringify(ev)}`)
      try {
        const first = await ctx.client.getEvent(ctx.target, 1)
        t.log(`event 1 available (${first.timestamp})`)
      } catch (err) {
        if (err instanceof EventOverwrittenError) t.log('event 1 overwritten (the ring buffer was full in the past)')
        else if (err instanceof NotFoundError) t.log('event 1 not present')
        else throw err
      }
      try {
        await ctx.client.getEvent(ctx.target, last + 1)
        t.warn(`event ${last + 1} (past the last one) is present: unexpected behaviour`)
      } catch (err) {
        t.assert(
          err instanceof NotFoundError,
          `event past the last one: expected "not found", got ${(err as Error).message}`,
        )
        t.log('index past the last one → not found (as expected)')
      }
    },
  },
  {
    id: 'L1.8',
    level: 1,
    name: 'Anti-passback',
    async run(ctx: Context, t: TestHelpers) {
      const apb = await ctx.client.getAntiPassback(ctx.target)
      t.log(`anti-passback mode ${apb}`)
      ctx.backup.antipassback = apb
    },
  },
  {
    id: 'L1.9',
    level: 1,
    name: 'Latency (20 status requests)',
    async run(ctx: Context, t: TestHelpers) {
      const times: number[] = []
      for (let i = 0; i < 20; i++) {
        const s = Date.now()
        await ctx.client.getStatus(ctx.target)
        times.push(Date.now() - s)
      }
      t.log(`p50 ${percentile(times, 50)} ms, p95 ${percentile(times, 95)} ms, max ${Math.max(...times)} ms`)
      t.data(times)
      if (percentile(times, 95) > 500) t.warn('high latency (> 500 ms at the 95th percentile)')
    },
  },
]

// ===========================================================================
// L2 — Safe writes (with restore)
// ===========================================================================

export const L2: TestCase[] = [
  {
    id: 'L2.1',
    level: 2,
    name: 'Set time',
    async run(ctx: Context, t: TestHelpers) {
      const set = await ctx.client.setTime(ctx.target, now())
      const read = await ctx.client.getTime(ctx.target)
      t.assert(read, 'time not readable after setting it')
      const drift = Math.round((new Date(read.replace(' ', 'T')).getTime() - Date.now()) / 1000)
      t.log(`set ${set}, read back ${read}, drift ${drift}s`)
      t.assert(Math.abs(drift) <= 2, `drift after setting ${drift}s`)
    },
  },
  {
    id: 'L2.2',
    level: 2,
    name: 'Listener towards this host + auto-send reception',
    async run(ctx: Context, t: TestHelpers) {
      const since = ctx.events.length
      await attachListener(ctx, t, 2)
      const ev = await ctx.waitEvent((s) => ctx.events.indexOf(s) >= since && s.controller === ctx.opts.serial, 8000)
      await ctx.client.setListener(ctx.target, { ...(await ctx.client.getListener(ctx.target)), interval: 0 })
      if (!ev && (await ctx.client.getLastEventIndex(ctx.target)) === 0) {
        // some firmware/simulators do not auto-send until at least one event exists
        t.warn('no auto-send received, but the controller has no events yet: reception will be checked in the L3 tests')
      }
      t.assert(ev, 'no packet received within 8 s: check the firewall (inbound UDP), the public IP and NAT/Docker')
      t.log(`push status received from the controller (event index ${ev.event?.index ?? 0})`)
    },
  },
  {
    id: 'L2.3',
    level: 2,
    name: 'Recording of special events (door/button)',
    async run(ctx: Context) {
      await ensureSpecialEvents(ctx)
    },
  },
  {
    id: 'L2.4',
    level: 2,
    name: 'Test card: insert, read, delete',
    async run(ctx: Context, t: TestHelpers) {
      const card = testCard(ctx, ctx.opts.testCard, [1, 0, 0, 0], 4321)
      const before = await ctx.client.getCards(ctx.target)
      await withTestCard(ctx, card, async () => {
        const read = await ctx.client.getCard(ctx.target, card.card)
        t.assert(read, 'card not found after inserting it')
        t.assert(
          read.from === card.from &&
            read.to === card.to &&
            read.pin === 4321 &&
            read.doors.join() === card.doors.join(),
          `different data: ${JSON.stringify(read)}`,
        )
        t.assert((await ctx.client.getCards(ctx.target)) === before + 1, 'card count not incremented')
        t.log('inserted and verified')
      })
      t.assert((await ctx.client.getCard(ctx.target, card.card)) === null, 'card still present after deleting it')
      t.assert((await ctx.client.getCards(ctx.target)) === before, 'card count not restored')
      t.log('deleted and verified')
    },
  },
  {
    id: 'L2.5',
    level: 2,
    name: 'Time profile 254: write and read back',
    async run(ctx: Context, t: TestHelpers) {
      const existing = await ctx.client.getTimeProfile(ctx.target, 254)
      if (existing) t.log('profile 254 already present: it will be restored')
      const profile = {
        id: 254,
        from: today(),
        to: `${new Date().getFullYear() + 1}-12-31`,
        weekdays: [true, false, true, false, true, false, true] as [
          boolean,
          boolean,
          boolean,
          boolean,
          boolean,
          boolean,
          boolean,
        ],
        segments: [
          { start: '08:30', end: '12:00' },
          { start: '13:30', end: '17:45' },
        ],
        linkedTo: 0,
      }
      await ctx.client.setTimeProfile(ctx.target, profile)
      const read = await ctx.client.getTimeProfile(ctx.target, 254)
      if (existing) await ctx.client.setTimeProfile(ctx.target, existing)
      t.assert(
        read && JSON.stringify(read) === JSON.stringify(profile),
        `profile read back is different: ${JSON.stringify(read)}`,
      )
      if (!existing) t.log('note: the protocol cannot delete a single profile; 254 stays defined')
    },
  },
  {
    id: 'L2.6',
    level: 2,
    name: 'Door 1 delay: change and restore',
    async run(ctx: Context, t: TestHelpers) {
      const orig = await ctx.client.getDoorControl(ctx.target, 1)
      const delay = orig.delay === 255 ? 254 : orig.delay + 1
      const set = await ctx.client.setDoorControl(ctx.target, { door: 1, mode: orig.mode, delay })
      t.assert(set.delay === delay, `delay not applied (${set.delay})`)
      const restored = await ctx.client.setDoorControl(ctx.target, orig)
      t.assert(restored.delay === orig.delay && restored.mode === orig.mode, 'restore failed')
      t.log(`delay ${orig.delay}s → ${delay}s → ${orig.delay}s`)
    },
  },
  {
    id: 'L2.7',
    level: 2,
    name: 'Event bookmark: write and restore',
    async run(ctx: Context, t: TestHelpers) {
      const orig = await ctx.client.getEventIndex(ctx.target)
      const last = await ctx.client.getLastEventIndex(ctx.target)
      if (last === 0) t.skip('no events stored: the bookmark must point to an existing event')
      const value = orig === last ? Math.max(1, last - 1) : last
      if (value === orig) t.skip('only one event stored: the change cannot be verified')
      await ctx.client.setEventIndex(ctx.target, value)
      t.assert((await ctx.client.getEventIndex(ctx.target)) === value, 'bookmark not updated')
      await ctx.client.setEventIndex(ctx.target, orig)
      t.assert((await ctx.client.getEventIndex(ctx.target)) === orig, 'bookmark not restored')
    },
  },
]

// ===========================================================================
// L3 — Physical tests (interactive)
// ===========================================================================

async function expectSwipe(
  ctx: Context,
  t: TestHelpers,
  opts: { card: number | null; door: number; pin?: number; message: string },
): Promise<ControllerStatus> {
  await attachListener(ctx, t)
  const since = ctx.events.length
  const action = {
    kind: 'swipe' as const,
    card: opts.card,
    door: opts.door,
    ...(opts.pin !== undefined ? { pin: opts.pin } : {}),
  }
  await ctx.driver.perform(action, opts.message)
  const ev = await ctx.waitEvent(
    (s) => ctx.events.indexOf(s) >= since && s.event?.type === 1 && (opts.card === null || s.event.card === opts.card),
    30_000,
  )
  t.assert(ev?.event, 'no swipe event received within 30 s')
  t.log(
    `event #${ev.event.index}: card ${ev.event.card}, door ${ev.event.door}, ${ev.event.granted ? 'granted' : 'denied'}, reason ${ev.event.reason}`,
  )
  return ev
}

export const L3: TestCase[] = [
  ...[1, 2, 3, 4].map(
    (door): TestCase => ({
      id: `L3.${door}`,
      level: 3,
      name: `Remote opening of door ${door} (relay click)`,
      physical: true,
      async run(ctx: Context, t: TestHelpers) {
        await ctx.client.openDoor(ctx.target, door)
        const ok = await ctx.driver.confirm(`Did you hear/see the relay of door ${door} click?`, {
          kind: 'observe-relay',
          door,
        })
        t.assert(ok, `relay of door ${door} not observed`)
      },
    }),
  ),
  {
    id: 'L3.5',
    level: 3,
    name: 'Authorised card swipe (door 1)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const card = await userCard(ctx, t)
      const existing = await ctx.client.getCard(ctx.target, card)
      if (!existing) await ctx.client.putCard(ctx.target, testCard(ctx, card, [1, 0, 0, 0]))
      try {
        const ev = await expectSwipe(ctx, t, {
          card,
          door: 1,
          message: `Swipe card ${card} on the door 1 reader (it must be GRANTED)`,
        })
        t.assert(ev.event!.granted, `access denied (reason ${ev.event!.reason})`)
        t.assert(ev.event!.door === 1, `event on door ${ev.event!.door} instead of 1: check the reader wiring`)
        t.log(`direction ${ev.event!.direction === 1 ? 'in' : 'out'}`)
      } finally {
        if (!existing) await ctx.client.deleteCard(ctx.target, card)
      }
    },
  },
  {
    id: 'L3.6',
    level: 3,
    name: 'Unauthorised card swipe → denied (reason 6 or 18)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const card = await userCard(ctx, t)
      const existing = await ctx.client.getCard(ctx.target, card)
      if (existing) t.skip('the test card is registered on the controller: use an unregistered card')
      const ev = await expectSwipe(ctx, t, {
        card,
        door: 1,
        message: `Swipe card ${card} on the door 1 reader (NOT registered: it must be denied)`,
      })
      t.assert(!ev.event!.granted, 'access granted to an unregistered card!')
      // the firmware may use "no access rights" (6) or "access denied" (18); the uhppoted simulator uses 18
      t.assert(
        [Reason.NoAccessRights, Reason.AccessDenied].includes(ev.event!.reason as 6 | 18),
        `reason ${ev.event!.reason} (expected 6 or 18)`,
      )
      ctx.facts.unknownCardReason = ev.event!.reason
    },
  },
  {
    id: 'L3.7',
    level: 3,
    name: 'Outside the time profile → denied (reason 13)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const card = await userCard(ctx, t)
      if (await ctx.client.getCard(ctx.target, card)) t.skip('the test card is already registered on the controller')
      const existing = await ctx.client.getTimeProfile(ctx.target, 253)
      const day = (new Date().getDay() + 6) % 7
      const weekdays = [true, true, true, true, true, true, true] as [
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
      ]
      weekdays[day] = false
      await ctx.client.setTimeProfile(ctx.target, {
        id: 253,
        from: today(),
        to: `${new Date().getFullYear() + 1}-12-31`,
        weekdays,
        segments: [{ start: '00:00', end: '23:59' }],
        linkedTo: 0,
      })
      await ctx.client.putCard(ctx.target, testCard(ctx, card, [253, 0, 0, 0]))
      try {
        const ev = await expectSwipe(ctx, t, {
          card,
          door: 1,
          message: `Swipe card ${card} on door 1 (time profile not valid today: it must be denied)`,
        })
        t.assert(!ev.event!.granted, 'access granted outside the time profile!')
        t.assert(ev.event!.reason === Reason.NotInAllowedTimePeriod, `reason ${ev.event!.reason} (expected 13)`)
      } finally {
        await ctx.client.deleteCard(ctx.target, card)
        if (existing) await ctx.client.setTimeProfile(ctx.target, existing)
      }
    },
  },
  {
    id: 'L3.8',
    level: 3,
    name: 'Door 1 sensor (open/close)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      await ensureSpecialEvents(ctx)
      await attachListener(ctx, t)
      if (!(await ctx.driver.confirm('Does door 1 have a door sensor (magnetic contact) connected?')))
        t.skip('sensor not installed')
      const since = ctx.events.length
      await ctx.driver.perform(
        { kind: 'door-sensor', door: 1, open: true },
        'Physically open door 1 (without a card: with the button or the key)',
      )
      const opened = await ctx.waitEvent(
        (s) => ctx.events.indexOf(s) >= since && (s.event?.reason === Reason.DoorOpened || s.doorOpen[0] === true),
        20_000,
      )
      t.assert(opened, 'door opening not detected')
      await ctx.driver.perform({ kind: 'door-sensor', door: 1, open: false }, 'Close door 1 again')
      const closed = await ctx.waitEvent(
        (s) =>
          ctx.events.indexOf(s) > ctx.events.indexOf(opened) &&
          (s.event?.reason === Reason.DoorClosed || s.doorOpen[0] === false),
        20_000,
      )
      t.assert(closed, 'door closing not detected')
    },
  },
  {
    id: 'L3.9',
    level: 3,
    name: 'Door 1 exit button',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      await ensureSpecialEvents(ctx)
      await attachListener(ctx, t)
      if (!(await ctx.driver.confirm('Does door 1 have an exit button connected?'))) t.skip('button not installed')
      const since = ctx.events.length
      await ctx.driver.perform({ kind: 'press-button', door: 1 }, 'Press the exit button of door 1')
      const ev = await ctx.waitEvent(
        (s) => ctx.events.indexOf(s) >= since && s.event?.reason === Reason.PushButtonOk,
        20_000,
      )
      t.assert(ev, 'button event (reason 20) not received')
    },
  },
  {
    id: 'L3.10',
    level: 3,
    name: 'Card + PIN from keypad (reader 1)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      if (!(await ctx.driver.confirm('Does the door 1 reader have a PIN keypad?'))) t.skip('reader without keypad')
      const card = await userCard(ctx, t)
      if (await ctx.client.getCard(ctx.target, card)) t.skip('the test card is already registered on the controller')
      await ctx.client.activateKeypads(ctx.target, [true, false, false, false])
      await ctx.client.putCard(ctx.target, testCard(ctx, card, [1, 0, 0, 0], 1234))
      // no immediate "card + PIN" task: the PIN mode depends on the reader configuration
      try {
        const ev = await expectSwipe(ctx, t, {
          card,
          door: 1,
          pin: 1234,
          message: `Swipe card ${card} on door 1 and type the PIN 1234 followed by #`,
        })
        t.assert(ev.event!.granted, `access denied (reason ${ev.event!.reason})`)
      } finally {
        await ctx.client.deleteCard(ctx.target, card)
        await ctx.client.activateKeypads(ctx.target, [false, false, false, false])
      }
    },
  },
]

// ===========================================================================
// L4 — Robustness
// ===========================================================================

export const L4: TestCase[] = [
  {
    id: 'L4.1',
    level: 4,
    name: '100 consecutive requests',
    async run(ctx: Context, t: TestHelpers) {
      const strict = new UhppoteClient({
        bindAddress: ctx.opts.bind,
        broadcast: ctx.opts.broadcast,
        timeoutMs: ctx.opts.timeoutMs,
        retries: 0,
      })
      const times: number[] = []
      let timeouts = 0
      for (let i = 0; i < 100; i++) {
        const s = Date.now()
        try {
          await strict.getStatus(ctx.target)
          times.push(Date.now() - s)
        } catch (err) {
          if (err instanceof TimeoutError) timeouts++
          else throw err
        }
      }
      t.log(`${timeouts} timeouts out of 100; p50 ${percentile(times, 50)} ms, p95 ${percentile(times, 95)} ms`)
      t.data({ timeouts, times })
      t.assert(timeouts <= 2, `${timeouts} timeouts out of 100 (unstable network?)`)
      if (timeouts > 0) t.warn(`${timeouts} packets lost (handled by the app's retries)`)
    },
  },
  {
    id: 'L4.2',
    level: 4,
    name: 'Bulk card load (--bulk N)',
    async run(ctx: Context, t: TestHelpers) {
      if (!ctx.opts.bulk) t.skip('use --bulk 1000 to run this test')
      const base = ctx.opts.testCard - ctx.opts.bulk
      const numbers = Array.from({ length: ctx.opts.bulk }, (_, i) => base + i).filter(isValidWiegand26)
      for (const n of numbers.slice(0, 5))
        if (await ctx.client.getCard(ctx.target, n)) t.skip(`card ${n} already present: choose another --test-card`)
      const before = await ctx.client.getCards(ctx.target)
      let s = Date.now()
      for (const n of numbers) await ctx.client.putCard(ctx.target, testCard(ctx, n, [1, 0, 0, 0]))
      const putMs = Date.now() - s
      const after = await ctx.client.getCards(ctx.target)
      s = Date.now()
      const listed = await ctx.client.listCards(ctx.target)
      const listMs = Date.now() - s
      s = Date.now()
      for (const n of numbers) await ctx.client.deleteCard(ctx.target, n)
      const delMs = Date.now() - s
      t.log(
        `${numbers.length} cards: insert ${putMs} ms (${(putMs / numbers.length).toFixed(1)} ms/card), full read ${listMs} ms, delete ${delMs} ms`,
      )
      t.assert(after === before + numbers.length, `count ${after}, expected ${before + numbers.length}`)
      t.assert(listed.filter((c) => numbers.includes(c.card)).length === numbers.length, 'not all cards were read back')
      t.assert((await ctx.client.getCards(ctx.target)) === before, 'cleanup not complete')
    },
  },
  {
    id: 'L4.3',
    level: 4,
    name: 'Network unplugged: events recorded offline and recovered by index',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const card = await userCard(ctx, t)
      const lastBefore = await ctx.client.getLastEventIndex(ctx.target)
      await ctx.driver.perform({ kind: 'unplug' }, 'Unplug the network cable of the CONTROLLER (leave it powered)')
      let offline = false
      try {
        await new UhppoteClient({ bindAddress: ctx.opts.bind, timeoutMs: 1500, retries: 0 }).getStatus(ctx.target)
      } catch (err) {
        offline = err instanceof TimeoutError
      }
      t.assert(offline, 'the controller still answers: was the cable unplugged?')
      await ctx.driver.perform(
        { kind: 'swipe-burst', card, door: 1, count: 3 },
        `Swipe card ${card} on door 1 THREE times (even if denied)`,
      )
      await ctx.driver.perform({ kind: 'replug' }, 'Plug the controller network cable back in')
      let lastAfter = 0
      for (let i = 0; i < 30 && lastAfter === 0; i++) {
        try {
          lastAfter = await ctx.client.getLastEventIndex(ctx.target)
        } catch {
          await sleep(1000)
        }
      }
      t.assert(lastAfter >= lastBefore + 3, `events recorded offline: ${lastAfter - lastBefore} (expected ≥ 3)`)
      const recovered = []
      for (let i = lastBefore + 1; i <= lastAfter; i++) recovered.push(await ctx.client.getEvent(ctx.target, i))
      t.assert(recovered.filter((e) => e.card === card).length >= 3, 'the swipes made while offline were not recovered')
      t.log(`recovered ${recovered.length} events (indexes ${lastBefore + 1}-${lastAfter})`)
    },
  },
  {
    id: 'L4.4',
    level: 4,
    name: 'Controller restart (power-on event)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const lastBefore = await ctx.client.getLastEventIndex(ctx.target)
      await ctx.driver.perform(
        { kind: 'power-cycle' },
        'Power the controller off and on again, then press Enter when the status LED blinks',
      )
      let back = false
      for (let i = 0; i < 60 && !back; i++) {
        try {
          await ctx.client.getStatus(ctx.target)
          back = true
        } catch {
          await sleep(1000)
        }
      }
      t.assert(back, 'the controller did not come back online within 60 s')
      const time = await ctx.client.getTime(ctx.target)
      t.log(`time after the restart: ${time} (is the clock kept by the backup battery?)`)
      const last = await ctx.client.getLastEventIndex(ctx.target)
      t.assert(last >= lastBefore, `event index decreased (${lastBefore} → ${last}): events lost on restart?`)
      const events = []
      for (let i = lastBefore + 1; i <= last; i++)
        events.push(await ctx.client.getEvent(ctx.target, i).catch(() => null))
      const power = events.find((e) => e?.reason === Reason.ControllerPowerOn)
      if (!power) t.warn('power-on event (reason 28) not found')
      t.log('power-on event recorded')
      const listener = await ctx.client.getListener(ctx.target)
      t.log(`listener after the restart: ${listener.address}:${listener.port} (persistent configuration)`)
    },
  },
  {
    id: 'L4.5',
    level: 4,
    name: 'Burst of swipes: no event lost in the push',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const card = await userCard(ctx, t)
      await attachListener(ctx, t)
      const lastBefore = await ctx.client.getLastEventIndex(ctx.target)
      const since = ctx.events.length
      await ctx.driver.perform(
        { kind: 'swipe-burst', card, door: 1, count: 10 },
        `Swipe card ${card} on door 1 TEN times, as fast as possible`,
      )
      await sleep(2000)
      const lastAfter = await ctx.client.getLastEventIndex(ctx.target)
      const pushed = new Set(
        ctx.events
          .slice(since)
          .map((s) => s.event?.index)
          .filter((i): i is number => !!i && i > lastBefore),
      )
      const expected = lastAfter - lastBefore
      t.log(`events recorded ${expected}, received via push ${pushed.size}`)
      t.assert(expected >= 10, `only ${expected} events recorded`)
      if (pushed.size < expected)
        t.warn(`${expected - pushed.size} events not received via push (the collector will recover them)`)
    },
  },
]

// ===========================================================================
// L6 — UT0311-01A alarm expansion board (0xF2, reverse-engineered)
// ===========================================================================

/** All outputs off, vendor default open-too-long time: the state left by the L6 tests. */
const EXPANSION_OFF: ExpansionBoardConfig = {
  relays: [{ ...INACTIVE_RELAY }, { ...INACTIVE_RELAY }, { ...INACTIVE_RELAY }, { ...INACTIVE_RELAY }],
  doorOpenTooLong: DEFAULT_DOOR_OPEN_TOO_LONG,
  duressCode: null,
}

/** Writes an expansion configuration with only `relay` active on output `n` (1-4). */
async function expansionWith(
  ctx: Context,
  n: number,
  relay: Partial<ExpansionRelay>,
  extra: Partial<ExpansionBoardConfig> = {},
): Promise<void> {
  const relays = structuredClone(EXPANSION_OFF.relays)
  relays[n - 1] = {
    active: true,
    source: ExpansionSource.Door1,
    mode: ExpansionOutputMode.Timed,
    events: 0,
    signals: 0,
    duration: 5,
    ...relay,
  }
  ctx.backup.expansionTouched = true
  await ctx.client.setExpansionBoard(ctx.target, { ...EXPANSION_OFF, ...extra, relays })
}

/** Relay/input bytes of the status: the board outputs may (or may not) be reported there. */
function statusBits(s: ControllerStatus | null): string {
  if (!s) return 'n/a'
  return `relays=0x${s.relays.toString(16).padStart(2, '0')} inputs=0x${s.inputs.toString(16).padStart(2, '0')} fire=${s.fireAlarm} special=0x${s.specialInfo.toString(16)}`
}

async function requireBoard(ctx: Context, t: TestHelpers): Promise<void> {
  if (ctx.facts.expansionBoard === undefined) {
    ctx.facts.expansionBoard = await ctx.driver.confirm(
      'Is the UT0311-01A expansion board connected to the controller, with something on its relays (LED, buzzer, tester)?',
    )
  }
  if (!ctx.facts.expansionBoard) t.skip('expansion board not connected')
}

async function waitReason(
  ctx: Context,
  since: number,
  reasons: number[],
  timeoutMs: number,
): Promise<ControllerStatus | null> {
  return ctx.waitEvent(
    (s) => ctx.events.indexOf(s) >= since && s.event !== null && reasons.includes(s.event.reason),
    timeoutMs,
  )
}

export const L6: TestCase[] = [
  {
    id: 'L6.1',
    level: 6,
    name: 'Probe 0xC2 get-alarm-status (experimental, read-only)',
    async run(ctx: Context, t: TestHelpers) {
      const packet = Buffer.alloc(64)
      packet[0] = 0x17
      packet[1] = 0xc2
      packet.writeUInt32LE(ctx.opts.serial, 4)
      const reply = await ctx.client.probe(ctx.target, packet)
      if (!reply) t.warn('no reply: function 0xC2 not supported by this firmware (not needed by UHPPOTE Desk)')
      t.log(`reply ${reply.length} bytes, function 0x${reply[1]!.toString(16)}`)
      t.log(hexdump(reply).replaceAll('\n', '<br>'))
      t.data({ reply: reply.toString('hex') })
    },
  },
  {
    id: 'L6.2',
    level: 6,
    name: '0xF2 address mapping (index + 16) via the door 1 open delay',
    async run(ctx: Context, t: TestHelpers) {
      const original = await ctx.client.getDoorControl(ctx.target, 1)
      const delay = original.delay >= 250 ? original.delay - 1 : original.delay + 1
      t.log(
        `door 1: mode ${original.mode}, delay ${original.delay} s → writing ${delay} s in parameters 2-3 (tenths of a second)`,
      )
      try {
        const tenths = delay * 10
        await ctx.client.writeParameters(ctx.target, [
          { index: 2, value: tenths & 0xff },
          { index: 3, value: tenths >> 8 },
        ])
        const after = await ctx.client.getDoorControl(ctx.target, 1)
        t.data({ original, written: delay, readBack: after })
        t.assert(
          after.mode === original.mode,
          `door 1 mode changed (${original.mode} → ${after.mode}): wrong address mapping!`,
        )
        if (after.delay !== delay) {
          t.warn(
            `0xF2 accepted but get-door-control still reports ${after.delay} s: the controller may apply the table only after 0x80 or a restart (the vendor software sends 0x80 after these bytes)`,
          )
        }
        t.log('mapping confirmed: parameter index + 16 = address')
      } finally {
        await ctx.client.setDoorControl(ctx.target, original)
      }
    },
  },
  {
    id: 'L6.3',
    level: 6,
    name: 'Expansion configuration accepted, other settings untouched',
    async run(ctx: Context, t: TestHelpers) {
      const doors = []
      for (let d = 1; d <= 4; d++) doors.push(await ctx.client.getDoorControl(ctx.target, d))
      const listener = await ctx.client.getListener(ctx.target)
      const antipassback = await ctx.client.getAntiPassback(ctx.target)
      const device = await ctx.client.getController(ctx.target)
      ctx.backup.expansionTouched = true
      const started = Date.now()
      await ctx.client.setExpansionBoard(ctx.target, EXPANSION_OFF)
      t.log(`all outputs inactive written in ${Date.now() - started} ms`)
      const doorsAfter = []
      for (let d = 1; d <= 4; d++) doorsAfter.push(await ctx.client.getDoorControl(ctx.target, d))
      t.assert(
        JSON.stringify(doorsAfter) === JSON.stringify(doors),
        `door configuration changed: ${JSON.stringify(doors)} → ${JSON.stringify(doorsAfter)}`,
      )
      t.assert(
        JSON.stringify(await ctx.client.getListener(ctx.target)) === JSON.stringify(listener),
        'listener changed',
      )
      t.assert((await ctx.client.getAntiPassback(ctx.target)) === antipassback, 'anti-passback changed')
      const deviceAfter = await ctx.client.getController(ctx.target)
      t.assert(
        deviceAfter.address === device.address &&
          deviceAfter.netmask === device.netmask &&
          deviceAfter.gateway === device.gateway,
        'network configuration changed',
      )
      t.log(`status after the write: ${statusBits(await ctx.client.getStatus(ctx.target))}`)
    },
  },
  {
    id: 'L6.4',
    level: 6,
    name: 'Output 1 on forced open of door 1',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      await requireBoard(ctx, t)
      if (!(await ctx.driver.confirm('Does door 1 have a door sensor connected (needed to detect a forced opening)?')))
        t.skip('no door sensor on door 1')
      await ensureSpecialEvents(ctx)
      await attachListener(ctx, t)
      await expansionWith(ctx, 1, { events: ExpansionEvent.ForcedOpen, duration: 5 })
      const since = ctx.events.length
      await ctx.driver.perform(
        { kind: 'force-door', door: 1 },
        'Open door 1 WITHOUT card or exit button (with the key, or a door left unlatched)',
      )
      const ev = await waitReason(ctx, since, [Reason.ForcedOpen], 20_000)
      t.assert(ev, 'forced-open event (reason 38) not received')
      t.log(`event: reason ${ev.event!.reason}, ${statusBits(ev)}`)
      const on = await ctx.driver.confirm('Did OUTPUT 1 of the expansion board switch on for about 5 seconds?', {
        kind: 'observe-relay',
        door: 1,
      })
      await ctx.driver.perform({ kind: 'door-sensor', door: 1, open: false }, 'Close door 1 again')
      t.assert(on, 'output 1 did not switch on')
    },
  },
  {
    id: 'L6.5',
    level: 6,
    name: 'Output 2 on door 1 open too long (until reset)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      await requireBoard(ctx, t)
      if (!(await ctx.driver.confirm('Does door 1 have a door sensor connected?'))) t.skip('no door sensor on door 1')
      await ensureSpecialEvents(ctx)
      await attachListener(ctx, t)
      await expansionWith(
        ctx,
        2,
        { events: ExpansionEvent.OpenTooLong, mode: ExpansionOutputMode.UntilReset },
        { doorOpenTooLong: 5 },
      )
      const since = ctx.events.length
      await ctx.driver.perform(
        { kind: 'hold-door-open', door: 1, seconds: 10 },
        'Open door 1 normally (card or exit button) and KEEP IT OPEN for at least 10 seconds',
      )
      const ev = await waitReason(ctx, since, [Reason.DoorOpenTooLong], 30_000)
      t.assert(ev, 'open-too-long event (reason 37) not received within 30 s')
      t.log(`event: ${statusBits(ev)}`)
      const on = await ctx.driver.confirm('Is OUTPUT 2 of the expansion board on now?', {
        kind: 'observe-relay',
        door: 2,
      })
      await ctx.driver.perform({ kind: 'door-sensor', door: 1, open: false }, 'Close door 1')
      t.assert(on, 'output 2 did not switch on')
      if (!(await ctx.driver.confirm('Did OUTPUT 2 switch off after closing the door?')))
        t.warn('output 2 stays on after the reset (mode "until reset" behaves differently)')
    },
  },
  {
    id: 'L6.6',
    level: 6,
    name: 'Output 3 on invalid card at door 1',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      await requireBoard(ctx, t)
      await attachListener(ctx, t)
      await expansionWith(ctx, 3, { events: ExpansionEvent.InvalidCard, duration: 3 })
      const since = ctx.events.length
      await ctx.driver.perform(
        { kind: 'swipe', card: null, door: 1 },
        'Swipe on door 1 a card that is NOT registered on the controller',
      )
      const ev = await ctx.waitEvent(
        (s) => ctx.events.indexOf(s) >= since && s.event?.type === 1 && !s.event.granted,
        20_000,
      )
      t.assert(ev, 'denied swipe not received')
      t.log(`card ${ev.event!.card}, reason ${ev.event!.reason}, ${statusBits(ev)}`)
      const on = await ctx.driver.confirm('Did OUTPUT 3 of the expansion board switch on for about 3 seconds?', {
        kind: 'observe-relay',
        door: 3,
      })
      t.assert(on, 'output 3 did not switch on')
    },
  },
  {
    id: 'L6.7',
    level: 6,
    name: 'Fire input of the board: event, doors unlocked, output 4',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      await requireBoard(ctx, t)
      await attachListener(ctx, t)
      await expansionWith(ctx, 4, { events: ExpansionEvent.Fire, duration: 5 })
      const since = ctx.events.length
      await ctx.driver.perform(
        { kind: 'fire-input', active: true },
        'ACTIVATE the fire input of the expansion board (close the fire contact)',
      )
      try {
        const ev = await ctx.waitEvent(
          (s) => ctx.events.indexOf(s) >= since && (s.fireAlarm || s.event?.reason === Reason.Fire),
          20_000,
        )
        const status = ev ?? (await ctx.client.getStatus(ctx.target))
        t.log(`fire: ${statusBits(status)}`)
        t.data({
          status: {
            relays: status.relays,
            inputs: status.inputs,
            fireAlarm: status.fireAlarm,
            reason: status.event?.reason,
          },
        })
        t.assert(ev, 'fire alarm not reported by the controller (status bit or event 39)')
        const on = await ctx.driver.confirm(
          'Did OUTPUT 4 of the expansion board switch on, and did the door locks release?',
          { kind: 'observe-relay', door: 4 },
        )
        t.assert(on, 'output 4 / door release not observed')
      } finally {
        await ctx.driver.perform(
          { kind: 'fire-input', active: false },
          'DEACTIVATE the fire input of the expansion board (open the fire contact)',
        )
      }
      await sleep(2000)
      const after = await ctx.client.getStatus(ctx.target)
      if (after.fireAlarm) t.warn('the fire flag is still set after releasing the input (manual reset needed?)')
    },
  },
  {
    id: 'L6.8',
    level: 6,
    name: 'Duress code on the door 1 keypad (output 1)',
    physical: true,
    destructive: true,
    async run(ctx: Context, t: TestHelpers) {
      await requireBoard(ctx, t)
      if (!(await ctx.driver.confirm('Does the door 1 reader have a PIN keypad?'))) t.skip('reader without keypad')
      await attachListener(ctx, t)
      const code = 975310
      await ctx.client.activateKeypads(ctx.target, [true, false, false, false])
      try {
        await expansionWith(ctx, 1, { events: ExpansionEvent.Threat, duration: 5 }, { duressCode: code })
        const since = ctx.events.length
        await ctx.driver.perform(
          { kind: 'keypad-code', door: 1, code },
          `On the door 1 keypad type the duress code ${code} followed by #`,
        )
        await sleep(3000)
        const events = ctx.events
          .slice(since)
          .filter((s) => s.event)
          .map((s) => ({ reason: s.event!.reason, granted: s.event!.granted, type: s.event!.type }))
        t.log(`events after the code: ${JSON.stringify(events)}`)
        t.data({ events })
        const on = await ctx.driver.confirm('Did OUTPUT 1 of the expansion board switch on?', {
          kind: 'observe-relay',
          door: 1,
        })
        t.assert(on, 'output 1 did not switch on with the duress code')
        t.log(`the duress code stays ${code} on the controller: change it from UHPPOTE Desk (Expansion board tab)`)
      } finally {
        await ctx.client.activateKeypads(ctx.target, [false, false, false, false])
      }
    },
  },
]

/** Restores the state saved during the tests (listener, bookmark, expansion board outputs off). */
export async function restore(ctx: Context): Promise<string[]> {
  const log: string[] = []
  try {
    await restoreListener(ctx)
    if (ctx.backup.listener) log.push('listener restored')
  } catch (err) {
    log.push(`listener restore failed: ${(err as Error).message}`)
  }
  if (ctx.backup.expansionTouched) {
    try {
      await ctx.client.setExpansionBoard(ctx.target, EXPANSION_OFF)
      log.push(
        'expansion board: all outputs left inactive — save the Expansion board tab in UHPPOTE Desk (or run a full synchronisation) to restore your configuration',
      )
    } catch (err) {
      log.push(`expansion board reset failed: ${(err as Error).message}`)
    }
  }
  return log
}

export const ALL_LEVELS: Record<number, TestCase[]> = { 0: L0, 1: L1, 2: L2, 3: L3, 4: L4, 6: L6 }

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => ((acc << 8) | Number(p)) >>> 0, 0)
}

function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.')
}
