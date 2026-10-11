import { CodecError } from '../errors.js'
import { Reader, Writer, type DateString, type DateTimeString, type TimeString } from './bytes.js'
import {
  FunctionCode as F,
  INTERLOCK_VALUES,
  MAGIC,
  PACKET_SIZE,
  SOM,
  SOM_V662_EVENT,
  type AntiPassback,
  type DoorMode,
  type FirstCardMode,
  type Interlock,
  type TaskType,
} from './constants.js'

// ---------------------------------------------------------------------------
// Tipi di dominio del protocollo
// ---------------------------------------------------------------------------

export type Door = 1 | 2 | 3 | 4
/** Lun..Dom */
export type Weekdays = [boolean, boolean, boolean, boolean, boolean, boolean, boolean]
export type Quad<T> = [T, T, T, T]

export interface ControllerInfo {
  controller: number
  address: string
  netmask: string
  gateway: string
  mac: string
  version: string
  date: DateString | null
}

export interface ListenerConfig {
  address: string
  port: number
  /** Intervallo auto-send in secondi (0 = disattivato). */
  interval: number
}

export interface DoorControl {
  door: number
  mode: DoorMode | number
  /** Ritardo apertura in secondi (0-255). */
  delay: number
}

export interface ControllerEvent {
  index: number
  type: number
  granted: boolean
  door: number
  direction: number
  card: number
  timestamp: DateTimeString | null
  reason: number
}

export interface ControllerStatus {
  controller: number
  systemDate: DateString | null
  systemTime: string | null
  doorOpen: Quad<boolean>
  buttonPressed: Quad<boolean>
  /** Bitmask relè grezza (bit0..3 = porta 1..4, 1 = sbloccata). */
  relays: number
  relayUnlocked: Quad<boolean>
  /** Bitmask ingressi grezza. */
  inputs: number
  forceLock: boolean
  fireAlarm: boolean
  systemError: number
  specialInfo: number
  sequenceNo: number
  /** null se il controller non ha ancora eventi (indice 0). */
  event: ControllerEvent | null
}

/**
 * Permesso per porta: 0 = nessun accesso, 1 = sempre, 2..254 = ID profilo orario.
 */
export type DoorPermission = number

export interface Card {
  card: number
  from: DateString | null
  to: DateString | null
  doors: Quad<DoorPermission>
  /** 0 = nessun PIN */
  pin: number
  firstCard: Quad<boolean>
}

export interface TimeSegment {
  start: TimeString
  end: TimeString
}

export interface TimeProfile {
  id: number
  from: DateString | null
  to: DateString | null
  weekdays: Weekdays
  /** Fino a 3 segmenti; i segmenti 00:00-00:00 vengono omessi in decodifica. */
  segments: TimeSegment[]
  /** 0 = nessun profilo collegato */
  linkedTo: number
}

export interface Task {
  task: TaskType | number
  from: DateString
  to: DateString
  weekdays: Weekdays
  start: TimeString
  door: number
  /** Numero di tessere per il task "more cards". */
  moreCards: number
}

export interface FirstCardConfig {
  door: number
  start: TimeString
  end: TimeString
  activeMode: FirstCardMode | number
  inactiveMode: FirstCardMode | number
  weekdays: Weekdays
}

/** Numero tessera speciale: record cancellato. */
export const DELETED_CARD = 0xffffffff

// ---------------------------------------------------------------------------
// Validazione pacchetti
// ---------------------------------------------------------------------------

/** Verifica dimensione e SOM; restituisce null se il pacchetto non è un messaggio UHPPOTE valido. */
export function validatePacket(buf: Buffer): Reader | null {
  if (buf.length !== PACKET_SIZE) return null
  const som = buf[0]
  const fc = buf[1]
  if (som === SOM || (som === SOM_V662_EVENT && fc === F.GetStatus)) return new Reader(buf)
  return null
}

function reader(buf: Buffer, expected: number): Reader {
  const r = validatePacket(buf)
  if (!r) throw new CodecError('pacchetto non valido (dimensione o start-of-message)')
  if (r.functionCode !== expected) {
    throw new CodecError(
      `function code inatteso 0x${r.functionCode.toString(16)} (atteso 0x${expected.toString(16)})`,
    )
  }
  return r
}

