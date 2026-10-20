/**
 * UT0311-01A alarm expansion board (4 relays + fire input) and the controller parameter table that configures it.
 *
 * Nothing here is in the public protocol: the layout comes from the vendor software (N3000 / WG3000_COMM).
 * The board is configured by writing bytes of the controller parameter table with function 0xF2;
 * the table cannot be read back with short packets, so the configuration is write-only.
 */
import { CodecError } from '../errors.js'
import type { Quad } from './messages.js'

/** Number of bytes of the parameter table addressable with 0xF2. */
export const PARAMETER_TABLE_SIZE = 1024

/** Offset between a parameter index and the address sent in the 0xF2 packet. */
export const PARAMETER_ADDRESS_OFFSET = 16

/** Maximum number of (address, value) pairs in one 0xF2 packet. */
export const PARAMETERS_PER_PACKET = 8

/** Indexes of the parameter table used by the expansion board. */
export const Param = {
  /** 1 = record alarm events. */
  RecordAlarmEvents: 30,
  /** Bitmask of the alarm types handled by the controller (ExpansionEvent bits + 0x40 ARM). */
  AlarmEvents: 32,
  /** "Door open too long" time, low byte (tenths of a second); high byte at DoorOpenTooLongHigh. */
  DoorOpenTooLong: 35,
  /** Burglar alarm (ARM) control mode. */
  ArmMode: 45,
  /** ARM delays in seconds. */
  ArmDelay: 46,
  DisarmDelay: 47,
  /** Duress (threat) code: bytes 74-75 little-endian + byte 163. */
  DuressCode: 74,
  DoorOpenTooLongHigh: 162,
  DuressCodeHigh: 163,
  /** First of the 4 relay blocks (6 bytes each). */
  ExpansionRelays: 136,
} as const

export const EXPANSION_RELAY_BLOCK_SIZE = 6

/** What drives a relay: one of the controller doors, or the burglar alarm (ARM). */
export const ExpansionSource = {
  Door1: 0,
  Door2: 1,
  Door3: 2,
  Door4: 3,
  Arm: 16,
} as const
export type ExpansionSource = (typeof ExpansionSource)[keyof typeof ExpansionSource]
export const EXPANSION_SOURCES: readonly number[] = Object.values(ExpansionSource)

/** How long the relay stays active once triggered. */
export const ExpansionOutputMode = {
  /** For the output duration. */
  Timed: 1,
  /** For the output duration and until the event is reset. */
  TimedUntilReset: 2,
  /** Until the event is reset. */
  UntilReset: 3,
  /** While at least one of the selected signals is active. */
  AnySignal: 4,
  /** While all the selected signals are active. */
  AllSignals: 5,
} as const
export type ExpansionOutputMode = (typeof ExpansionOutputMode)[keyof typeof ExpansionOutputMode]

/** Events that trigger a relay (bitmask). */
export const ExpansionEvent = {
  Threat: 0x01,
  OpenTooLong: 0x02,
  ForcedOpen: 0x04,
  ForcedLock: 0x08,
  InvalidCard: 0x10,
  Fire: 0x20,
} as const
export const EXPANSION_EVENT_MASK = 0x3f

/** Signals used by the AnySignal/AllSignals modes (bitmask). [NC]/[NO] = contact type. */
export const ExpansionSignal = {
  /** The trigger door's lock relay [NC]. */
  LockRelay: 0x01,
  /** The trigger door's sensor [NC]. */
  DoorSensor: 0x02,
  /** The trigger door's push button [NO]. */
  PushButton: 0x04,
  /** Force lock input [NO]. */
  ForceLock: 0x08,
  /** Inputs ExtA1-ExtA3 of the board [NC]. */
  ExtA1: 0x10,
  ExtA2: 0x20,
  ExtA3: 0x40,
  /** Fire input of the board [NO]. */
  ExtFire: 0x80,
} as const

/** Bit of Param.AlarmEvents set when a relay is driven by the burglar alarm. */
export const ALARM_EVENTS_ARM = 0x40
/** Bits the vendor software always sets in Param.AlarmEvents (forced lock, fire). */
export const ALARM_EVENTS_ALWAYS = ExpansionEvent.ForcedLock | ExpansionEvent.Fire

/** Vendor defaults written when a relay uses the ARM source. */
export const ARM_DEFAULTS = { mode: 126, armDelay: 30, disarmDelay: 30 } as const

export const MAX_DURATION_SECONDS = 6553
export const DEFAULT_DOOR_OPEN_TOO_LONG = 25

export interface ExpansionRelay {
  active: boolean
  source: ExpansionSource | number
  mode: ExpansionOutputMode | number
  /** ExpansionEvent bitmask (ignored with the ARM source). */
  events: number
  /** ExpansionSignal bitmask (AnySignal/AllSignals modes). */
  signals: number
  /** Output duration in seconds (0-6553). */
  duration: number
}

export interface ExpansionBoardConfig {
  relays: Quad<ExpansionRelay>
  /** Seconds after which an open door raises "open too long" (1-6553). */
  doorOpenTooLong: number
  /** Duress code typed on the keypad (0-999999); null = left unchanged. */
  duressCode: number | null
}

export interface ParameterWrite {
  index: number
  value: number
}

