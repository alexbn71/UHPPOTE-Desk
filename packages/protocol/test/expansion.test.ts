/**
 * UT0311-01A expansion board: parameter layout and 0xF2 packets.
 * Expected bytes are written by hand from the vendor software analysis (see docs/EXPANSION-BOARD.md).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CodecError,
  chunkParameters,
  compareExpansionBoard,
  decode,
  decodeExpansionBoard,
  encode,
  expansionBoardParameters,
  ExpansionEvent,
  ExpansionOutputMode,
  ExpansionSource,
  FunctionCode,
  INACTIVE_RELAY,
  Param,
  PARAMETER_TABLE_SIZE,
  type ExpansionBoardConfig,
  type ExpansionRelay,
  type Quad,
} from '../src/index.js'

const ID = 405419896

const relay = (r: Partial<ExpansionRelay>): ExpansionRelay => ({
  active: true,
  source: ExpansionSource.Door1,
  mode: ExpansionOutputMode.Timed,
  events: 0,
  signals: 0,
  duration: 10,
  ...r,
})

const allInactive = (): Quad<ExpansionRelay> => [
  { ...INACTIVE_RELAY },
  { ...INACTIVE_RELAY },
  { ...INACTIVE_RELAY },
  { ...INACTIVE_RELAY },
]

function table(cfg: ExpansionBoardConfig): Uint8Array {
  const t = new Uint8Array(PARAMETER_TABLE_SIZE)
  for (const p of expansionBoardParameters(cfg)) t[p.index] = p.value
  return t
}

describe('0xF2 write parameters packet', () => {
  it('header, magic and triplets [address = index + 16][value]', () => {
    const buf = encode.writeParameters(ID, [
      { index: 136, value: 0x00 },
      { index: 137, value: 0x01 },
      { index: 162, value: 0xab },
    ])
    expect(buf.length).toBe(64)
    expect(buf[0]).toBe(0x17)
    expect(buf[1]).toBe(FunctionCode.WriteParameters)
    expect(buf.readUInt32LE(4)).toBe(ID)
    expect(buf.subarray(8, 12).toString('hex')).toBe('55aaaa55')
    expect(buf.subarray(12, 21).toString('hex')).toBe('980000' + '990001' + 'b200ab')
    // unused triplets stay zero (address 0 = no write)
    expect(buf.subarray(21, 36).every((b) => b === 0)).toBe(true)
  })

  it('address above 255 uses the high byte', () => {
    const buf = encode.writeParameters(ID, [{ index: 300, value: 7 }])
    expect(buf.subarray(12, 15).toString('hex')).toBe('3c0107')
  })

  it('rejects empty, too many, out-of-range index or value', () => {
    expect(() => encode.writeParameters(ID, [])).toThrow(CodecError)
    expect(() =>
      encode.writeParameters(
        ID,
        Array.from({ length: 9 }, (_, i) => ({ index: i, value: 0 })),
      ),
    ).toThrow(CodecError)
    expect(() => encode.writeParameters(ID, [{ index: -1, value: 0 }])).toThrow(CodecError)
    expect(() => encode.writeParameters(ID, [{ index: 1024, value: 0 }])).toThrow(CodecError)
    expect(() => encode.writeParameters(ID, [{ index: 10, value: 256 }])).toThrow(CodecError)
  })

  it('reply: byte 8 = 1 means ok', () => {
    const reply = Buffer.alloc(64)
    reply[0] = 0x17
    reply[1] = 0xf2
    reply.writeUInt32LE(ID, 4)
    reply[8] = 1
    expect(decode.writeParameters(reply)).toEqual({ controller: ID, ok: true })
    reply[8] = 0
    expect(decode.writeParameters(reply).ok).toBe(false)
  })

  it('chunks of at most 8 writes', () => {
    const writes = Array.from({ length: 19 }, (_, i) => ({ index: i, value: i }))
    expect(chunkParameters(writes).map((c) => c.length)).toEqual([8, 8, 3])
  })
})

describe('expansion board parameters', () => {
  it('relay block layout: source, mode, events, signals, duration in tenths (LE)', () => {
    const cfg: ExpansionBoardConfig = {
      relays: [
        relay({ source: ExpansionSource.Door1, events: ExpansionEvent.ForcedOpen, duration: 5 }),
        relay({ source: ExpansionSource.Door3, mode: ExpansionOutputMode.AnySignal, signals: 0x82, duration: 300 }),
        { ...INACTIVE_RELAY },
        relay({
          source: ExpansionSource.Door2,
          mode: ExpansionOutputMode.UntilReset,
          events: ExpansionEvent.Fire | ExpansionEvent.Threat,
        }),
      ],
      doorOpenTooLong: 25,
      duressCode: null,
    }
    const t = table(cfg)
    expect([...t.subarray(136, 142)]).toEqual([0, 1, 0x04, 0, 50, 0])
    expect([...t.subarray(142, 148)]).toEqual([2, 4, 0, 0x82, 3000 & 0xff, 3000 >> 8])
    expect([...t.subarray(148, 154)]).toEqual([0, 0, 0, 0, 0, 0])
    expect([...t.subarray(154, 160)]).toEqual([1, 3, 0x21, 0, 100, 0])
  })

  it('alarm types: union of the relay events + forced lock + fire (as the vendor software)', () => {
    const t = table({
      relays: [
        relay({ events: ExpansionEvent.OpenTooLong }),
        relay({ events: ExpansionEvent.InvalidCard }),
        { ...INACTIVE_RELAY },
        { ...INACTIVE_RELAY },
      ],
      doorOpenTooLong: 25,
      duressCode: null,
    })
    expect(t[Param.AlarmEvents]).toBe(0x02 | 0x10 | 0x08 | 0x20)
    expect(t[Param.RecordAlarmEvents]).toBe(1)
  })

  it('open-too-long time in tenths of a second on bytes 35 + 162', () => {
    const t = table({ relays: allInactive(), doorOpenTooLong: 30, duressCode: null })
    expect(t[Param.DoorOpenTooLong]).toBe(300 & 0xff)
    expect(t[Param.DoorOpenTooLongHigh]).toBe(300 >> 8)
  })

  it('ARM source: events cleared, ARM bit and vendor defaults (126, 30 s, 30 s)', () => {
    const writes = expansionBoardParameters({
      relays: [
        relay({ source: ExpansionSource.Arm, events: ExpansionEvent.ForcedOpen }),
        { ...INACTIVE_RELAY },
        { ...INACTIVE_RELAY },
        { ...INACTIVE_RELAY },
      ],
      doorOpenTooLong: 25,
      duressCode: null,
    })
    const v = Object.fromEntries(writes.map((w) => [w.index, w.value]))
    expect(v[136]).toBe(16)
    expect(v[138]).toBe(0)
    expect(v[Param.AlarmEvents]! & 0x40).toBe(0x40)
    expect([v[Param.ArmMode], v[Param.ArmDelay], v[Param.DisarmDelay]]).toEqual([126, 30, 30])
  })

  it('without ARM the ARM parameters and, without duress code, bytes 74/75/163 are not written', () => {
    const idx = expansionBoardParameters({ relays: allInactive(), doorOpenTooLong: 25, duressCode: null }).map(
      (w) => w.index,
    )
    for (const i of [45, 46, 47, 74, 75, 163]) expect(idx).not.toContain(i)
  })

  it('duress code on 3 bytes (74, 75, 163)', () => {
    const t = table({ relays: allInactive(), doorOpenTooLong: 25, duressCode: 889988 })
    expect(t[74]! | (t[75]! << 8) | (t[163]! << 16)).toBe(889988)
  })

  it('writes are sorted by index and only touch the known bytes', () => {
    const writes = expansionBoardParameters({ relays: allInactive(), doorOpenTooLong: 25, duressCode: 1 })
    const idx = writes.map((w) => w.index)
    expect(idx).toEqual([...idx].sort((a, b) => a - b))
    const allowed = new Set([
      30,
      32,
      35,
      45,
      46,
      47,
      74,
      75,
      162,
      163,
      ...Array.from({ length: 24 }, (_, i) => 136 + i),
    ])
    for (const i of idx) expect(allowed.has(i)).toBe(true)
  })

  it('all-inactive configuration: 24 relay bytes at zero + alarm parameters (4 packets max)', () => {
    const writes = expansionBoardParameters({ relays: allInactive(), doorOpenTooLong: 25, duressCode: null })
    expect(writes.filter((w) => w.index >= 136 && w.index < 160).every((w) => w.value === 0)).toBe(true)
    expect(chunkParameters(writes).length).toBeLessThanOrEqual(4)
  })

  it('validation', () => {
    const bad =
      (r: Partial<ExpansionRelay>, extra: Partial<ExpansionBoardConfig> = {}) =>
      () =>
        expansionBoardParameters({
          relays: [relay(r), { ...INACTIVE_RELAY }, { ...INACTIVE_RELAY }, { ...INACTIVE_RELAY }],
          doorOpenTooLong: 25,
          duressCode: null,
          ...extra,
        })
    expect(bad({ source: 4 })).toThrow(CodecError)
    expect(bad({ mode: 0 })).toThrow(CodecError)
    expect(bad({ mode: 6 })).toThrow(CodecError)
    expect(bad({ events: 0x40 })).toThrow(CodecError)
    expect(bad({ signals: 256 })).toThrow(CodecError)
    expect(bad({ duration: 6554 })).toThrow(CodecError)
    expect(bad({}, { doorOpenTooLong: 0 })).toThrow(CodecError)
    expect(bad({}, { duressCode: 1_000_000 })).toThrow(CodecError)
    // an inactive relay is not validated (zeros are written)
    expect(bad({ active: false, source: 99 })).not.toThrow()
  })

  it('property: decodeExpansionBoard is the inverse of expansionBoardParameters', () => {
    const relayArb = fc.oneof(
      fc.constant({ ...INACTIVE_RELAY }),
      fc.record({
        active: fc.constant(true),
        source: fc.constantFrom(0, 1, 2, 3),
        mode: fc.integer({ min: 1, max: 5 }),
        events: fc.integer({ min: 0, max: 0x3f }),
        signals: fc.integer({ min: 0, max: 0xff }),
        duration: fc.integer({ min: 0, max: 6553 }),
      }),
    )
    fc.assert(
      fc.property(
        fc.tuple(relayArb, relayArb, relayArb, relayArb),
        fc.integer({ min: 1, max: 6553 }),
        fc.integer({ min: 0, max: 999999 }),
        (relays, ajar, duress) => {
          const cfg: ExpansionBoardConfig = {
            relays: relays as Quad<ExpansionRelay>,
            doorOpenTooLong: ajar,
            duressCode: duress,
          }
          expect(decodeExpansionBoard(table(cfg))).toEqual(cfg)
        },
      ),
    )
  })
})

describe('compareExpansionBoard', () => {
  it('no difference on the written table, the changed byte otherwise', () => {
    const cfg: ExpansionBoardConfig = {
      relays: [
        relay({ events: ExpansionEvent.ForcedOpen }),
        { ...INACTIVE_RELAY },
        { ...INACTIVE_RELAY },
        { ...INACTIVE_RELAY },
      ],
      doorOpenTooLong: 25,
      duressCode: null,
    }
    const t = table(cfg)
    expect(compareExpansionBoard(cfg, t)).toEqual([])
    t[138] = 0x01
    expect(compareExpansionBoard(cfg, t)).toEqual([{ index: 138, expected: 0x04, actual: 0x01 }])
  })
})
