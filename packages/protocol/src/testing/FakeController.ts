import dgram from 'node:dgram'
import net from 'node:net'
import { Reader, Writer } from '../codec/bytes.js'
import {
  Direction,
  EventType,
  FunctionCode as F,
  MAGIC,
  PACKET_SIZE,
  Reason,
} from '../codec/constants.js'
import { DELETED_CARD, validatePacket, type Card, type ControllerEvent, type Quad, type Task, type TimeProfile, type Weekdays } from '../codec/messages.js'

export interface FakeControllerOptions {
  id: number
  /** Indirizzo di bind (default 127.0.0.1). */
  host?: string
  /** Porta UDP/TCP (default 0 = casuale; usare 60000 per emulare un controller reale). */
  port?: number
  /** Abilita anche il server TCP sulla stessa porta. */
  tcp?: boolean
  /** Capacità del buffer eventi (default 100000). */
  eventCapacity?: number
  /** Quanti eventi scartare quando il buffer è pieno (default 2048, come il firmware). */
  eventDiscard?: number
  address?: string
  netmask?: string
  gateway?: string
  mac?: string
  /** Versione firmware BCD, es. 0x0892 → v8.92 */
  version?: number
  /** Usa SOM 0x19 per gli eventi del listener (firmware v6.62). */
  v662Events?: boolean
}

interface StoredEvent extends ControllerEvent {}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Emulatore in-process di un controller UT0311-L04.
 * Implementa tutti i comandi del protocollo con uno stato in memoria, la logica di base delle autorizzazioni
 * (tessera, validità, permesso porta, profilo orario, modalità porta) e l'invio degli eventi al listener.
 * Offre inoltre "manopole" per i test: latenza, perdita pacchetti, silenzio totale.
 */
export class FakeController {
  readonly id: number
  private udp: dgram.Socket | null = null
  private tcpServer: net.Server | null = null
  private autosendTimer: NodeJS.Timeout | null = null

  // --- stato del controller ---------------------------------------------------
  address: string
  netmask: string
  gateway: string
  mac: string
  version: number
  readonly releaseDate = '2018-11-05'
  /** Offset dell'orologio del controller rispetto a quello dell'host (ms). */
  clockOffsetMs = 0
  listener = { address: '0.0.0.0', port: 0, interval: 0 }
  doors: Quad<{ mode: number; delay: number }> = [
    { mode: 3, delay: 5 },
    { mode: 3, delay: 5 },
    { mode: 3, delay: 5 },
    { mode: 3, delay: 5 },
  ]
  passcodes: Quad<number[]> = [[], [], [], []]
  doorOpen: Quad<boolean> = [false, false, false, false]
  buttonPressed: Quad<boolean> = [false, false, false, false]
  relays = 0
  inputs = 0
  systemError = 0
  specialInfo = 0
  sequenceNo = 0
  /** Slot tessere: null = record cancellato (tombstone). */
  cardSlots: (Card | null)[] = []
  profiles = new Map<number, TimeProfile>()
  tasks: Task[] = []
  tasksActive: Task[] = []
  events: StoredEvent[] = []
  /** Indice del primo evento ancora memorizzato. */
  private firstEventIndex = 1
  private nextEventIndex = 1
  eventIndexBookmark = 0
  recordSpecialEvents = false
  pcControl = false
  interlock = 0
  keypads: Quad<boolean> = [false, false, false, false]
  antipassback = 0
  firstCard = new Map<number, { start: string; end: string; activeMode: number; inactiveMode: number; weekdays: Weekdays }>()

  // --- manopole per i test ----------------------------------------------------
  /** Latenza di risposta (ms). */
  latencyMs = 0
  /** Probabilità [0..1] di ignorare una richiesta. */
  dropRate = 0
  /** Se true non risponde a nulla (simula controller spento/scollegato). */
  offline = false
  /** Function code per cui il controller risponde ok = false (simula un rifiuto). */
  readonly failOps = new Set<number>()
  /** Contatore richieste ricevute per function code. */
  readonly requestCount = new Map<number, number>()

