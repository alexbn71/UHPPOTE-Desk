/**
 * Capture analysis (npm run pcap) on synthetic packets: no tshark needed.
 */
import { describe, expect, it } from 'vitest'
import {
  encode,
  encodeReadParametersReply,
  expansionBoardParameters,
  chunkParameters,
  type ExpansionBoardConfig,
} from '@uhppote-desk/protocol'
import { analyse, toConfig, type CapturedPacket } from '../src/pcap.js'

const ID = 405419896
const CONFIG: ExpansionBoardConfig = {
  relays: [
    { active: true, source: 0, mode: 1, events: 0x14, signals: 0, duration: 20 },
    { active: true, source: 0, mode: 3, events: 0x02, signals: 0, duration: 10 },
    { active: false, source: 0, mode: 0, events: 0, signals: 0, duration: 0 },
    { active: true, source: 1, mode: 1, events: 0x20, signals: 0, duration: 300 },
  ],
  doorOpenTooLong: 30,
  duressCode: null,
}

let frame = 0
const pkt = (payload: Buffer, srcPort: number, dstPort: number): CapturedPacket => ({
  frame: ++frame,
  time: frame / 1000,
  src: '192.168.1.10',
  srcPort,
  dst: '192.168.1.100',
  dstPort,
  payload,
})
const okReply = (fc: number, ok = 1) => {
  const b = Buffer.alloc(64)
  b[0] = 0x17
  b[1] = fc
  b.writeUInt32LE(ID, 4)
  b[8] = ok
  return b
}

function capture(cfg: ExpansionBoardConfig, refuseLast = false): CapturedPacket[] {
  const chunks = chunkParameters(expansionBoardParameters(cfg))
  return chunks.flatMap((c, i) => [
    pkt(encode.writeParameters(ID, c), 50000, 60000),
    pkt(okReply(0xf2, refuseLast && i === chunks.length - 1 ? 0 : 1), 60000, 50000),
  ])
}

describe('pcap analysis', () => {
  it('reconstructs the expansion board from the 0xF2 writes', () => {
    const a = analyse(capture(CONFIG))
    expect(a.expansion).toEqual(CONFIG)
    expect(a.writes.every((w) => w.ok === true)).toBe(true)
    expect(a.functions).toEqual([{ code: '0xf2', name: 'WriteParameters', requests: 4, replies: 4, events: 0 }])
  })

  it('comparison: identical, then a different and a missing byte', () => {
    expect(analyse(capture(CONFIG), CONFIG).comparison).toEqual({ missing: [], different: [], extra: [] })
    const other = structuredClone(CONFIG)
    other.relays[0].duration = 5
    other.duressCode = 889988
    const c = analyse(capture(CONFIG), other).comparison!
    expect(c.different).toEqual([{ index: 140, expected: 50, captured: 200 }])
    expect(c.missing.map((m) => m.index)).toEqual([74, 75, 163])
  })

  it('bytes written by the capture but not by UHPPOTE Desk are reported as extra', () => {
    const packets = [...capture(CONFIG), pkt(encode.writeParameters(ID, [{ index: 41, value: 1 }]), 50000, 60000)]
    expect(analyse(packets, CONFIG).comparison!.extra).toEqual([41])
  })

  it('refused writes, events on the listener port and long packets', () => {
    const status = okReply(0x20, 0)
    const packets = [...capture(CONFIG, true), pkt(status, 60000, 60001), pkt(Buffer.alloc(1152, 0x24), 50000, 60000)]
    const a = analyse(packets)
    expect(a.writes.filter((w) => w.ok === false).length).toBeGreaterThan(0)
    expect(a.functions.find((f) => f.code === '0x20')).toMatchObject({ events: 1, replies: 0 })
    expect(a.longPackets).toEqual([{ length: 1152, type: '0x24', code: '0x24', count: 1 }])
  })

  it('vendor long write (table + update mask) and long read reply', () => {
    // long write: only the flagged bytes count
    const write = Buffer.alloc(20 + 1024 + 128)
    write[0] = 0x24
    write[1] = 0x20
    write.writeUInt32LE(ID, 12)
    for (const w of expansionBoardParameters(CONFIG)) {
      write[20 + w.index] = w.value
      write[1044 + (w.index >> 3)]! |= 1 << (w.index & 7)
    }
    write[20 + 500] = 0x99 // not flagged: ignored
    const ack = Buffer.alloc(20)
    ack[0] = 0x24
    ack[1] = 0x21
    const image = new Uint8Array(1024)
    for (const w of expansionBoardParameters(CONFIG)) image[w.index] = w.value
    const read = encodeReadParametersReply(ID, 3, image)
    const a = analyse([pkt(write, 50000, 60000), pkt(ack, 60000, 50000), pkt(read, 60000, 50000)], CONFIG)
    expect(a.writes.every((w) => w.via === 'long' && w.ok === true)).toBe(true)
    expect(a.table[500]).toBeNull()
    expect(a.expansion).toEqual(CONFIG)
    expect(a.comparison).toEqual({ missing: [], different: [], extra: [] })
    expect(a.lastRead).toMatchObject({ serial: ID, alarmEvents: 0x14 | 0x02 | 0x20 | 0x08 })
    expect(a.lastRead!.expansion.relays).toEqual(CONFIG.relays)
  })

  it('no relay byte written: no expansion board', () => {
    expect(analyse([pkt(encode.writeParameters(ID, [{ index: 2, value: 50 }]), 50000, 60000)]).expansion).toBeNull()
  })

  it('--expected accepts the settings object or a protocol configuration', () => {
    expect(toConfig({ expansionBoard: { installed: true, ...CONFIG } })).toEqual(CONFIG)
    expect(toConfig({ installed: true, ...CONFIG })).toEqual(CONFIG)
    expect(toConfig(CONFIG)).toEqual(CONFIG)
  })
})
