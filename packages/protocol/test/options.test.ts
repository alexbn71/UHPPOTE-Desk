/**
 * Reader and door options of the parameter table (vendor "extended functions").
 * Expected bytes from the vendor software analysis; factory values read from a UT0311 (firmware v9.f8).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CodecError,
  compareControllerOptions,
  controllerOptionsParameters,
  decodeControllerOptions,
  DEFAULT_CONTROLLER_OPTIONS,
  PARAMETER_TABLE_SIZE,
  type ControllerOptions,
  type Quad,
} from '../src/index.js'

function table(o: ControllerOptions, current?: Uint8Array): Uint8Array {
  const t = current ? Uint8Array.from(current) : new Uint8Array(PARAMETER_TABLE_SIZE)
  for (const w of controllerOptionsParameters(o, current)) t[w.index] = w.value
  return t
}

const sample: ControllerOptions = {
  fourTimesNormalOpen: { readers: [true, false, true, false], timeProfile: 3 },
  silentInvalidCard: true,
  swipeGapSeconds: 10,
  doorAsSwitch: [false, true, false, false],
  multiCard: [0, 0, 0, 3],
}

describe('controller options', () => {
  it('byte layout', () => {
    const t = table(sample)
    expect(t[250]).toBe(0b0101 | (3 << 4))
    expect(t[205]).toBe(0xa5)
    expect([t[52], t[53]]).toEqual([5, 0])
    expect(t[222]).toBe(~0b0010 & 0xff)
    expect([...t.subarray(168, 172)]).toEqual([0, 0, 0, 3])
    // door 4 bit on the factory value, like the vendor upload (0x55 → 0x5D)
    expect(t[40]).toBe(0x5d)
    expect([...t.subarray(172, 204)].every((b) => b === 0)).toBe(true)
  })

  it('defaults = the factory state read from a controller', () => {
    const t = table(DEFAULT_CONTROLLER_OPTIONS)
    expect([t[250], t[205], t[52], t[53], t[222]]).toEqual([0, 0, 0, 0, 0xff])
  })

  it('factory 0xFF / 0xFFFF values decode as off', () => {
    const t = new Uint8Array(PARAMETER_TABLE_SIZE)
    t[52] = 0xff
    t[53] = 0xff
    t[205] = 0xff
    t[222] = 0xff
    expect(decodeControllerOptions(t)).toEqual(DEFAULT_CONTROLLER_OPTIONS)
  })

  it('multi-card doors byte 40: the bits of the read table are kept, the active doors added', () => {
    const current = new Uint8Array(PARAMETER_TABLE_SIZE)
    current[40] = 0x55
    const w = (o: ControllerOptions) => controllerOptionsParameters(o, current).find((x) => x.index === 40)!.value
    expect(w({ ...DEFAULT_CONTROLLER_OPTIONS, multiCard: [0, 0, 0, 3] })).toBe(0x5d)
    expect(w(DEFAULT_CONTROLLER_OPTIONS)).toBe(0x55)
  })

  it('keeps the multi-card option bits it does not manage', () => {
    const current = new Uint8Array(PARAMETER_TABLE_SIZE)
    current[218] = 0xe7 // bits 5-7 unknown + managed bits set
    const w = controllerOptionsParameters(DEFAULT_CONTROLLER_OPTIONS, current).find((x) => x.index === 218)!
    expect(w.value).toBe(0xe0)
    expect(controllerOptionsParameters(DEFAULT_CONTROLLER_OPTIONS).find((x) => x.index === 218)!.value).toBe(0)
  })

  it('validation', () => {
    const bad = (patch: Partial<ControllerOptions>) => () => controllerOptionsParameters({ ...sample, ...patch })
    expect(bad({ swipeGapSeconds: 3 })).toThrow(CodecError)
    expect(bad({ swipeGapSeconds: 602 })).toThrow(CodecError)
    expect(bad({ multiCard: [1, 0, 0, 0] })).toThrow(CodecError)
    expect(bad({ multiCard: [11, 0, 0, 0] })).toThrow(CodecError)
    expect(bad({ fourTimesNormalOpen: { readers: [true, true, true, true], timeProfile: 1 } })).toThrow(CodecError)
    expect(bad({ fourTimesNormalOpen: { readers: [true, true, true, true], timeProfile: 16 } })).toThrow(CodecError)
  })

  it('compare: no difference after writing, the changed byte otherwise', () => {
    const t = table(sample)
    expect(compareControllerOptions(sample, t)).toEqual([])
    t[250] = 0
    expect(compareControllerOptions(sample, t)).toEqual([{ index: 250, expected: 0x35, actual: 0 }])
  })

  it('property: decode is the inverse of the encoding', () => {
    const quadB = fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()) as fc.Arbitrary<Quad<boolean>>
    const cards = fc.oneof(fc.constant(0), fc.integer({ min: 2, max: 10 }))
    fc.assert(
      fc.property(
        quadB,
        fc.oneof(fc.constant(0), fc.integer({ min: 2, max: 15 })),
        fc.boolean(),
        fc.integer({ min: 0, max: 300 }),
        quadB,
        fc.tuple(cards, cards, cards, cards),
        (readers, timeProfile, silentInvalidCard, half, doorAsSwitch, multiCard) => {
          const o: ControllerOptions = {
            fourTimesNormalOpen: { readers, timeProfile },
            silentInvalidCard,
            swipeGapSeconds: half * 2,
            doorAsSwitch,
            multiCard: multiCard as Quad<number>,
          }
          expect(decodeControllerOptions(table(o))).toEqual(o)
        },
      ),
    )
  })
})
