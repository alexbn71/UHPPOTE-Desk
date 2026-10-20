/**
 * Reader and door options of the controller parameter table (vendor "extended functions"), reconstructed from
 * the vendor software: four swipes = normally open, silent reader on invalid cards, minimum gap between two
 * swipes of the same card, door as switch, multi-card access (number of cards only, no groups).
 * Written with 0xF2 like the expansion board and verified by reading the table back.
 */
import { CodecError } from '../errors.js'
import type { ParameterWrite } from './expansion.js'
import type { Quad } from './messages.js'

export const OptionParam = {
  /**
   * Multi-card doors: on a four-door controller the vendor software sets bit (door - 1) for every door with
   * multi-card access (capture: 0x55 → 0x5D for door 4); the other bits are kept. Factory value 0x55.
   */
  MultiCardDoors: 40,
  /** Minimum gap between two swipes of the same card: uint16 LE in units of 2 s (0 = off; factory 0xFFFF = off). */
  SwipeGap: 52,
  /** Cards needed to open, per door (0 = multi-card off). */
  MultiCardTotal: 168,
  /** Multi-card groups, 8 bytes per door (written as 0: no groups). */
  MultiCardGroups: 172,
  /** Multi-card options per door: bit 3 single group, bit 4 sequence, bits 0-2 start group - 1. */
  MultiCardOptions: 218,
  /** 0xA5 = no LED/beep on the reader for an invalid card (firmware V5.48+). */
  SilentInvalidCard: 205,
  /** Doors used as a switch: bit mask of doors 1-4, stored inverted (0xFF = none). */
  DoorAsSwitch: 222,
  /** Four valid swipes toggle normally open: bits 0-3 readers, bits 4-7 time profile (0 = all users; V5.52+). */
  FourTimesNormalOpen: 250,
} as const

export const SILENT_INVALID_CARD_ON = 0xa5
export const MULTI_CARD_DOORS_FACTORY = 0x55
export const MAX_SWIPE_GAP_SECONDS = 600
export const MAX_MULTI_CARDS = 10
/** Bits of the multi-card options byte managed here (the others are kept as read). */
export const MULTI_CARD_OPTION_BITS = 0x1f

export interface ControllerOptions {
  /** Four swipes of a valid card toggle the door between normally open and controlled. */
  fourTimesNormalOpen: {
    readers: Quad<boolean>
    /** 0 = every user; 2-15 = only users whose permission uses this time profile. */
    timeProfile: number
  }
  /** The reader stays silent (no LED, no beep) on an invalid card. */
  silentInvalidCard: boolean
  /** Seconds before the same card is accepted again (0 = off, even values). */
  swipeGapSeconds: number
  /** The card toggles the lock (open/closed) instead of a pulse. */
  doorAsSwitch: Quad<boolean>
  /** Cards needed to open each door: 0 = off, 2-10. */
  multiCard: Quad<number>
}

export const DEFAULT_CONTROLLER_OPTIONS: ControllerOptions = {
  fourTimesNormalOpen: { readers: [false, false, false, false], timeProfile: 0 },
  silentInvalidCard: false,
  swipeGapSeconds: 0,
  doorAsSwitch: [false, false, false, false],
  multiCard: [0, 0, 0, 0],
}

const bits = (q: Quad<boolean>) => q.reduce((acc, on, i) => (on ? acc | (1 << i) : acc), 0)
const fromBits = (v: number) => [0, 1, 2, 3].map((i) => (v & (1 << i)) !== 0) as Quad<boolean>

export function validateControllerOptions(o: ControllerOptions): void {
  const tp = o.fourTimesNormalOpen.timeProfile
  if (!Number.isInteger(tp) || tp < 0 || tp > 15 || tp === 1) {
    throw new CodecError(`four swipes: time profile must be 0 or 2-15: ${tp}`)
  }
  const gap = o.swipeGapSeconds
  if (!Number.isInteger(gap) || gap < 0 || gap > MAX_SWIPE_GAP_SECONDS || gap % 2 !== 0) {
    throw new CodecError(`swipe gap must be an even number of seconds (0-${MAX_SWIPE_GAP_SECONDS}): ${gap}`)
  }
  o.multiCard.forEach((n, i) => {
    if (!Number.isInteger(n) || n === 1 || n < 0 || n > MAX_MULTI_CARDS) {
      throw new CodecError(`door ${i + 1} multi-card: 0 or 2-${MAX_MULTI_CARDS} cards: ${n}`)
    }
  })
}

/**
 * Parameter bytes for the options. `current` (the table read from the controller) keeps the bits of the
 * multi-card options bytes that are not managed here; without it they are written as 0.
 */
export function controllerOptionsParameters(o: ControllerOptions, current?: Uint8Array): ParameterWrite[] {
  validateControllerOptions(o)
  const out: ParameterWrite[] = []
  const put = (index: number, value: number) => out.push({ index, value: value & 0xff })
  const gap = o.swipeGapSeconds / 2
  put(OptionParam.SwipeGap, gap)
  put(OptionParam.SwipeGap + 1, gap >> 8)
  const multiDoors = o.multiCard.reduce((acc, n, i) => (n > 0 ? acc | (1 << i) : acc), 0)
  put(
    OptionParam.MultiCardDoors,
    (current ? current[OptionParam.MultiCardDoors]! : MULTI_CARD_DOORS_FACTORY) | multiDoors,
  )
  o.multiCard.forEach((n, i) => {
    put(OptionParam.MultiCardTotal + i, n)
    for (let g = 0; g < 8; g++) put(OptionParam.MultiCardGroups + i * 8 + g, 0)
    const keep = current ? current[OptionParam.MultiCardOptions + i]! & ~MULTI_CARD_OPTION_BITS : 0
    put(OptionParam.MultiCardOptions + i, keep)
  })
  put(OptionParam.SilentInvalidCard, o.silentInvalidCard ? SILENT_INVALID_CARD_ON : 0)
  put(OptionParam.DoorAsSwitch, ~bits(o.doorAsSwitch))
  put(OptionParam.FourTimesNormalOpen, bits(o.fourTimesNormalOpen.readers) | (o.fourTimesNormalOpen.timeProfile << 4))
  return out.sort((a, b) => a.index - b.index)
}

/** Options decoded from a parameter table (0xFF / 0xFFFF factory values = off). */
export function decodeControllerOptions(t: Uint8Array): ControllerOptions {
  const gapRaw = t[OptionParam.SwipeGap]! | (t[OptionParam.SwipeGap + 1]! << 8)
  const four = t[OptionParam.FourTimesNormalOpen]!
  return {
    fourTimesNormalOpen: { readers: fromBits(four & 0x0f), timeProfile: four >> 4 },
    silentInvalidCard: t[OptionParam.SilentInvalidCard] === SILENT_INVALID_CARD_ON,
    swipeGapSeconds: gapRaw === 0xffff ? 0 : gapRaw * 2,
    doorAsSwitch: fromBits(~t[OptionParam.DoorAsSwitch]! & 0x0f),
    multiCard: [0, 1, 2, 3].map((i) => t[OptionParam.MultiCardTotal + i]!) as Quad<number>,
  }
}

/** Managed bytes that differ in a table read back (multi-card options: only the managed bits). */
export function compareControllerOptions(
  o: ControllerOptions,
  t: Uint8Array,
): { index: number; expected: number; actual: number }[] {
  return controllerOptionsParameters(o, t)
    .filter((w) => t[w.index] !== w.value)
    .map((w) => ({ index: w.index, expected: w.value, actual: t[w.index]! }))
}