function door(v: number): number {
  if (!Number.isInteger(v) || v < 1 || v > 4) throw new CodecError(`porta non valida: ${v} (1-4)`)
  return v
}

function weekdays(w: Writer, offset: number, days: Weekdays): void {
  days.forEach((d, i) => w.bool(offset + i, d))
}

function readWeekdays(r: Reader, offset: number): Weekdays {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => r.bool(offset + i)) as Weekdays
}

function quad<T>(f: (i: number) => T): Quad<T> {
  return [f(0), f(1), f(2), f(3)]
}

function cardNumber(v: number): number {
  if (!Number.isInteger(v) || v < 1 || v >= 0xffffffff) throw new CodecError(`numero tessera non valido: ${v}`)
  return v
}

function profileId(v: number, field = 'profilo'): number {
  if (!Number.isInteger(v) || v < 2 || v > 254) throw new CodecError(`${field}: ID non valido ${v} (2-254)`)
  return v
}

// ---------------------------------------------------------------------------
// Encoder delle richieste
// ---------------------------------------------------------------------------

export const encode = {
  getController(controller = 0): Buffer {
    return new Writer(F.GetController, controller).buf
  },

  setIPv4(controller: number, address: string, netmask: string, gateway: string): Buffer {
    return new Writer(F.SetIPv4, controller)
      .ipv4(8, address, 'indirizzo')
      .ipv4(12, netmask, 'netmask')
      .ipv4(16, gateway, 'gateway')
      .u32(20, MAGIC).buf
  },

  getTime(controller: number): Buffer {
    return new Writer(F.GetTime, controller).buf
  },

  setTime(controller: number, datetime: DateTimeString): Buffer {
    return new Writer(F.SetTime, controller).datetime(8, datetime).buf
  },

  getListener(controller: number): Buffer {
    return new Writer(F.GetListener, controller).buf
  },

  setListener(controller: number, listener: ListenerConfig): Buffer {
    return new Writer(F.SetListener, controller)
      .ipv4(8, listener.address, 'listener')
      .u16(12, listener.port, 'porta listener')
      .u8(14, listener.interval, 'intervallo auto-send').buf
  },

  getDoorControl(controller: number, d: number): Buffer {
    return new Writer(F.GetDoorControl, controller).u8(8, door(d)).buf
  },

  setDoorControl(controller: number, control: DoorControl): Buffer {
    if (![1, 2, 3].includes(control.mode)) throw new CodecError(`modalità porta non valida: ${control.mode}`)
    return new Writer(F.SetDoorControl, controller)
      .u8(8, door(control.door))
      .u8(9, control.mode)
      .u8(10, control.delay, 'ritardo porta').buf
  },

  setDoorPasscodes(controller: number, d: number, passcodes: number[]): Buffer {
    if (passcodes.length > 4) throw new CodecError('al massimo 4 passcode per porta')
    const w = new Writer(F.SetDoorPasscodes, controller).u8(8, door(d))
    for (let i = 0; i < 4; i++) w.pin32(12 + 4 * i, passcodes[i] ?? 0, `passcode ${i + 1}`)
    return w.buf
  },

  openDoor(controller: number, d: number): Buffer {
    return new Writer(F.OpenDoor, controller).u8(8, door(d)).buf
  },

  getStatus(controller: number): Buffer {
    return new Writer(F.GetStatus, controller).buf
  },

  getCards(controller: number): Buffer {
    return new Writer(F.GetCards, controller).buf
  },

  getCard(controller: number, card: number): Buffer {
    return new Writer(F.GetCard, controller).u32(8, cardNumber(card)).buf
  },

  getCardAtIndex(controller: number, index: number): Buffer {
    if (!Number.isInteger(index) || index < 1) throw new CodecError(`indice tessera non valido: ${index}`)
    return new Writer(F.GetCardAtIndex, controller).u32(8, index).buf
  },

  putCard(controller: number, card: Card): Buffer {
    if (card.from === null || card.to === null) throw new CodecError('put card: date di validità obbligatorie')
    const w = new Writer(F.PutCard, controller)
      .u32(8, cardNumber(card.card))
      .date(12, card.from, 'valida dal')
      .date(16, card.to, 'valida al')
    card.doors.forEach((p, i) => {
      if (!Number.isInteger(p) || p < 0 || p > 254) throw new CodecError(`permesso porta ${i + 1} non valido: ${p}`)
      w.u8(20 + i, p)
    })
    w.pin24(24, card.pin)
    w.u8(27, card.firstCard.reduce((acc, on, i) => (on ? acc | (1 << i) : acc), 0))
    return w.buf
  },

  deleteCard(controller: number, card: number): Buffer {
    return new Writer(F.DeleteCard, controller).u32(8, cardNumber(card)).buf
  },

  deleteAllCards(controller: number): Buffer {
    return new Writer(F.DeleteAllCards, controller).u32(8, MAGIC).buf
  },

  getEvent(controller: number, index: number): Buffer {
    return new Writer(F.GetEvent, controller).u32(8, index, 'indice evento').buf
  },

  getEventIndex(controller: number): Buffer {
    return new Writer(F.GetEventIndex, controller).buf
  },

  setEventIndex(controller: number, index: number): Buffer {
    return new Writer(F.SetEventIndex, controller).u32(8, index, 'indice evento').u32(12, MAGIC).buf
  },

  recordSpecialEvents(controller: number, enabled: boolean): Buffer {
    return new Writer(F.RecordSpecialEvents, controller).bool(8, enabled).buf
  },

  getTimeProfile(controller: number, id: number): Buffer {
    return new Writer(F.GetTimeProfile, controller).u8(8, profileId(id)).buf
  },

  setTimeProfile(controller: number, p: TimeProfile): Buffer {
    if (p.from === null || p.to === null) throw new CodecError('profilo orario: date di validità obbligatorie')
    if (p.segments.length > 3) throw new CodecError('profilo orario: al massimo 3 segmenti')
    const w = new Writer(F.SetTimeProfile, controller)
      .u8(8, profileId(p.id))
      .date(9, p.from, 'valido dal')
      .date(13, p.to, 'valido al')
    weekdays(w, 17, p.weekdays)
    p.segments.forEach((s, i) => {
      w.hhmm(24 + 4 * i, s.start, `segmento ${i + 1} inizio`)
      w.hhmm(26 + 4 * i, s.end, `segmento ${i + 1} fine`)
    })
    w.u8(36, p.linkedTo === 0 ? 0 : profileId(p.linkedTo, 'profilo collegato'))
    return w.buf
  },

  clearTimeProfiles(controller: number): Buffer {
    return new Writer(F.ClearTimeProfiles, controller).u32(8, MAGIC).buf
  },

  addTask(controller: number, t: Task): Buffer {
    if (!Number.isInteger(t.task) || t.task < 0 || t.task > 12) throw new CodecError(`tipo task non valido: ${t.task}`)
    const w = new Writer(F.AddTask, controller).date(8, t.from, 'valido dal').date(12, t.to, 'valido al')
    weekdays(w, 16, t.weekdays)
    return w
      .hhmm(23, t.start, 'ora inizio')
      .u8(25, door(t.door))
      .u8(26, t.task)
      .u8(27, t.moreCards, 'more cards').buf
  },

  refreshTaskList(controller: number): Buffer {
    return new Writer(F.RefreshTaskList, controller).u32(8, MAGIC).buf
  },

  clearTaskList(controller: number): Buffer {
    return new Writer(F.ClearTaskList, controller).u32(8, MAGIC).buf
  },

  setPCControl(controller: number, enabled: boolean): Buffer {
    return new Writer(F.SetPCControl, controller).u32(8, MAGIC).bool(12, enabled).buf
  },

  setInterlock(controller: number, interlock: Interlock | number): Buffer {
    if (!INTERLOCK_VALUES.includes(interlock)) throw new CodecError(`modalità interblocco non valida: ${interlock}`)
    return new Writer(F.SetInterlock, controller).u8(8, interlock).buf
  },

  activateKeypads(controller: number, readers: Quad<boolean>): Buffer {
    const w = new Writer(F.ActivateKeypads, controller)
    readers.forEach((on, i) => w.bool(8 + i, on))
    return w.buf
  },

  getAntiPassback(controller: number): Buffer {
    return new Writer(F.GetAntiPassback, controller).buf
  },

  setAntiPassback(controller: number, mode: AntiPassback | number): Buffer {
    if (!Number.isInteger(mode) || mode < 0 || mode > 4) throw new CodecError(`modalità anti-passback non valida: ${mode}`)
    return new Writer(F.SetAntiPassback, controller).u8(8, mode).buf
  },

  setFirstCard(controller: number, fc: FirstCardConfig): Buffer {
    if (![0, 1, 2].includes(fc.activeMode)) throw new CodecError(`modalità first-card attiva non valida: ${fc.activeMode}`)
    if (![0, 1, 2, 3].includes(fc.inactiveMode)) {
      throw new CodecError(`modalità first-card inattiva non valida: ${fc.inactiveMode}`)
    }
    const w = new Writer(F.SetFirstCard, controller)
      .u8(8, door(fc.door))
      .hhmm(9, fc.start, 'ora inizio')
      .u8(11, fc.activeMode)
      .hhmm(12, fc.end, 'ora fine')
      .u8(14, fc.inactiveMode)
    weekdays(w, 15, fc.weekdays)
    return w.buf
  },

  restoreDefaultParameters(controller: number): Buffer {
    return new Writer(F.RestoreDefaultParameters, controller).u32(8, MAGIC).buf
  },
}

