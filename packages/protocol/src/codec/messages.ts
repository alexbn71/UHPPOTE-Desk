import { CodecError } from '../errors.js'
import { Reader, Writer, type DateString, type DateTimeString, type TimeString } from './bytes.js'
import { PARAMETER_ADDRESS_OFFSET, PARAMETER_TABLE_SIZE, PARAMETERS_PER_PACKET, type ParameterWrite } from './expansion.js'
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
// Protocol domain types
// ---------------------------------------------------------------------------

export type Door = 1 | 2 | 3 | 4
/** Mon..Sun */
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
  /** Auto-send interval in seconds (0 = disabled). */
  interval: number
}

export interface DoorControl {
  door: number
  mode: DoorMode | number
  /** Open delay in seconds (0-255). */
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
  /** Raw relay bitmask (bit0..3 = door 1..4, 1 = unlocked). */
  relays: number
  relayUnlocked: Quad<boolean>
  /** Raw input bitmask. */
  inputs: number
  forceLock: boolean
  fireAlarm: boolean
  systemError: number
  specialInfo: number
  sequenceNo: number
  /** null if the controller has no events yet (index 0). */
  event: ControllerEvent | null
}

/**
 * Permission per door: 0 = no access, 1 = always, 2..254 = time profile ID.
 */
export type DoorPermission = number

export interface Card {
  card: number
  from: DateString | null
  to: DateString | null
  doors: Quad<DoorPermission>
  /** 0 = no PIN */
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
  /** Up to 3 segments; 00:00-00:00 segments are omitted when decoding. */
  segments: TimeSegment[]
  /** 0 = no linked profile */
  linkedTo: number
}

