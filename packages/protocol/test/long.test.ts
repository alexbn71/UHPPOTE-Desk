/**
 * Vendor long-packet protocol: CRC-16/ARC, the parameter table read and the status of the vendor console.
 * The expected requests are the ones sent by the vendor software (Wireshark captures, firmware v9.f8).
 */
import { describe, expect, it } from 'vitest'
import {
  ANY_CONTROLLER,
  CodecError,
  crc16arc,
  decodeLongStatusReply,
  decodeReadParametersReply,
  encodeLongStatusReply,
  encodeReadLongStatus,
  encodeReadParameters,
  encodeReadParametersReply,
  isReadParametersReply,
  longPacketCrcOk,
  PARAMETER_TABLE_SIZE,
} from '../src/index.js'

describe('long-packet protocol', () => {
  it('read request is byte-identical to the vendor software (broadcast, xid 1 and 2)', () => {
    expect(encodeReadParameters(ANY_CONTROLLER, 1).toString('hex')).toBe('241062e80100000000000000ffffffff00810200')
    expect(encodeReadParameters(ANY_CONTROLLER, 2).toString('hex')).toBe('241022190200000000000000ffffffff00810200')
  })

  it('CRC-16/ARC check value', () => {
    expect(crc16arc(Buffer.from('123456789'))).toBe(0xbb3d)
  })

  it('request addressed to one controller', () => {
    const b = encodeReadParameters(425050067, 7)
    expect(b.length).toBe(20)
    expect(b.readUInt32LE(12)).toBe(425050067)
    expect(longPacketCrcOk(b)).toBe(true)
  })

  it('reply: round trip, CRC and validation', () => {
    const table = new Uint8Array(PARAMETER_TABLE_SIZE).map((_, i) => i & 0xff)
    const reply = encodeReadParametersReply(425050067, 9, table)
    expect(reply.length).toBe(1044)
    expect(isReadParametersReply(reply)).toBe(true)
    const d = decodeReadParametersReply(reply)
    expect(d).toMatchObject({ controller: 425050067, xid: 9 })
    expect([...d.table]).toEqual([...table])
    const corrupted = Buffer.from(reply)
    corrupted[500] = corrupted[500]! ^ 0xff
    expect(isReadParametersReply(corrupted)).toBe(false)
    expect(() => decodeReadParametersReply(corrupted)).toThrow(CodecError)
    expect(isReadParametersReply(reply.subarray(0, 64))).toBe(false)
  })

  it('rejects a table of the wrong size', () => {
    expect(() => encodeReadParametersReply(1, 1, new Uint8Array(10))).toThrow(CodecError)
  })

  it('status request is byte-identical to the vendor console (capture 010, xid 0x66)', () => {
    expect(encodeReadLongStatus(425050067, 0x66).toString('hex')).toBe(
      '20201bbd6600000000000000d3bf551900810200ffffffff0f000000',
    )
  })

  it('decodes real status replies: at rest, and during a fire alarm with output 4 on (capture 010)', () => {
    // 20:30:03, nothing active: doors 2-4 have no sensor (reported open)
    const rest = decodeLongStatusReply(
      Buffer.from(
        '2021dea666000000d3bf551900000000a1090200261021032030050062c806000000000000904c00a301000001000000' +
          '0000000000000000e000800000000000a20100006d9fa6000000000055356ca208000000a10100006d9fa60000000000' +
          '553541a208000000a00100006d9fa600000000005535f6a1080000009f0100006d9fa600000000005535d4a108000000' +
          '9e010000fdf4f700000000005535c1a1080000009d010000fdf4f700000000005535a2a1080000009c010000fdf4f700' +
          '00000000553595a1000000009b010000b7c0bb0000000000553536a1089200009a010000b7c0bb0000000000553535a1' +
          '0892000099010000b7c0bb0000000000553535a108920000000000000000000000000000000000000000000000000000' +
          '000000000000000000000000010000000000000000000000000000000000400000000000000000000000000000000000' +
          '00000000000000000000809e55353c900000300e50080000',
        'hex',
      ),
    )
    expect(rest).toMatchObject({
      controller: 425050067,
      lastEventIndex: 419,
      doorOpen: [false, true, true, true],
      relayUnlocked: [false, false, false, false],
      expansionOutputs: [false, false, false, false],
      expansionFireInput: false,
      // inputs A1-A3 not wired: normally closed contacts open
      expansionInputs: [true, true, true],
      fireAlarm: false,
    })
    // 20:31:03, fire input of the board active: doors released, output 4 (fire, 20 s) on
    const fire = decodeLongStatusReply(
      Buffer.from(
        '2021d51a72000000d3bf55190000000057090200261021032031050021d406000000000000904c00a401000001000000' +
          '0000000000000000e00f080000000000a301000056000000000000005535dda302800000a20100006d9fa60000000000' +
          '55356ca208000000a10100006d9fa60000000000553541a208000000a00100006d9fa600000000005535f6a108000000' +
          '9f0100006d9fa600000000005535d4a1080000009e010000fdf4f700000000005535c1a1080000009d010000fdf4f700' +
          '000000005535a2a1080000009c010000fdf4f70000000000553595a1000000009b010000b7c0bb0000000000553536a1' +
          '089200009a010000b7c0bb0000000000553535a108920000000000000000000000000000000000000000000000000000' +
          '000000000000000000000000010000000000000000000000000000000000400000000000000000000000000000000000' +
          '00000000000000000000829e55353c900000300e50080000',
        'hex',
      ),
    )
    expect(fire).toMatchObject({
      lastEventIndex: 420,
      relayUnlocked: [true, true, true, true],
      expansionOutputs: [false, false, false, true],
      expansionFireInput: true,
      expansionInputs: [true, true, true],
      fireAlarm: true,
    })
  })

  it('status reply round trip', () => {
    const status = {
      controller: 425050067,
      lastEventIndex: 1234,
      doorOpen: [true, false, false, true] as [boolean, boolean, boolean, boolean],
      buttonPressed: [false, true, false, false] as [boolean, boolean, boolean, boolean],
      relayUnlocked: [true, false, false, false] as [boolean, boolean, boolean, boolean],
      expansionOutputs: [false, true, true, false] as [boolean, boolean, boolean, boolean],
      expansionFireInput: false,
      expansionInputs: [false, true, false] as [boolean, boolean, boolean],
      fireAlarm: false,
      forceLock: true,
    }
    expect(decodeLongStatusReply(encodeLongStatusReply(9, status))).toEqual({ ...status, xid: 9 })
  })

  it('inputs A1-A3 of the board: bits 4-6 of byte 58, set at rest (probe 2026-10-22: A1 bridged to GND → 0x90)', () => {
    const base = {
      controller: 425050067,
      lastEventIndex: 1,
      doorOpen: [false, false, false, false] as [boolean, boolean, boolean, boolean],
      buttonPressed: [false, false, false, false] as [boolean, boolean, boolean, boolean],
      relayUnlocked: [false, false, false, false] as [boolean, boolean, boolean, boolean],
      expansionOutputs: [false, false, false, false] as [boolean, boolean, boolean, boolean],
      expansionFireInput: false,
      fireAlarm: false,
      forceLock: false,
    }
    // A1 closed (at rest), A2 and A3 open; output 3 on
    const a1 = encodeLongStatusReply(1, {
      ...base,
      expansionOutputs: [false, false, true, false],
      expansionInputs: [false, true, true],
    })
    expect(a1[58]).toBe(0x94)
    expect(encodeLongStatusReply(1, { ...base, expansionInputs: [true, true, true] })[58]).toBe(0x80)
    expect(encodeLongStatusReply(1, { ...base, expansionInputs: [false, false, false] })[58]).toBe(0xf0)
  })
})
