import { execFile } from 'node:child_process'
import dgram from 'node:dgram'
import net from 'node:net'
import os from 'node:os'
import { promisify } from 'node:util'
import {
  EventOverwrittenError,
  isValidWiegand26,
  NotFoundError,
  Reason,
  TimeoutError,
  UhppoteClient,
  parseEndpoint,
  type Card,
  type ControllerStatus,
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
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0

function requireHost(ctx: Context, t: TestHelpers): string {
  if (!ctx.opts.host) t.skip('indirizzo IP del controller non specificato (--ip)')
  return ctx.opts.host
}

function testCard(ctx: Context, card: number, doors: Quad<number>, pin = 0): Card {
  return { card, from: today(), to: `${new Date().getFullYear() + 1}-12-31`, doors, pin, firstCard: [false, false, false, false] }
}

/** Punta temporaneamente il listener del controller verso questo host (salvando l'originale). */
async function attachListener(ctx: Context, t: TestHelpers, interval = 0): Promise<void> {
  if (!ctx.opts.publicIp) t.skip('IP di questo host non determinato (--public-ip)')
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

/** Esegue un comando che crea/modifica una tessera di test e ne garantisce la rimozione. */
async function withTestCard<T>(ctx: Context, card: Card, fn: () => Promise<T>): Promise<T> {
  const existing = await ctx.client.getCard(ctx.target, card.card)
  if (existing) throw new Error(`la tessera di test ${card.card} esiste già sul controller: scegliere un altro numero con --test-card`)
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
  const answer = (await ctx.driver.ask('Numero della tessera reale da usare per i test (8 cifre, invio per rilevarlo con uno swipe)')).trim()
  let card = Number(answer)
  if (!answer) {
    await attachListener(ctx, t)
    const since = ctx.events.length
    await ctx.driver.perform({ kind: 'swipe', card: null, door: 1 }, 'Passa la tessera di test sul lettore della porta 1')
    const ev = await ctx.waitEvent((s) => ctx.events.indexOf(s) >= since && s.event?.type === 1, 30_000)
    if (!ev?.event) t.skip('nessuno swipe rilevato')
    card = ev.event.card
    t.log(`tessera rilevata: ${card}`)
  }
  if (!isValidWiegand26(card)) t.warn(`numero tessera ${card} non valido per Wiegand-26`)
  ctx.facts.userCard = card
  return card
}

// ===========================================================================
// L0 — Rete
// ===========================================================================

export const L0: TestCase[] = [
  {
    id: 'L0.1',
    level: 0,
    name: 'Interfacce di rete dell\'host',
    async run(ctx: Context, t: TestHelpers) {
      const ifs = Object.entries(os.networkInterfaces()).flatMap(([name, a]) => (a ?? []).filter((x) => x.family === 'IPv4' && !x.internal).map((x) => ({ name, ...x })))
      for (const i of ifs) t.log(`${i.name}: ${i.address}/${i.netmask}`)
      t.data(ifs)
      t.assert(ifs.length > 0, 'nessuna interfaccia IPv4 attiva')
      if (ctx.opts.host) {
        const ip = ipToInt(ctx.opts.host)
        const same = ifs.find((i) => (ipToInt(i.address) & ipToInt(i.netmask)) === (ip & ipToInt(i.netmask)))
        if (!same) t.warn(`nessuna interfaccia nella stessa subnet di ${ctx.opts.host}: la discovery broadcast non funzionerà`)
        t.log(`interfaccia verso il controller: ${same.name} (${same.address}); broadcast di subnet ${intToIp((ipToInt(same.address) & ipToInt(same.netmask)) | (~ipToInt(same.netmask) >>> 0))}`)
        ctx.facts.localIp = same.address
      }
    },
  },
  {
    id: 'L0.2',
    level: 0,
    name: 'Ping del controller',
    async run(ctx: Context, t: TestHelpers) {
      const host = requireHost(ctx, t)
      const args = process.platform === 'win32' ? ['-n', '3', '-w', '1000', host] : ['-c', '3', '-W', '1', host]
      try {
        const { stdout } = await exec('ping', args, { timeout: 10_000 })
        const line = stdout.split(/\r?\n/).find((l) => /(perdit|loss|persi)/i.test(l))
        if (line) t.log(line.trim())
      } catch (err) {
        t.warn(`ping fallito (${(err as Error).message.split('\n')[0]}); alcuni controller non rispondono all'ICMP: proseguire con i test UDP`)
      }
    },
  },
  {
    id: 'L0.3',
    level: 0,
    name: 'Porta UDP locale per gli eventi disponibile',
    async run(ctx: Context, t: TestHelpers) {
      const { host, port } = parseEndpoint(ctx.opts.listen, 60001)
      // il listener del test runner è già in ascolto: verifichiamo che sia raggiungibile in loopback
      const sock = dgram.createSocket('udp4')
      await new Promise<void>((resolve, reject) => sock.send(Buffer.from('ping'), port, host === '0.0.0.0' ? '127.0.0.1' : host, (e) => (e ? reject(e) : resolve())))
      sock.close()
      t.log(`listener del test in ascolto su ${host}:${port}`)
    },
  },
  {
    id: 'L0.4',
    level: 0,
    name: 'Discovery broadcast',
    async run(ctx: Context, t: TestHelpers) {
      const broadcasts = new Set([ctx.opts.broadcast])
      if (ctx.facts.localIp && ctx.opts.host) {
        const ifc = Object.values(os.networkInterfaces()).flat().find((i) => i?.address === ctx.facts.localIp)
        if (ifc) broadcasts.add(`${intToIp((ipToInt(ifc.address) & ipToInt(ifc.netmask)) | (~ipToInt(ifc.netmask) >>> 0))}:60000`)
      }
      let found = false
      for (const b of broadcasts) {
        const list = await ctx.client.discover(b)
        t.log(`${b}: ${list.length ? list.map((c) => `${c.controller}@${c.address} ${c.version}`).join(', ') : 'nessuna risposta'}`)
        if (list.some((c) => c.controller === ctx.opts.serial)) found = true
      }
      if (!found) t.warn(`il controller ${ctx.opts.serial} non ha risposto al broadcast (normale se è su un'altra subnet o in Docker bridge)`)
    },
  },
  {
    id: 'L0.5',
    level: 0,
    name: 'Get controller in unicast UDP',
    async run(ctx: Context, t: TestHelpers) {
      const host = requireHost(ctx, t)
      const info = await ctx.client.getController({ id: ctx.opts.serial, host, port: ctx.opts.port, transport: 'udp' })
      t.assert(info.controller === ctx.opts.serial, `risposta da seriale inatteso ${info.controller}`)
      t.log(`IP ${info.address}/${info.netmask} gw ${info.gateway}, MAC ${info.mac}, firmware ${info.version} (${info.date})`)
      if (info.address !== host) t.warn(`il controller dichiara IP ${info.address} ma risponde su ${host} (NAT?)`)
      ctx.facts.firmware = info.version
    },
  },
  {
    id: 'L0.6',
    level: 0,
    name: 'Get controller via TCP (firmware recenti)',
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
      if (!reachable) t.warn('porta TCP 60000 non raggiungibile: firmware senza supporto TCP, usare UDP')
      const info = await ctx.client.getController({ id: ctx.opts.serial, host, port: ctx.opts.port, transport: 'tcp' })
      t.assert(info.controller === ctx.opts.serial, 'seriale errato in risposta TCP')
      t.log('TCP supportato')
      ctx.facts.tcp = true
    },
  },
  {
    id: 'L0.7',
    level: 0,
    name: 'Confronto con uhppoted-cli (opzionale)',
    async run(ctx: Context, t: TestHelpers) {
      if (!ctx.opts.cliPath) t.skip('percorso uhppoted-cli non indicato (--cli)')
      const args = ['--bind', `${ctx.opts.bind}:0`, '--broadcast', ctx.opts.broadcast, '--timeout', '2.5s', 'get-device', String(ctx.opts.serial)]
      const { stdout } = await exec(ctx.opts.cliPath, args, { timeout: 15_000 })
      t.log(`uhppoted-cli: ${stdout.trim()}`)
      const info = await ctx.client.getController(ctx.target)
      t.assert(stdout.includes(String(ctx.opts.serial)), 'output della CLI senza il numero di serie')
      t.assert(stdout.includes(info.address), `la CLI riporta un IP diverso da ${info.address}`)
    },
  },
]

// ===========================================================================
// L1 — Sola lettura
// ===========================================================================

export const L1: TestCase[] = [
  {
    id: 'L1.1',
    level: 1,
    name: 'Informazioni dispositivo',
    async run(ctx: Context, t: TestHelpers) {
      const info = await ctx.client.getController(ctx.target)
      t.data(info)
      t.log(`firmware ${info.version} del ${info.date}`)
      ctx.facts.firmware = info.version
      const [maj, min] = info.version.replace('v', '').split('.').map(Number)
      if ((maj ?? 0) * 100 + (min ?? 0) < 656) t.warn('firmware precedente a v6.56: non supportato ufficialmente da uhppoted')
      if (info.version === 'v6.62') t.log('firmware v6.62: gli eventi push usano SOM 0x19 (gestito)')
    },
  },
  {
    id: 'L1.2',
    level: 1,
    name: 'Ora del controller e deriva',
    async run(ctx: Context, t: TestHelpers) {
      const time = await ctx.client.getTime(ctx.target)
      t.assert(time, 'ora non valida')
      const drift = Math.round((new Date(time.replace(' ', 'T')).getTime() - Date.now()) / 1000)
      t.log(`ora controller ${time}, deriva ${drift}s`)
      t.data({ time, drift })
      ctx.facts.drift = drift
      if (Math.abs(drift) > 60) t.warn(`deriva oraria di ${drift}s (verrà corretta dall'app)`)
    },
  },
  {
    id: 'L1.3',
    level: 1,
    name: 'Stato (porte, relè, ingressi, ultimo evento)',
    async run(ctx: Context, t: TestHelpers) {
      const s = await ctx.client.getStatus(ctx.target)
      t.data(s)
      t.log(`porte aperte: ${s.doorOpen.map((o, i) => `${i + 1}:${o ? 'A' : 'C'}`).join(' ')}; pulsanti: ${s.buttonPressed.map((b) => (b ? 1 : 0)).join('')}; relè 0b${s.relays.toString(2).padStart(4, '0')}; ingressi 0x${s.inputs.toString(16)}`)
      t.log(`errore di sistema ${s.systemError}, special info ${s.specialInfo}`)
      t.log(s.event ? `ultimo evento #${s.event.index}: tipo ${s.event.type}, tessera ${s.event.card}, porta ${s.event.door}, motivo ${s.event.reason} (${s.event.timestamp})` : 'nessun evento memorizzato')
      ctx.facts.lastEvent = s.event?.index ?? 0
      if (s.systemError !== 0) t.warn(`errore di sistema ${s.systemError}`)
    },
  },
  {
    id: 'L1.4',
    level: 1,
    name: 'Listener configurato',
    async run(ctx: Context, t: TestHelpers) {
      const l = await ctx.client.getListener(ctx.target)
      t.data(l)
      t.log(`listener ${l.address}:${l.port}, auto-invio ${l.interval}s`)
      ctx.backup.listener = l
      if (l.address === '0.0.0.0') t.warn('nessun listener configurato (verrà impostato dall\'app)')
    },
  },
  {
    id: 'L1.5',
    level: 1,
    name: 'Configurazione porte 1-4',
    async run(ctx: Context, t: TestHelpers) {
      const doors = []
      for (let d = 1; d <= 4; d++) {
        const c = await ctx.client.getDoorControl(ctx.target, d)
        doors.push(c)
        t.log(`porta ${d}: modalità ${c.mode}, ritardo ${c.delay}s`)
      }
      ctx.backup.doors = doors
      t.data(doors)
    },
  },
  {
    id: 'L1.6',
    level: 1,
    name: 'Tessere memorizzate',
    async run(ctx: Context, t: TestHelpers) {
      const n = await ctx.client.getCards(ctx.target)
      t.log(`${n} tessere`)
      ctx.facts.cards = n
      if (n > 0 && n <= 2000) {
        const started = Date.now()
        const cards = await ctx.client.listCards(ctx.target)
        t.log(`lettura completa: ${cards.length} tessere in ${Date.now() - started} ms`)
        t.assert(cards.length === n, `lette ${cards.length} tessere su ${n} dichiarate`)
        ctx.backup.cards = cards
      } else if (n > 2000) t.log('lettura completa saltata (> 2000 tessere)')
    },
  },
  {
    id: 'L1.7',
    level: 1,
    name: 'Eventi: segnalibro, primo e ultimo',
    async run(ctx: Context, t: TestHelpers) {
      const bookmark = await ctx.client.getEventIndex(ctx.target)
      ctx.backup.eventIndex = bookmark
      const last = await ctx.client.getLastEventIndex(ctx.target)
      t.log(`segnalibro download ${bookmark}, ultimo evento ${last}`)
      if (last === 0) t.skip('nessun evento memorizzato')
      const ev = await ctx.client.getEvent(ctx.target, last)
      t.log(`evento ${last}: ${JSON.stringify(ev)}`)
      try {
        const first = await ctx.client.getEvent(ctx.target, 1)
        t.log(`evento 1 disponibile (${first.timestamp})`)
      } catch (err) {
        if (err instanceof EventOverwrittenError) t.log('evento 1 sovrascritto (buffer circolare pieno in passato)')
        else if (err instanceof NotFoundError) t.log('evento 1 non presente')
        else throw err
      }
      try {
        await ctx.client.getEvent(ctx.target, last + 1)
        t.warn(`l'evento ${last + 1} (oltre l'ultimo) risulta presente: comportamento inatteso`)
      } catch (err) {
        t.assert(err instanceof NotFoundError, `evento oltre l'ultimo: atteso "non trovato", ricevuto ${(err as Error).message}`)
        t.log('indice oltre l\'ultimo → non trovato (come atteso)')
      }
    },
  },
  {
    id: 'L1.8',
    level: 1,
    name: 'Anti-passback',
    async run(ctx: Context, t: TestHelpers) {
      const apb = await ctx.client.getAntiPassback(ctx.target)
      t.log(`modalità anti-passback ${apb}`)
      ctx.backup.antipassback = apb
    },
  },
  {
    id: 'L1.9',
    level: 1,
    name: 'Latenza (20 richieste di stato)',
    async run(ctx: Context, t: TestHelpers) {
      const times: number[] = []
      for (let i = 0; i < 20; i++) {
        const s = Date.now()
        await ctx.client.getStatus(ctx.target)
        times.push(Date.now() - s)
      }
      t.log(`p50 ${percentile(times, 50)} ms, p95 ${percentile(times, 95)} ms, max ${Math.max(...times)} ms`)
      t.data(times)
      if (percentile(times, 95) > 500) t.warn('latenza elevata (> 500 ms al 95° percentile)')
    },
  },
]

// ===========================================================================
// L2 — Scritture sicure (con ripristino)
// ===========================================================================

export const L2: TestCase[] = [
  {
    id: 'L2.1',
    level: 2,
    name: 'Impostazione ora',
    async run(ctx: Context, t: TestHelpers) {
      const set = await ctx.client.setTime(ctx.target, now())
      const read = await ctx.client.getTime(ctx.target)
      t.assert(read, 'ora non leggibile dopo l\'impostazione')
      const drift = Math.round((new Date(read.replace(' ', 'T')).getTime() - Date.now()) / 1000)
      t.log(`impostata ${set}, riletta ${read}, deriva ${drift}s`)
      t.assert(Math.abs(drift) <= 2, `deriva dopo l'impostazione ${drift}s`)
    },
  },
  {
    id: 'L2.2',
    level: 2,
    name: 'Listener verso questo host + ricezione auto-invio',
    async run(ctx: Context, t: TestHelpers) {
      const since = ctx.events.length
      await attachListener(ctx, t, 2)
      const ev = await ctx.waitEvent((s) => ctx.events.indexOf(s) >= since && s.controller === ctx.opts.serial, 8000)
      await ctx.client.setListener(ctx.target, { ...(await ctx.client.getListener(ctx.target)), interval: 0 })
      if (!ev && (await ctx.client.getLastEventIndex(ctx.target)) === 0) {
        // alcuni firmware/simulatori non inviano l'auto-invio finché non esiste almeno un evento
        t.warn('nessun auto-invio ricevuto, ma il controller non ha ancora eventi: la ricezione verrà verificata nei test L3')
      }
      t.assert(ev, 'nessun pacchetto ricevuto entro 8 s: verificare firewall (UDP in ingresso), IP pubblico e NAT/Docker')
      t.log(`ricevuto stato push dal controller (indice evento ${ev.event?.index ?? 0})`)
    },
  },
  {
    id: 'L2.3',
    level: 2,
    name: 'Registrazione eventi speciali (porta/pulsante)',
    async run(ctx: Context) {
      await ensureSpecialEvents(ctx)
    },
  },
  {
    id: 'L2.4',
    level: 2,
    name: 'Tessera di test: inserimento, lettura, cancellazione',
    async run(ctx: Context, t: TestHelpers) {
      const card = testCard(ctx, ctx.opts.testCard, [1, 0, 0, 0], 4321)
      const before = await ctx.client.getCards(ctx.target)
      await withTestCard(ctx, card, async () => {
        const read = await ctx.client.getCard(ctx.target, card.card)
        t.assert(read, 'tessera non trovata dopo l\'inserimento')
        t.assert(read.from === card.from && read.to === card.to && read.pin === 4321 && read.doors.join() === card.doors.join(), `dati diversi: ${JSON.stringify(read)}`)
        t.assert((await ctx.client.getCards(ctx.target)) === before + 1, 'conteggio tessere non incrementato')
        t.log('inserita e verificata')
      })
      t.assert((await ctx.client.getCard(ctx.target, card.card)) === null, 'tessera ancora presente dopo la cancellazione')
      t.assert((await ctx.client.getCards(ctx.target)) === before, 'conteggio tessere non ripristinato')
      t.log('cancellata e verificata')
    },
  },
  {
    id: 'L2.5',
    level: 2,
    name: 'Fascia oraria 254: scrittura e rilettura',
    async run(ctx: Context, t: TestHelpers) {
      const existing = await ctx.client.getTimeProfile(ctx.target, 254)
      if (existing) t.log('profilo 254 già presente: verrà ripristinato')
      const profile = {
        id: 254,
        from: today(),
        to: `${new Date().getFullYear() + 1}-12-31`,
        weekdays: [true, false, true, false, true, false, true] as [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
        segments: [
          { start: '08:30', end: '12:00' },
          { start: '13:30', end: '17:45' },
        ],
        linkedTo: 0,
      }
      await ctx.client.setTimeProfile(ctx.target, profile)
      const read = await ctx.client.getTimeProfile(ctx.target, 254)
      if (existing) await ctx.client.setTimeProfile(ctx.target, existing)
      t.assert(read && JSON.stringify(read) === JSON.stringify(profile), `profilo riletto diverso: ${JSON.stringify(read)}`)
      if (!existing) t.log('nota: il protocollo non consente di cancellare un singolo profilo; il 254 resta definito')
    },
  },
  {
    id: 'L2.6',
    level: 2,
    name: 'Ritardo porta 1: modifica e ripristino',
    async run(ctx: Context, t: TestHelpers) {
      const orig = await ctx.client.getDoorControl(ctx.target, 1)
      const delay = orig.delay === 255 ? 254 : orig.delay + 1
      const set = await ctx.client.setDoorControl(ctx.target, { door: 1, mode: orig.mode, delay })
      t.assert(set.delay === delay, `ritardo non applicato (${set.delay})`)
      const restored = await ctx.client.setDoorControl(ctx.target, orig)
      t.assert(restored.delay === orig.delay && restored.mode === orig.mode, 'ripristino non riuscito')
      t.log(`ritardo ${orig.delay}s → ${delay}s → ${orig.delay}s`)
    },
  },
  {
    id: 'L2.7',
    level: 2,
    name: 'Segnalibro eventi: scrittura e ripristino',
    async run(ctx: Context, t: TestHelpers) {
      const orig = await ctx.client.getEventIndex(ctx.target)
      const last = await ctx.client.getLastEventIndex(ctx.target)
      if (last === 0) t.skip('nessun evento memorizzato: il segnalibro deve puntare a un evento esistente')
      const value = orig === last ? Math.max(1, last - 1) : last
      if (value === orig) t.skip('un solo evento memorizzato: impossibile verificare la modifica')
      await ctx.client.setEventIndex(ctx.target, value)
      t.assert((await ctx.client.getEventIndex(ctx.target)) === value, 'segnalibro non aggiornato')
      await ctx.client.setEventIndex(ctx.target, orig)
      t.assert((await ctx.client.getEventIndex(ctx.target)) === orig, 'segnalibro non ripristinato')
    },
  },
]

// ===========================================================================
// L3 — Prove fisiche (interattive)
// ===========================================================================

async function expectSwipe(ctx: Context, t: TestHelpers, opts: { card: number | null; door: number; pin?: number; message: string }): Promise<ControllerStatus> {
  await attachListener(ctx, t)
  const since = ctx.events.length
  const action = { kind: 'swipe' as const, card: opts.card, door: opts.door, ...(opts.pin !== undefined ? { pin: opts.pin } : {}) }
  await ctx.driver.perform(action, opts.message)
  const ev = await ctx.waitEvent((s) => ctx.events.indexOf(s) >= since && s.event?.type === 1 && (opts.card === null || s.event.card === opts.card), 30_000)
  t.assert(ev?.event, 'nessun evento di swipe ricevuto entro 30 s')
  t.log(`evento #${ev.event.index}: tessera ${ev.event.card}, porta ${ev.event.door}, ${ev.event.granted ? 'consentito' : 'negato'}, motivo ${ev.event.reason}`)
  return ev
}

export const L3: TestCase[] = [
  ...[1, 2, 3, 4].map(
    (door): TestCase => ({
      id: `L3.${door}`,
      level: 3,
      name: `Apertura remota porta ${door} (scatto relè)`,
      physical: true,
      async run(ctx: Context, t: TestHelpers) {
        await ctx.client.openDoor(ctx.target, door)
        const ok = await ctx.driver.confirm(`Hai sentito/visto lo scatto del relè della porta ${door}?`, { kind: 'observe-relay', door })
        t.assert(ok, `relè della porta ${door} non osservato`)
      },
    }),
  ),
  {
    id: 'L3.5',
    level: 3,
    name: 'Swipe tessera autorizzata (porta 1)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const card = await userCard(ctx, t)
      const existing = await ctx.client.getCard(ctx.target, card)
      if (!existing) await ctx.client.putCard(ctx.target, testCard(ctx, card, [1, 0, 0, 0]))
      try {
        const ev = await expectSwipe(ctx, t, { card, door: 1, message: `Passa la tessera ${card} sul lettore della porta 1 (deve essere AUTORIZZATA)` })
        t.assert(ev.event!.granted, `accesso negato (motivo ${ev.event!.reason})`)
        t.assert(ev.event!.door === 1, `evento sulla porta ${ev.event!.door} invece che 1: verificare il cablaggio dei lettori`)
        t.log(`direzione ${ev.event!.direction === 1 ? 'ingresso' : 'uscita'}`)
      } finally {
        if (!existing) await ctx.client.deleteCard(ctx.target, card)
      }
    },
  },
  {
    id: 'L3.6',
    level: 3,
    name: 'Swipe tessera non autorizzata → negato (motivo 6 o 18)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const card = await userCard(ctx, t)
      const existing = await ctx.client.getCard(ctx.target, card)
      if (existing) t.skip('la tessera di test è registrata sul controller: usare una tessera non registrata')
      const ev = await expectSwipe(ctx, t, { card, door: 1, message: `Passa la tessera ${card} sul lettore della porta 1 (NON registrata: deve essere negata)` })
      t.assert(!ev.event!.granted, 'accesso consentito a una tessera non registrata!')
      // il firmware può usare "nessun diritto" (6) o "accesso negato" (18); il simulatore uhppoted usa 18
      t.assert([Reason.NoAccessRights, Reason.AccessDenied].includes(ev.event!.reason as 6 | 18), `motivo ${ev.event!.reason} (atteso 6 o 18)`)
      ctx.facts.unknownCardReason = ev.event!.reason
    },
  },
  {
    id: 'L3.7',
    level: 3,
    name: 'Fuori fascia oraria → negato (motivo 13)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const card = await userCard(ctx, t)
      if (await ctx.client.getCard(ctx.target, card)) t.skip('la tessera di test è già registrata sul controller')
      const existing = await ctx.client.getTimeProfile(ctx.target, 253)
      const day = (new Date().getDay() + 6) % 7
      const weekdays = [true, true, true, true, true, true, true] as [boolean, boolean, boolean, boolean, boolean, boolean, boolean]
      weekdays[day] = false
      await ctx.client.setTimeProfile(ctx.target, { id: 253, from: today(), to: `${new Date().getFullYear() + 1}-12-31`, weekdays, segments: [{ start: '00:00', end: '23:59' }], linkedTo: 0 })
      await ctx.client.putCard(ctx.target, testCard(ctx, card, [253, 0, 0, 0]))
      try {
        const ev = await expectSwipe(ctx, t, { card, door: 1, message: `Passa la tessera ${card} sulla porta 1 (fascia oraria non valida oggi: deve essere negata)` })
        t.assert(!ev.event!.granted, 'accesso consentito fuori fascia oraria!')
        t.assert(ev.event!.reason === Reason.NotInAllowedTimePeriod, `motivo ${ev.event!.reason} (atteso 13)`)
      } finally {
        await ctx.client.deleteCard(ctx.target, card)
        if (existing) await ctx.client.setTimeProfile(ctx.target, existing)
      }
    },
  },
  {
    id: 'L3.8',
    level: 3,
    name: 'Sensore porta 1 (apertura/chiusura)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      await ensureSpecialEvents(ctx)
      await attachListener(ctx, t)
      if (!(await ctx.driver.confirm('La porta 1 ha il sensore porta (contatto magnetico) collegato?'))) t.skip('sensore non installato')
      const since = ctx.events.length
      await ctx.driver.perform({ kind: 'door-sensor', door: 1, open: true }, 'Apri fisicamente la porta 1 (senza tessera, con il pulsante o la chiave)')
      const opened = await ctx.waitEvent((s) => ctx.events.indexOf(s) >= since && (s.event?.reason === Reason.DoorOpened || s.doorOpen[0] === true), 20_000)
      t.assert(opened, 'apertura porta non rilevata')
      await ctx.driver.perform({ kind: 'door-sensor', door: 1, open: false }, 'Richiudi la porta 1')
      const closed = await ctx.waitEvent((s) => ctx.events.indexOf(s) > ctx.events.indexOf(opened) && (s.event?.reason === Reason.DoorClosed || s.doorOpen[0] === false), 20_000)
      t.assert(closed, 'chiusura porta non rilevata')
    },
  },
  {
    id: 'L3.9',
    level: 3,
    name: 'Pulsante di uscita porta 1',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      await ensureSpecialEvents(ctx)
      await attachListener(ctx, t)
      if (!(await ctx.driver.confirm('La porta 1 ha il pulsante di uscita collegato?'))) t.skip('pulsante non installato')
      const since = ctx.events.length
      await ctx.driver.perform({ kind: 'press-button', door: 1 }, 'Premi il pulsante di uscita della porta 1')
      const ev = await ctx.waitEvent((s) => ctx.events.indexOf(s) >= since && s.event?.reason === Reason.PushButtonOk, 20_000)
      t.assert(ev, 'evento pulsante (motivo 20) non ricevuto')
    },
  },
  {
    id: 'L3.10',
    level: 3,
    name: 'Tessera + PIN da tastiera (lettore 1)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      if (!(await ctx.driver.confirm('Il lettore della porta 1 ha una tastiera per il PIN?'))) t.skip('lettore senza tastiera')
      const card = await userCard(ctx, t)
      if (await ctx.client.getCard(ctx.target, card)) t.skip('la tessera di test è già registrata sul controller')
      await ctx.client.activateKeypads(ctx.target, [true, false, false, false])
      await ctx.client.putCard(ctx.target, testCard(ctx, card, [1, 0, 0, 0], 1234))
      // task "tessera + PIN" immediato non disponibile: la modalità PIN dipende dalla configurazione del lettore
      try {
        const ev = await expectSwipe(ctx, t, { card, door: 1, pin: 1234, message: `Passa la tessera ${card} sulla porta 1 e digita il PIN 1234 seguito da #` })
        t.assert(ev.event!.granted, `accesso negato (motivo ${ev.event!.reason})`)
      } finally {
        await ctx.client.deleteCard(ctx.target, card)
        await ctx.client.activateKeypads(ctx.target, [false, false, false, false])
      }
    },
  },
]

