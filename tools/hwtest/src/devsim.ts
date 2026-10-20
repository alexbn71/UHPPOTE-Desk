/**
 * Development simulator: starts an emulated UT0311-L04 controller (FakeController) on UDP+TCP,
 * to use the app without hardware. Keyboard commands simulate swipes and doors.
 *
 *   npm run sim -- [--host 0.0.0.0] [--port 60000] [--serial 405419896] [--address 192.168.1.50] [--auto 10]
 *
 * In the Docker image: docker exec -it <container> node hwtest/devsim.js
 * --address is the IP the simulated controller reports (discovery, get-device): by default the host
 * address on the subnet of UHPPOTE_BROADCAST, otherwise the first LAN address.
 *
 * Like a real controller, the simulator keeps its memory (cards, time profiles, settings, events) across
 * restarts: it is saved to --state (default <DATA_DIR>/devsim-<serial>.json, i.e. /data in the Docker image).
 * --fresh starts with an empty memory.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { parseArgs } from 'node:util'
import { FakeController, type FakeControllerState } from '@uhppote-desk/protocol/testing'

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '0.0.0.0' },
    port: { type: 'string', default: '60000' },
    serial: { type: 'string', default: '405419896' },
    auto: { type: 'string', default: '0' },
    address: { type: 'string' },
    state: { type: 'string' },
    fresh: { type: 'boolean', default: false },
  },
})

const toInt = (ip: string) => ip.split('.').reduce((n, x) => ((n << 8) | Number(x)) >>> 0, 0)
const fromInt = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')

/** LAN address to report: the interface whose broadcast matches UHPPOTE_BROADCAST, otherwise the first physical one. */
function detectAddress(): { address: string; netmask: string } | null {
  const candidates = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/^(lo|docker|veth|br-|virbr|tun|tap|wg)/.test(name))
    .flatMap(([, list]) => (list ?? []).filter((i) => i.family === 'IPv4' && !i.internal))
  const broadcast = process.env.UHPPOTE_BROADCAST?.split(':')[0]
  const byBroadcast = broadcast
    ? candidates.find((i) => fromInt((toInt(i.address) | ~toInt(i.netmask)) >>> 0) === broadcast)
    : undefined
  const pick = byBroadcast ?? candidates[0]
  return pick ? { address: pick.address, netmask: pick.netmask } : null
}

const lan = values.address ? { address: values.address, netmask: '255.255.255.0' } : detectAddress()
const gateway = lan ? fromInt(((toInt(lan.address) & toInt(lan.netmask)) | 1) >>> 0) : undefined
const fake = new FakeController({
  id: Number(values.serial),
  host: values.host,
  port: Number(values.port),
  tcp: true,
  ...(lan && { address: lan.address, netmask: lan.netmask, gateway }),
})
const statePath = path.resolve(
  values.state ?? path.join(process.env.DATA_DIR ?? 'data', `devsim-${values.serial}.json`),
)
if (!values.fresh && fs.existsSync(statePath)) {
  fake.restore(JSON.parse(fs.readFileSync(statePath, 'utf8')) as FakeControllerState)
  console.log(`Memory restored from ${statePath}: ${fake.cards.length} cards, ${fake.lastEventIndex} events`)
}

// saved whenever it changes: the process can be killed at any time (e.g. when the container restarts)
let saved = ''
function save(): void {
  const json = JSON.stringify(fake.snapshot())
  if (json === saved) return
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(`${statePath}.tmp`, json)
    fs.renameSync(`${statePath}.tmp`, statePath)
    saved = json
  } catch (err) {
    console.log(`cannot save the memory to ${statePath}: ${(err as Error).message}`)
  }
}
setInterval(save, 1000)

const ep = await fake.start()
console.log(`Simulated controller ${fake.id} listening on ${ep.host}:${ep.port} (UDP+TCP), reported IP ${fake.address}`)
console.log(
  `Commands: s <card> [door] = swipe   |  o <door> / c <door> = door sensor open/closed  |  b <door> = exit button`,
)
console.log(`          l = list cards   |  e = last events   |  off / on = unplug/replug network   |  q = quit`)
console.log(`Memory saved to ${statePath}`)

const auto = Number(values.auto)
if (auto > 0) {
  setInterval(() => {
    const cards = fake.cards
    // 80% a registered card; otherwise one of five unregistered (but valid Wiegand-26) cards, 10065001-10065005
    const card =
      cards.length && Math.random() < 0.8
        ? cards[Math.floor(Math.random() * cards.length)]!.card
        : 10065001 + Math.floor(Math.random() * 5)
    const e = fake.swipe(card, 1 + Math.floor(Math.random() * 4), Math.random() < 0.5 ? 1 : 2)
    console.log(`[auto] swipe ${card} door ${e.door}: ${e.granted ? 'granted' : 'denied'} (reason ${e.reason})`)
  }, auto * 1000)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const [cmd, a, b] = line.trim().split(/\s+/)
  try {
    switch (cmd) {
      case 's': {
        const e = fake.swipe(Number(a), Number(b ?? 1))
        console.log(`event #${e.index}: ${e.granted ? 'GRANTED' : 'DENIED'} (reason ${e.reason})`)
        break
      }
      case 'o':
      case 'c':
        fake.setDoorSensor(Number(a ?? 1), cmd === 'o')
        break
      case 'b':
        fake.pressButton(Number(a ?? 1))
        break
      case 'l':
        console.table(fake.cards)
        break
      case 'e':
        console.table(fake.events.slice(-10))
        break
      case 'off':
        fake.offline = true
        console.log('controller unplugged from the network (it keeps recording events)')
        break
      case 'on':
        fake.offline = false
        console.log('controller plugged back in')
        break
      case 'q':
        save()
        void fake.stop().then(() => process.exit(0))
        break
      default:
        if (cmd) console.log('unknown command')
    }
  } catch (err) {
    console.log(`error: ${(err as Error).message}`)
  }
})
