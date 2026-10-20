/**
 * Vendor long-packet protocol: CRC-16/ARC and the parameter table read.
 * The expected requests are the ones sent by the vendor software (Wireshark captures, firmware v9.f8).
 */
import { describe, expect, it } from 'vitest'
import {
  ANY_CONTROLLER,
  CodecError,
  crc16arc,
  decodeReadParametersReply,
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
})