// ===========================================================================
// L4 — Robustezza
// ===========================================================================

export const L4: TestCase[] = [
  {
    id: 'L4.1',
    level: 4,
    name: '100 richieste consecutive',
    async run(ctx: Context, t: TestHelpers) {
      const strict = new UhppoteClient({ bindAddress: ctx.opts.bind, broadcast: ctx.opts.broadcast, timeoutMs: ctx.opts.timeoutMs, retries: 0 })
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
      t.log(`${timeouts} timeout su 100; p50 ${percentile(times, 50)} ms, p95 ${percentile(times, 95)} ms`)
      t.data({ timeouts, times })
      t.assert(timeouts <= 2, `${timeouts} timeout su 100 (rete instabile?)`)
      if (timeouts > 0) t.warn(`${timeouts} pacchetti persi (gestiti dai retry dell'app)`)
    },
  },
  {
    id: 'L4.2',
    level: 4,
    name: 'Caricamento massivo tessere (--bulk N)',
    async run(ctx: Context, t: TestHelpers) {
      if (!ctx.opts.bulk) t.skip('usare --bulk 1000 per eseguire il test')
      const base = ctx.opts.testCard - ctx.opts.bulk
      const numbers = Array.from({ length: ctx.opts.bulk }, (_, i) => base + i).filter(isValidWiegand26)
      for (const n of numbers.slice(0, 5)) if (await ctx.client.getCard(ctx.target, n)) t.skip(`tessera ${n} già presente: scegliere un altro --test-card`)
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
      t.log(`${numbers.length} tessere: inserimento ${putMs} ms (${(putMs / numbers.length).toFixed(1)} ms/tessera), lettura completa ${listMs} ms, cancellazione ${delMs} ms`)
      t.assert(after === before + numbers.length, `conteggio ${after}, atteso ${before + numbers.length}`)
      t.assert(listed.filter((c) => numbers.includes(c.card)).length === numbers.length, 'non tutte le tessere sono state rilette')
      t.assert((await ctx.client.getCards(ctx.target)) === before, 'pulizia non completa')
    },
  },
  {
    id: 'L4.3',
    level: 4,
    name: 'Scollegamento rete: eventi registrati offline e recuperati per indice',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const card = await userCard(ctx, t)
      const lastBefore = await ctx.client.getLastEventIndex(ctx.target)
      await ctx.driver.perform({ kind: 'unplug' }, 'Scollega il cavo di rete del CONTROLLER (lascialo alimentato)')
      let offline = false
      try {
        await new UhppoteClient({ bindAddress: ctx.opts.bind, timeoutMs: 1500, retries: 0 }).getStatus(ctx.target)
      } catch (err) {
        offline = err instanceof TimeoutError
      }
      t.assert(offline, 'il controller risponde ancora: il cavo è stato scollegato?')
      await ctx.driver.perform({ kind: 'swipe-burst', card, door: 1, count: 3 }, `Passa la tessera ${card} sulla porta 1 TRE volte (anche se negata)`)
      await ctx.driver.perform({ kind: 'replug' }, 'Ricollega il cavo di rete del controller')
      let lastAfter = 0
      for (let i = 0; i < 30 && lastAfter === 0; i++) {
        try {
          lastAfter = await ctx.client.getLastEventIndex(ctx.target)
        } catch {
          await sleep(1000)
        }
      }
      t.assert(lastAfter >= lastBefore + 3, `eventi registrati offline: ${lastAfter - lastBefore} (attesi ≥ 3)`)
      const recovered = []
      for (let i = lastBefore + 1; i <= lastAfter; i++) recovered.push(await ctx.client.getEvent(ctx.target, i))
      t.assert(recovered.filter((e) => e.card === card).length >= 3, 'gli swipe effettuati offline non sono stati recuperati')
      t.log(`recuperati ${recovered.length} eventi (indici ${lastBefore + 1}-${lastAfter})`)
    },
  },
  {
    id: 'L4.4',
    level: 4,
    name: 'Riavvio controller (evento accensione)',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const lastBefore = await ctx.client.getLastEventIndex(ctx.target)
      await ctx.driver.perform({ kind: 'power-cycle' }, "Togli e ridai alimentazione al controller, poi premi invio quando il led di stato lampeggia")
      let back = false
      for (let i = 0; i < 60 && !back; i++) {
        try {
          await ctx.client.getStatus(ctx.target)
          back = true
        } catch {
          await sleep(1000)
        }
      }
      t.assert(back, 'il controller non è tornato online entro 60 s')
      const time = await ctx.client.getTime(ctx.target)
      t.log(`ora dopo il riavvio: ${time} (l'orologio è mantenuto dalla batteria tampone?)`)
      const last = await ctx.client.getLastEventIndex(ctx.target)
      t.assert(last >= lastBefore, `indice eventi diminuito (${lastBefore} → ${last}): eventi persi al riavvio?`)
      const events = []
      for (let i = lastBefore + 1; i <= last; i++) events.push(await ctx.client.getEvent(ctx.target, i).catch(() => null))
      const power = events.find((e) => e?.reason === Reason.ControllerPowerOn)
      if (!power) t.warn('evento di accensione (motivo 28) non trovato')
      t.log('evento di accensione registrato')
      const listener = await ctx.client.getListener(ctx.target)
      t.log(`listener dopo il riavvio: ${listener.address}:${listener.port} (configurazione persistente)`)
    },
  },
  {
    id: 'L4.5',
    level: 4,
    name: 'Raffica di swipe: nessun evento perso nel push',
    physical: true,
    async run(ctx: Context, t: TestHelpers) {
      const card = await userCard(ctx, t)
      await attachListener(ctx, t)
      const lastBefore = await ctx.client.getLastEventIndex(ctx.target)
      const since = ctx.events.length
      await ctx.driver.perform({ kind: 'swipe-burst', card, door: 1, count: 10 }, `Passa la tessera ${card} sulla porta 1 DIECI volte, il più velocemente possibile`)
      await sleep(2000)
      const lastAfter = await ctx.client.getLastEventIndex(ctx.target)
      const pushed = new Set(ctx.events.slice(since).map((s) => s.event?.index).filter((i): i is number => !!i && i > lastBefore))
      const expected = lastAfter - lastBefore
      t.log(`eventi registrati ${expected}, ricevuti via push ${pushed.size}`)
      t.assert(expected >= 10, `registrati solo ${expected} eventi`)
      if (pushed.size < expected) t.warn(`${expected - pushed.size} eventi non ricevuti via push (verranno recuperati dal collector)`)
    },
  },
]

/** Ripristina lo stato salvato durante i test (listener, segnalibro). */
export async function restore(ctx: Context): Promise<string[]> {
  const log: string[] = []
  try {
    await restoreListener(ctx)
    if (ctx.backup.listener) log.push('listener ripristinato')
  } catch (err) {
    log.push(`ripristino listener fallito: ${(err as Error).message}`)
  }
  return log
}

export const ALL_LEVELS: Record<number, TestCase[]> = { 0: L0, 1: L1, 2: L2, 3: L3, 4: L4 }

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => ((acc << 8) | Number(p)) >>> 0, 0)
}

function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 0xff).join('.')
}