export interface Task {
  task: TaskType | number
  from: DateString
  to: DateString
  weekdays: Weekdays
  start: TimeString
  door: number
  /** Number of cards for the "more cards" task. */
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

/** Special card number: deleted record. */
export const DELETED_CARD = 0xffffffff

// ---------------------------------------------------------------------------
// Packet validation
// ---------------------------------------------------------------------------

/** Checks size and SOM; returns null if the packet is not a valid UHPPOTE message. */
export function validatePacket(buf: Buffer): Reader | null {
  if (buf.length !== PACKET_SIZE) return null
  const som = buf[0]
  const fc = buf[1]
  if (som === SOM || (som === SOM_V662_EVENT && fc === F.GetStatus)) return new Reader(buf)
  return null
}

function reader(buf: Buffer, expected: number): Reader {
  const r = validatePacket(buf)
  if (!r) throw new CodecError('invalid packet (size or start-of-message)')
  if (r.functionCode !== expected) {
    throw new CodecError(
      `unexpected function code 0x${r.functionCode.toString(16)} (expected 0x${expected.toString(16)})`,
    )
  }
  return r
}

function door(v: number): number {
  if (!Number.isInteger(v) || v < 1 || v > 4) throw new CodecError(`invalid door: ${v} (1-4)`)
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
  if (!Number.isInteger(v) || v < 1 || v >= 0xffffffff) throw new CodecError(`invalid card number: ${v}`)
  return v
}

function profileId(v: number, field = 'profile'): number {
  if (!Number.isInteger(v) || v < 2 || v > 254) throw new CodecError(`${field}: invalid ID ${v} (2-254)`)
  return v
}

// ---------------------------------------------------------------------------
// Request encoders
// ---------------------------------------------------------------------------

export const encode = {
  getController(controller = 0): Buffer {
    return new Writer(F.GetController, controller).buf
  },

  setIPv4(controller: number, address: string, netmask: string, gateway: string): Buffer {
    return new Writer(F.SetIPv4, controller)
      .ipv4(8, address, 'address')
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
      .u16(12, listener.port, 'listener port')
      .u8(14, listener.interval, 'auto-send interval').buf
  },

  getDoorControl(controller: number, d: number): Buffer {
    return new Writer(F.GetDoorControl, controller).u8(8, door(d)).buf
  },

  setDoorControl(controller: number, control: DoorControl): Buffer {
    if (![1, 2, 3].includes(control.mode)) throw new CodecError(`invalid door mode: ${control.mode}`)
    return new Writer(F.SetDoorControl, controller)
      .u8(8, door(control.door))
      .u8(9, control.mode)
      .u8(10, control.delay, 'door delay').buf
  },

  setDoorPasscodes(controller: number, d: number, passcodes: number[]): Buffer {
    if (passcodes.length > 4) throw new CodecError('at most 4 passcodes per door')
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
    if (!Number.isInteger(index) || index < 1) throw new CodecError(`invalid card index: ${index}`)
    return new Writer(F.GetCardAtIndex, controller).u32(8, index).buf
  },

  putCard(controller: number, card: Card): Buffer {
    if (card.from === null || card.to === null) throw new CodecError('put card: validity dates are required')
    const w = new Writer(F.PutCard, controller)
      .u32(8, cardNumber(card.card))
      .date(12, card.from, 'valid from')
      .date(16, card.to, 'valid until')
    card.doors.forEach((p, i) => {
      if (!Number.isInteger(p) || p < 0 || p > 254) throw new CodecError(`invalid permission for door ${i + 1}: ${p}`)
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
    return new Writer(F.GetEvent, controller).u32(8, index, 'event index').buf
  },

  getEventIndex(controller: number): Buffer {
    return new Writer(F.GetEventIndex, controller).buf
  },

  setEventIndex(controller: number, index: number): Buffer {
    return new Writer(F.SetEventIndex, controller).u32(8, index, 'event index').u32(12, MAGIC).buf
  },

  recordSpecialEvents(controller: number, enabled: boolean): Buffer {
    return new Writer(F.RecordSpecialEvents, controller).bool(8, enabled).buf
  },

  getTimeProfile(controller: number, id: number): Buffer {
    return new Writer(F.GetTimeProfile, controller).u8(8, profileId(id)).buf
  },

  setTimeProfile(controller: number, p: TimeProfile): Buffer {
    if (p.from === null || p.to === null) throw new CodecError('time profile: validity dates are required')
    if (p.segments.length > 3) throw new CodecError('time profile: at most 3 segments')
    const w = new Writer(F.SetTimeProfile, controller)
      .u8(8, profileId(p.id))
      .date(9, p.from, 'valid from')
      .date(13, p.to, 'valid until')
    weekdays(w, 17, p.weekdays)
    p.segments.forEach((s, i) => {
      w.hhmm(24 + 4 * i, s.start, `segment ${i + 1} start`)
      w.hhmm(26 + 4 * i, s.end, `segment ${i + 1} end`)
    })
    w.u8(36, p.linkedTo === 0 ? 0 : profileId(p.linkedTo, 'linked profile'))
    return w.buf
  },

  clearTimeProfiles(controller: number): Buffer {
    return new Writer(F.ClearTimeProfiles, controller).u32(8, MAGIC).buf
  },

  addTask(controller: number, t: Task): Buffer {
    if (!Number.isInteger(t.task) || t.task < 0 || t.task > 12) throw new CodecError(`invalid task type: ${t.task}`)
    const w = new Writer(F.AddTask, controller).date(8, t.from, 'valid from').date(12, t.to, 'valid until')
    weekdays(w, 16, t.weekdays)
    return w
      .hhmm(23, t.start, 'start time')
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
    if (!INTERLOCK_VALUES.includes(interlock)) throw new CodecError(`invalid interlock mode: ${interlock}`)
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
    if (!Number.isInteger(mode) || mode < 0 || mode > 4) throw new CodecError(`invalid anti-passback mode: ${mode}`)
    return new Writer(F.SetAntiPassback, controller).u8(8, mode).buf
  },

  setFirstCard(controller: number, fc: FirstCardConfig): Buffer {
    if (![0, 1, 2].includes(fc.activeMode)) throw new CodecError(`invalid first-card active mode: ${fc.activeMode}`)
    if (![0, 1, 2, 3].includes(fc.inactiveMode)) {
      throw new CodecError(`invalid first-card inactive mode: ${fc.inactiveMode}`)
    }
    const w = new Writer(F.SetFirstCard, controller)
      .u8(8, door(fc.door))
      .hhmm(9, fc.start, 'start time')
      .u8(11, fc.activeMode)
      .hhmm(12, fc.end, 'end time')
      .u8(14, fc.inactiveMode)
    weekdays(w, 15, fc.weekdays)
    return w.buf
  },

  restoreDefaultParameters(controller: number): Buffer {
    return new Writer(F.RestoreDefaultParameters, controller).u32(8, MAGIC).buf
  },

  /** 0xF2: magic, then up to 8 triplets [address u16][value] from offset 12 (address = index + 16). */
  writeParameters(controller: number, writes: ParameterWrite[]): Buffer {
    if (writes.length < 1 || writes.length > PARAMETERS_PER_PACKET) {
      throw new CodecError(`write parameters: 1-${PARAMETERS_PER_PACKET} values per packet (got ${writes.length})`)
    }
    const w = new Writer(F.WriteParameters, controller).u32(8, MAGIC)
    writes.forEach((p, i) => {
      if (!Number.isInteger(p.index) || p.index < 0 || p.index >= PARAMETER_TABLE_SIZE) {
        throw new CodecError(`parameter index out of range (0-${PARAMETER_TABLE_SIZE - 1}): ${p.index}`)
      }
      w.u16(12 + 3 * i, p.index + PARAMETER_ADDRESS_OFFSET).u8(14 + 3 * i, p.value, `parameter ${p.index}`)
    })
    return w.buf
  },
}

// ---------------------------------------------------------------------------
// Response decoders
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

  /** card = 0 → not found */
  getCard(buf: Buffer): { controller: number; card: Card } {
    const r = reader(buf, F.GetCard)
    return { controller: r.controller, card: decodeCard(r) }
  },

  /** card = 0 → no record; card = DELETED_CARD → deleted record */
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

  /** profile = null → profile not defined */
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
  writeParameters: ok(F.WriteParameters),
}

/**
 * Decodes an event packet received by the listener (same layout as Get Status).
 * Returns null if the packet is not a valid event.
 */
export function decodeListenerEvent(buf: Buffer): ControllerStatus | null {
  const r = validatePacket(buf)
  if (!r || r.functionCode !== F.GetStatus) return null
  return decodeStatusPacket(r)
}