export const INACTIVE_RELAY: ExpansionRelay = { active: false, source: 0, mode: 0, events: 0, signals: 0, duration: 0 }

function intIn(v: number, min: number, max: number, field: string): void {
  if (!Number.isInteger(v) || v < min || v > max)
    throw new CodecError(`${field}: value out of range (${min}-${max}): ${v}`)
}

export function validateExpansionRelay(r: ExpansionRelay, n: number): void {
  if (!r.active) return
  const f = `relay ${n + 1}`
  if (!EXPANSION_SOURCES.includes(r.source)) throw new CodecError(`${f}: invalid source ${r.source}`)
  intIn(r.mode, 1, 5, `${f} mode`)
  intIn(r.events, 0, EXPANSION_EVENT_MASK, `${f} events`)
  intIn(r.signals, 0, 0xff, `${f} signals`)
  intIn(r.duration, 0, MAX_DURATION_SECONDS, `${f} duration`)
}

/**
 * Parameter bytes written for an expansion board configuration, as the vendor software does:
 * the 4 relay blocks, the alarm types, "record alarm events", the open-too-long time,
 * the ARM defaults (only if a relay uses ARM) and the duress code (only if set).
 */
export function expansionBoardParameters(cfg: ExpansionBoardConfig): ParameterWrite[] {
  cfg.relays.forEach(validateExpansionRelay)
  intIn(cfg.doorOpenTooLong, 1, MAX_DURATION_SECONDS, 'door open too long')
  if (cfg.duressCode !== null) intIn(cfg.duressCode, 0, 999999, 'duress code')

  const out: ParameterWrite[] = []
  const put = (index: number, value: number) => out.push({ index, value: value & 0xff })
  let alarmEvents = ALARM_EVENTS_ALWAYS
  cfg.relays.forEach((relay, n) => {
    const r = relay.active ? relay : INACTIVE_RELAY
    const arm = r.active && r.source === ExpansionSource.Arm
    const events = arm ? 0 : r.events
    const tenths = r.duration * 10
    const base = Param.ExpansionRelays + n * EXPANSION_RELAY_BLOCK_SIZE
    put(base, r.source)
    put(base + 1, r.mode)
    put(base + 2, events)
    put(base + 3, r.signals)
    put(base + 4, tenths)
    put(base + 5, tenths >> 8)
    alarmEvents |= events
    if (arm) alarmEvents |= ALARM_EVENTS_ARM
  })
  put(Param.AlarmEvents, alarmEvents)
  put(Param.RecordAlarmEvents, 1)
  const ajar = cfg.doorOpenTooLong * 10
  put(Param.DoorOpenTooLong, ajar)
  put(Param.DoorOpenTooLongHigh, ajar >> 8)
  if (alarmEvents & ALARM_EVENTS_ARM) {
    put(Param.ArmMode, ARM_DEFAULTS.mode)
    put(Param.ArmDelay, ARM_DEFAULTS.armDelay)
    put(Param.DisarmDelay, ARM_DEFAULTS.disarmDelay)
  }
  if (cfg.duressCode !== null) {
    put(Param.DuressCode, cfg.duressCode)
    put(Param.DuressCode + 1, cfg.duressCode >> 8)
    put(Param.DuressCodeHigh, cfg.duressCode >> 16)
  }
  // ascending order, like the vendor software (it walks the table looking for modified bytes)
  return out.sort((a, b) => a.index - b.index)
}

/** Inverse of expansionBoardParameters, from a parameter table image (FakeController, tests). */
export function decodeExpansionBoard(params: Uint8Array): ExpansionBoardConfig {
  const u16 = (i: number) => params[i]! | (params[i + 1]! << 8)
  const relays = [0, 1, 2, 3].map((n): ExpansionRelay => {
    const base = Param.ExpansionRelays + n * EXPANSION_RELAY_BLOCK_SIZE
    const mode = params[base + 1]!
    if (mode === 0) return { ...INACTIVE_RELAY }
    return {
      active: true,
      source: params[base]!,
      mode,
      events: params[base + 2]!,
      signals: params[base + 3]!,
      duration: Math.round(u16(base + 4) / 10),
    }
  }) as Quad<ExpansionRelay>
  return {
    relays,
    doorOpenTooLong: Math.round((params[Param.DoorOpenTooLong]! | (params[Param.DoorOpenTooLongHigh]! << 8)) / 10),
    duressCode: u16(Param.DuressCode) | (params[Param.DuressCodeHigh]! << 16),
  }
}

/** Splits parameter writes into 0xF2 packets (at most 8 per packet). */
export function chunkParameters(writes: ParameterWrite[]): ParameterWrite[][] {
  const out: ParameterWrite[][] = []
  for (let i = 0; i < writes.length; i += PARAMETERS_PER_PACKET) out.push(writes.slice(i, i + PARAMETERS_PER_PACKET))
  return out
}

export interface ParameterMismatch {
  index: number
  expected: number
  actual: number
}

/** Bytes of `cfg` (as expansionBoardParameters writes them) that differ in a parameter table read back. */
export function compareExpansionBoard(cfg: ExpansionBoardConfig, table: Uint8Array): ParameterMismatch[] {
  return expansionBoardParameters(cfg)
    .filter((w) => table[w.index] !== w.value)
    .map((w) => ({ index: w.index, expected: w.value, actual: table[w.index]! }))
}