// ---------------------------------------------------------------------------
// Decoder delle risposte
// ---------------------------------------------------------------------------

export interface OkResponse {
  controller: number
  ok: boolean
}

function ok(code: number) {
  return (buf: Buffer): OkResponse => {
    const r = reader(buf, code)
    return { controller: r.controller, ok: r.bool(8) }
  }
}

function decodeEvent(r: Reader): ControllerEvent {
  return {
    index: r.u32(8),
    type: r.u8(12),
    granted: r.bool(13),
    door: r.u8(14),
    direction: r.u8(15),
    card: r.u32(16),
    timestamp: r.datetime(20),
    reason: r.u8(27),
  }
}

function decodeCard(r: Reader): Card {
  const fc = r.u8(27)
  return {
    card: r.u32(8),
    from: r.date(12),
    to: r.date(16),
    doors: quad((i) => r.u8(20 + i)),
    pin: r.pin24(24),
    firstCard: quad((i) => (fc & (1 << i)) !== 0),
  }
}

function decodeStatusPacket(r: Reader): ControllerStatus {
  const relays = r.u8(49)
  const inputs = r.u8(50)
  const event = decodeEvent(r)
  return {
    controller: r.controller,
    systemDate: r.shortdate(51),
    systemTime: r.time(37),
    doorOpen: quad((i) => r.bool(28 + i)),
    buttonPressed: quad((i) => r.bool(32 + i)),
    relays,
    relayUnlocked: quad((i) => (relays & (1 << i)) !== 0),
    inputs,
    forceLock: (inputs & 0x01) !== 0,
    fireAlarm: (inputs & 0x02) !== 0,
    systemError: r.u8(36),
    specialInfo: r.u8(48),
    sequenceNo: r.u32(40),
    event: event.index === 0 ? null : event,
  }
}