  private readonly host: string
  private readonly port: number
  private readonly withTcp: boolean
  private readonly capacity: number
  private readonly discard: number
  private readonly v662Events: boolean

  constructor(opts: FakeControllerOptions) {
    this.id = opts.id
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port ?? 0
    this.withTcp = opts.tcp ?? false
    this.capacity = opts.eventCapacity ?? 100_000
    this.discard = opts.eventDiscard ?? 2048
    this.address = opts.address ?? '192.168.1.100'
    this.netmask = opts.netmask ?? '255.255.255.0'
    this.gateway = opts.gateway ?? '192.168.1.1'
    this.mac = opts.mac ?? '00:12:23:34:45:56'
    this.version = opts.version ?? 0x0892
    this.v662Events = opts.v662Events ?? false
  }

  // ---------------------------------------------------------------------------
  // Ciclo di vita
  // ---------------------------------------------------------------------------

  async start(): Promise<{ host: string; port: number }> {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.udp = sock
    sock.on('message', (msg, rinfo) => {
      void this.handle(msg).then((reply) => {
        if (reply && this.udp) this.udp.send(reply, rinfo.port, rinfo.address)
      })
    })
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject)
      sock.bind({ address: this.host, port: this.port }, () => {
        sock.off('error', reject)
        resolve()
      })
    })
    const port = sock.address().port

    if (this.withTcp) {
      this.tcpServer = net.createServer((conn) => {
        let pending = Buffer.alloc(0)
        conn.on('data', (chunk: Buffer) => {
          pending = Buffer.concat([pending, chunk])
          while (pending.length >= PACKET_SIZE) {
            const msg = Buffer.from(pending.subarray(0, PACKET_SIZE))
            pending = pending.subarray(PACKET_SIZE)
            void this.handle(msg).then((reply) => {
              if (reply && !conn.destroyed) conn.write(reply)
            })
          }
        })
        conn.on('error', () => undefined)
      })
      await new Promise<void>((resolve, reject) => {
        this.tcpServer!.once('error', reject)
        this.tcpServer!.listen({ host: this.host, port }, () => resolve())
      })
    }
    this.event(EventType.Alarm, false, 0, 1, 0, Reason.ControllerPowerOn, false)
    return { host: this.host, port }
  }

  get endpoint(): { host: string; port: number } {
    return { host: this.host, port: this.udp?.address().port ?? this.port }
  }

  async stop(): Promise<void> {
    if (this.autosendTimer) clearInterval(this.autosendTimer)
    this.autosendTimer = null
    const udp = this.udp
    this.udp = null
    if (udp) await new Promise<void>((r) => udp.close(() => r()))
    const tcp = this.tcpServer
    this.tcpServer = null
    if (tcp) await new Promise<void>((r) => tcp.close(() => r()))
  }

  // ---------------------------------------------------------------------------
  // Stato derivato
  // ---------------------------------------------------------------------------

  now(): Date {
    return new Date(Date.now() + this.clockOffsetMs)
  }

  get cards(): Card[] {
    return this.cardSlots.filter((c): c is Card => c !== null)
  }

  get lastEventIndex(): number {
    return this.nextEventIndex - 1
  }

  private findCardSlot(card: number): number {
    return this.cardSlots.findIndex((c) => c?.card === card)
  }

  // ---------------------------------------------------------------------------
  // Azioni fisiche simulate
  // ---------------------------------------------------------------------------

  /** Simula il passaggio di una tessera sul lettore della porta. Restituisce l'evento generato. */
  swipe(card: number, door: number, direction: number = Direction.In, pin?: number): ControllerEvent {
    const reason = this.authorise(card, door, pin)
    const granted = reason === Reason.Swipe
    if (granted) this.pulseRelay(door)
    return this.event(EventType.Swipe, granted, door, direction, card, reason)
  }

  /** Simula apertura/chiusura del sensore porta. */
  setDoorSensor(door: number, open: boolean): void {
    this.doorOpen[door - 1] = open
    if (this.recordSpecialEvents) {
      this.event(EventType.Door, true, door, Direction.In, 0, open ? Reason.DoorOpened : Reason.DoorClosed)
    } else {
      this.pushStatus()
    }
  }

  /** Simula la pressione del pulsante di uscita. */
  pressButton(door: number): void {
    const mode = this.doors[door - 1]!.mode
    const ok = mode !== 2
    if (ok) this.pulseRelay(door)
    if (this.recordSpecialEvents) {
      this.event(EventType.Door, ok, door, Direction.Out, 0, ok ? Reason.PushButtonOk : Reason.PushButtonDoorLocked)
    }
  }

  private pulseRelay(door: number): void {
    const bit = 1 << (door - 1)
    this.relays |= bit
    const delay = this.doors[door - 1]!.delay
    setTimeout(() => {
      if (this.doors[door - 1]!.mode !== 1) this.relays &= ~bit
    }, Math.min(delay, 2) * 1000).unref()
  }

  private authorise(cardNo: number, door: number, pin?: number): number {
    const mode = this.doors[door - 1]!.mode
    if (mode === 2) return Reason.DoorNormallyClosed
    const idx = this.findCardSlot(cardNo)
    if (idx < 0) return Reason.NoAccessRights
    const card = this.cardSlots[idx]!
    const today = fmtDate(this.now())
    if ((card.from && today < card.from) || (card.to && today > card.to)) return Reason.NoAccessRights
    const perm = card.doors[door - 1]!
    if (perm === 0) return Reason.NoAccessRights
    if (perm >= 2 && !this.inProfile(perm, this.now(), new Set())) return Reason.NotInAllowedTimePeriod
    if (this.keypads[door - 1] && card.pin !== 0 && pin !== undefined && pin !== card.pin) return Reason.IncorrectPassword
    return Reason.Swipe
  }

  private inProfile(id: number, at: Date, seen: Set<number>): boolean {
    if (seen.has(id)) return false
    seen.add(id)
    const p = this.profiles.get(id)
    if (!p) return false
    const day = fmtDate(at)
    const hhmm = `${pad(at.getHours())}:${pad(at.getMinutes())}`
    const weekday = (at.getDay() + 6) % 7 // lun = 0
    const validDate = (!p.from || day >= p.from) && (!p.to || day <= p.to)
    if (validDate && p.weekdays[weekday] && p.segments.some((s) => hhmm >= s.start && hhmm <= s.end)) return true
    return p.linkedTo ? this.inProfile(p.linkedTo, at, seen) : false
  }

  /** Registra un evento e lo invia al listener. */
  event(type: number, granted: boolean, door: number, direction: number, card: number, reason: number, push = true): ControllerEvent {
    const ev: StoredEvent = {
      index: this.nextEventIndex++,
      type,
      granted,
      door,
      direction,
      card,
      timestamp: fmtDateTime(this.now()),
      reason,
    }
    this.events.push(ev)
    if (this.events.length > this.capacity) {
      const drop = Math.min(this.discard, this.events.length)
      this.events.splice(0, drop)
      this.firstEventIndex = this.events[0]?.index ?? this.nextEventIndex
    }
    if (push) this.pushStatus()
    return ev
  }

  /** Invia lo status corrente al listener configurato (se presente). */
  pushStatus(): void {
    if (!this.udp || this.offline) return
    const { address, port } = this.listener
    if (address === '0.0.0.0' || port === 0) return
    const pkt = this.statusPacket(F.GetStatus)
    if (this.v662Events) pkt[0] = 0x19
    this.udp.send(pkt, port, address)
  }

  private configureAutosend(): void {
    if (this.autosendTimer) clearInterval(this.autosendTimer)
    this.autosendTimer = null
    if (this.listener.interval > 0) {
      this.autosendTimer = setInterval(() => this.pushStatus(), this.listener.interval * 1000)
      this.autosendTimer.unref()
    }
  }

  // ---------------------------------------------------------------------------
  // Gestione richieste
  // ---------------------------------------------------------------------------

  private async handle(msg: Buffer): Promise<Buffer | null> {
    if (this.offline) return null
    const r = validatePacket(msg)
    if (!r) return null
    const target = r.controller
    if (target !== 0 && target !== this.id) return null
    if (target === 0 && r.functionCode !== F.GetController) return null
    if (this.dropRate > 0 && Math.random() < this.dropRate) return null
    this.requestCount.set(r.functionCode, (this.requestCount.get(r.functionCode) ?? 0) + 1)
    if (this.latencyMs > 0) await new Promise((res) => setTimeout(res, this.latencyMs))
    return this.dispatch(r)
  }

  private reply(fc: number): Writer {
    return new Writer(fc, this.id)
  }

  private ok(fc: number, ok = true): Buffer {
    return this.reply(fc).bool(8, ok && !this.failOps.has(fc)).buf
  }

  private magicOk(r: Reader, offset = 8): boolean {
    return r.u32(offset) === MAGIC
  }

  private statusPacket(fc: number): Buffer {
    const w = this.reply(fc)
    const last = this.events.at(-1)
    if (last) this.writeEvent(w, last)
    this.doorOpen.forEach((v, i) => w.bool(28 + i, v))
    this.buttonPressed.forEach((v, i) => w.bool(32 + i, v))
    w.u8(36, this.systemError)
    const now = this.now()
    const bcd = (n: number) => ((Math.floor(n / 10) % 10) << 4) | n % 10
    w.buf[37] = bcd(now.getHours())
    w.buf[38] = bcd(now.getMinutes())
    w.buf[39] = bcd(now.getSeconds())
    w.u32(40, this.sequenceNo++ >>> 0)
    w.u8(48, this.specialInfo)
    w.u8(49, this.relays)
    w.u8(50, this.inputs)
    w.buf[51] = bcd(now.getFullYear() % 100)
    w.buf[52] = bcd(now.getMonth() + 1)
    w.buf[53] = bcd(now.getDate())
    return w.buf
  }

  private writeEvent(w: Writer, e: ControllerEvent): void {
    w.u32(8, e.index).u8(12, e.type).bool(13, e.granted).u8(14, e.door).u8(15, e.direction).u32(16, e.card)
    if (e.timestamp) w.datetime(20, e.timestamp)
    w.u8(27, e.reason)
  }

  private writeCard(w: Writer, c: Card): Writer {
    w.u32(8, c.card)
    if (c.card !== DELETED_CARD) {
      w.date(12, c.from).date(16, c.to)
      c.doors.forEach((p, i) => w.u8(20 + i, p))
      w.pin24(24, c.pin)
      w.u8(27, c.firstCard.reduce((acc, on, i) => (on ? acc | (1 << i) : acc), 0))
    }
    return w
  }

  private readCard(r: Reader): Card {
    const fc = r.u8(27)
    return {
      card: r.u32(8),
      from: r.date(12),
      to: r.date(16),
      doors: [r.u8(20), r.u8(21), r.u8(22), r.u8(23)],
      pin: r.pin24(24),
      firstCard: [0, 1, 2, 3].map((i) => (fc & (1 << i)) !== 0) as Quad<boolean>,
    }
  }

  private weekdays(r: Reader, offset: number): Weekdays {
    return [0, 1, 2, 3, 4, 5, 6].map((i) => r.bool(offset + i)) as Weekdays
  }

  private dispatch(r: Reader): Buffer | null {
    const fc = r.functionCode
    switch (fc) {
      case F.GetController: {
        const w = this.reply(fc).ipv4(8, this.address).ipv4(12, this.netmask).ipv4(16, this.gateway)
        this.mac.split(':').forEach((h, i) => (w.buf[20 + i] = parseInt(h, 16)))
        w.buf.writeUInt16BE(this.version, 26)
        return w.date(28, this.releaseDate).buf
      }
      case F.SetIPv4:
        if (this.magicOk(r, 20)) {
          this.address = r.ipv4(8)
          this.netmask = r.ipv4(12)
          this.gateway = r.ipv4(16)
        }
        return null // il controller reale non risponde
      case F.GetTime:
        return this.reply(fc).datetime(8, fmtDateTime(this.now())).buf
      case F.SetTime: {
        const dt = r.datetime(8)
        if (dt) this.clockOffsetMs = new Date(dt.replace(' ', 'T')).getTime() - Date.now()
        return this.reply(fc).datetime(8, fmtDateTime(this.now())).buf
      }
      case F.GetListener:
        return this.reply(fc).ipv4(8, this.listener.address).u16(12, this.listener.port).u8(14, this.listener.interval).buf
      case F.SetListener:
        this.listener = { address: r.ipv4(8), port: r.u16(12), interval: r.u8(14) }
        this.configureAutosend()
        return this.ok(fc)
      case F.GetDoorControl:
      case F.SetDoorControl: {
        const d = r.u8(8)
        if (d < 1 || d > 4) return this.reply(fc).buf
        if (fc === F.SetDoorControl) {
          this.doors[d - 1] = { mode: r.u8(9), delay: r.u8(10) }
          if (r.u8(9) === 1) this.relays |= 1 << (d - 1)
          else this.relays &= ~(1 << (d - 1))
        }
        return this.reply(fc).u8(8, d).u8(9, this.doors[d - 1]!.mode).u8(10, this.doors[d - 1]!.delay).buf
      }
      case F.SetDoorPasscodes: {
        const d = r.u8(8)
        if (d < 1 || d > 4) return this.ok(fc, false)
        this.passcodes[d - 1] = [r.u32(12), r.u32(16), r.u32(20), r.u32(24)].filter((p) => p > 0)
        return this.ok(fc)
      }
      case F.OpenDoor: {
        const d = r.u8(8)
        if (d < 1 || d > 4) return this.ok(fc, false)
        this.pulseRelay(d)
        this.event(EventType.Door, true, d, Direction.In, 0, Reason.RemoteOpenDoor)
        return this.ok(fc)
      }
      case F.GetStatus:
        return this.statusPacket(fc)
      case F.GetCards:
        return this.reply(fc).u32(8, this.cards.length).buf
      case F.GetCard: {
        const idx = this.findCardSlot(r.u32(8))
        return idx < 0 ? this.reply(fc).buf : this.writeCard(this.reply(fc), this.cardSlots[idx]!).buf
      }
      case F.GetCardAtIndex: {
        const index = r.u32(8)
        if (index < 1 || index > this.cardSlots.length) return this.reply(fc).buf
        const c = this.cardSlots[index - 1]
        return c === null
          ? this.reply(fc).u32(8, DELETED_CARD).buf
          : this.writeCard(this.reply(fc), c!).buf
      }
      case F.PutCard: {
        const card = this.readCard(r)
        if (card.card === 0 || card.card === DELETED_CARD) return this.ok(fc, false)
        const idx = this.findCardSlot(card.card)
        if (idx >= 0) this.cardSlots[idx] = card
        else this.cardSlots.push(card)
        return this.ok(fc)
      }
      case F.DeleteCard: {
        const idx = this.findCardSlot(r.u32(8))
        if (idx < 0) return this.ok(fc, false)
        this.cardSlots[idx] = null
        return this.ok(fc)
      }
      case F.DeleteAllCards:
        if (!this.magicOk(r)) return this.ok(fc, false)
        this.cardSlots = []
        return this.ok(fc)
      case F.GetEvent: {
        const index = r.u32(8)
        const w = this.reply(fc)
        if (this.events.length === 0) return w.buf
        if (index === 0) {
          this.writeEvent(w, this.events[0]!)
        } else if (index === 0xffffffff) {
          this.writeEvent(w, this.events.at(-1)!)
        } else if (index < this.firstEventIndex) {
          w.u32(8, index).u8(12, EventType.Overwritten)
        } else if (index <= this.lastEventIndex) {
          this.writeEvent(w, this.events[index - this.firstEventIndex]!)
        }
        return w.buf
      }
      case F.GetEventIndex:
        return this.reply(fc).u32(8, this.eventIndexBookmark).buf
      case F.SetEventIndex:
        if (!this.magicOk(r, 12)) return this.ok(fc, false)
        this.eventIndexBookmark = r.u32(8)
        return this.ok(fc)
      case F.RecordSpecialEvents:
        this.recordSpecialEvents = r.bool(8)
        return this.ok(fc)
      case F.GetTimeProfile: {
        const p = this.profiles.get(r.u8(8))
        const w = this.reply(fc)
        if (!p) return w.buf
        w.u8(8, p.id).date(9, p.from).date(13, p.to)
        p.weekdays.forEach((d, i) => w.bool(17 + i, d))
        p.segments.forEach((s, i) => w.hhmm(24 + 4 * i, s.start).hhmm(26 + 4 * i, s.end))
        return w.u8(36, p.linkedTo).buf
      }
      case F.SetTimeProfile: {
        const id = r.u8(8)
        if (id < 2 || id > 254) return this.ok(fc, false)
        const segments = [0, 1, 2]
          .map((i) => ({ start: r.hhmm(24 + 4 * i) ?? '00:00', end: r.hhmm(26 + 4 * i) ?? '00:00' }))
          .filter((s) => s.start !== '00:00' || s.end !== '00:00')
        this.profiles.set(id, {
          id,
          from: r.date(9),
          to: r.date(13),
          weekdays: this.weekdays(r, 17),
          segments,
          linkedTo: r.u8(36),
        })
        return this.ok(fc)
      }
      case F.ClearTimeProfiles:
        if (!this.magicOk(r)) return this.ok(fc, false)
        this.profiles.clear()
        return this.ok(fc)
      case F.AddTask:
        this.tasks.push({
          from: r.date(8) ?? '',
          to: r.date(12) ?? '',
          weekdays: this.weekdays(r, 16),
          start: r.hhmm(23) ?? '00:00',
          door: r.u8(25),
          task: r.u8(26),
          moreCards: r.u8(27),
        })
        return this.ok(fc)
      case F.RefreshTaskList:
        if (!this.magicOk(r)) return this.ok(fc, false)
        this.tasksActive = [...this.tasks]
        return this.ok(fc)
      case F.ClearTaskList:
        if (!this.magicOk(r)) return this.ok(fc, false)
        this.tasks = []
        return this.ok(fc)
      case F.SetPCControl:
        if (!this.magicOk(r)) return this.ok(fc, false)
        this.pcControl = r.bool(12)
        return this.ok(fc)
      case F.SetInterlock: {
        const v = r.u8(8)
        if (![0, 1, 2, 3, 4, 8].includes(v)) return this.ok(fc, false)
        this.interlock = v
        return this.ok(fc)
      }
      case F.ActivateKeypads:
        this.keypads = [r.bool(8), r.bool(9), r.bool(10), r.bool(11)]
        return this.ok(fc)
      case F.GetAntiPassback:
        return this.reply(fc).u8(8, this.antipassback).buf
      case F.SetAntiPassback: {
        const v = r.u8(8)
        if (v > 4) return this.ok(fc, false)
        this.antipassback = v
        return this.ok(fc)
      }
      case F.SetFirstCard: {
        const d = r.u8(8)
        if (d < 1 || d > 4) return this.ok(fc, false)
        this.firstCard.set(d, {
          start: r.hhmm(9) ?? '00:00',
          activeMode: r.u8(11),
          end: r.hhmm(12) ?? '00:00',
          inactiveMode: r.u8(14),
          weekdays: this.weekdays(r, 15),
        })
        return this.ok(fc)
      }
      case F.RestoreDefaultParameters:
        if (!this.magicOk(r)) return this.ok(fc, false)
        this.listener = { address: '0.0.0.0', port: 0, interval: 0 }
        this.configureAutosend()
        this.doors = [
          { mode: 3, delay: 5 },
          { mode: 3, delay: 5 },
          { mode: 3, delay: 5 },
          { mode: 3, delay: 5 },
        ]
        this.cardSlots = []
        this.events = []
        this.antipassback = 0
        this.passcodes = [[], [], [], []]
        return this.ok(fc)
      default:
        return null
    }
  }
}