export const decode = {
  getController(buf: Buffer): ControllerInfo {
    const r = reader(buf, F.GetController)
    return {
      controller: r.controller,
      address: r.ipv4(8),
      netmask: r.ipv4(12),
      gateway: r.ipv4(16),
      mac: r.mac(20),
      version: r.version(26),
      date: r.date(28),
    }
  },

  getTime(buf: Buffer): { controller: number; datetime: DateTimeString | null } {
    const r = reader(buf, F.GetTime)
    return { controller: r.controller, datetime: r.datetime(8) }
  },

  setTime(buf: Buffer): { controller: number; datetime: DateTimeString | null } {
    const r = reader(buf, F.SetTime)
    return { controller: r.controller, datetime: r.datetime(8) }
  },

  getListener(buf: Buffer): ListenerConfig & { controller: number } {
    const r = reader(buf, F.GetListener)
    return { controller: r.controller, address: r.ipv4(8), port: r.u16(12), interval: r.u8(14) }
  },

  setListener: ok(F.SetListener),

  getDoorControl(buf: Buffer): DoorControl & { controller: number } {
    const r = reader(buf, F.GetDoorControl)
    return { controller: r.controller, door: r.u8(8), mode: r.u8(9), delay: r.u8(10) }
  },

  setDoorControl(buf: Buffer): DoorControl & { controller: number } {
    const r = reader(buf, F.SetDoorControl)
    return { controller: r.controller, door: r.u8(8), mode: r.u8(9), delay: r.u8(10) }
  },

  setDoorPasscodes: ok(F.SetDoorPasscodes),
  openDoor: ok(F.OpenDoor),

  getStatus(buf: Buffer): ControllerStatus {
    return decodeStatusPacket(reader(buf, F.GetStatus))
  },

  getCards(buf: Buffer): { controller: number; cards: number } {
    const r = reader(buf, F.GetCards)
    return { controller: r.controller, cards: r.u32(8) }
  },

  /** card = 0 → non trovata */
  getCard(buf: Buffer): { controller: number; card: Card } {
    const r = reader(buf, F.GetCard)
    return { controller: r.controller, card: decodeCard(r) }
  },

  /** card = 0 → nessun record; card = DELETED_CARD → record cancellato */
  getCardAtIndex(buf: Buffer): { controller: number; card: Card } {
    const r = reader(buf, F.GetCardAtIndex)
    return { controller: r.controller, card: decodeCard(r) }
  },

  putCard: ok(F.PutCard),
  deleteCard: ok(F.DeleteCard),
  deleteAllCards: ok(F.DeleteAllCards),

  getEvent(buf: Buffer): { controller: number; event: ControllerEvent } {
    const r = reader(buf, F.GetEvent)
    return { controller: r.controller, event: decodeEvent(r) }
  },

  getEventIndex(buf: Buffer): { controller: number; index: number } {
    const r = reader(buf, F.GetEventIndex)
    return { controller: r.controller, index: r.u32(8) }
  },

  setEventIndex: ok(F.SetEventIndex),
  recordSpecialEvents: ok(F.RecordSpecialEvents),

  /** profile = null → profilo non definito */
  getTimeProfile(buf: Buffer): { controller: number; profile: TimeProfile | null } {
    const r = reader(buf, F.GetTimeProfile)
    const id = r.u8(8)
    if (id === 0) return { controller: r.controller, profile: null }
    const segments: TimeSegment[] = []
    for (let i = 0; i < 3; i++) {
      const start = r.hhmm(24 + 4 * i) ?? '00:00'
      const end = r.hhmm(26 + 4 * i) ?? '00:00'
      if (start !== '00:00' || end !== '00:00') segments.push({ start, end })
    }
    return {
      controller: r.controller,
      profile: {
        id,
        from: r.date(9),
        to: r.date(13),
        weekdays: readWeekdays(r, 17),
        segments,
        linkedTo: r.u8(36),
      },
    }
  },

  setTimeProfile: ok(F.SetTimeProfile),
  clearTimeProfiles: ok(F.ClearTimeProfiles),
  addTask: ok(F.AddTask),
  refreshTaskList: ok(F.RefreshTaskList),
  clearTaskList: ok(F.ClearTaskList),
  setPCControl: ok(F.SetPCControl),
  setInterlock: ok(F.SetInterlock),
  activateKeypads: ok(F.ActivateKeypads),

  getAntiPassback(buf: Buffer): { controller: number; antipassback: number } {
    const r = reader(buf, F.GetAntiPassback)
    return { controller: r.controller, antipassback: r.u8(8) }
  },

  setAntiPassback: ok(F.SetAntiPassback),
  setFirstCard: ok(F.SetFirstCard),
  restoreDefaultParameters: ok(F.RestoreDefaultParameters),
}

/**
 * Decodifica un pacchetto evento ricevuto dal listener (stesso layout di Get Status).
 * Restituisce null se il pacchetto non è un evento valido.
 */
export function decodeListenerEvent(buf: Buffer): ControllerStatus | null {
  const r = validatePacket(buf)
  if (!r || r.functionCode !== F.GetStatus) return null
  return decodeStatusPacket(r)
}
