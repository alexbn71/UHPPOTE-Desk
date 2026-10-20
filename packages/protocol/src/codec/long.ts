/**
 * The vendor's older "long packet" protocol, used here only to read the controller parameter table
 * (the 64-byte protocol has no read command for it). Reconstructed from the vendor software and verified on a
 * UT0311 with firmware v9.f8: request type 0x24 / code 0x10 (20 bytes), reply type 0x24 / code 0x11
 * (20-byte header + the 1024-byte table).
 *
 * Header (20 bytes, little-endian): 0 type, 1 code, 2-3 CRC-16/ARC of the whole packet with these two bytes at 0,
 * 4-7 transaction id (echoed), 8-11 sender serial (0 from the PC), 12-15 recipient serial (0xFFFFFFFF = any),
 * 16 return code, 17 driver version (0x81 from the PC), 18 protocol (2), 19 reserved.
 */
import { CodecError } from '../errors.js'
import { PARAMETER_TABLE_SIZE } from './expansion.js'

export const LONG_HEADER_SIZE = 20
export const LongPacket = {
  Type: 0x24,
  ReadParameters: 0x10,
  ReadParametersReply: 0x11,
} as const
export const READ_PARAMETERS_REPLY_SIZE = LONG_HEADER_SIZE + PARAMETER_TABLE_SIZE
export const ANY_CONTROLLER = 0xffffffff

/** CRC-16/ARC (poly 0x8005 reflected, init 0), the "CRC_16_IBM" of the vendor software. */
export function crc16arc(data: Uint8Array): number {
  let crc = 0
  for (const b of data) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
  }
  return crc & 0xffff
}

function withCrc(buf: Buffer): Buffer {
  buf.writeUInt16LE(0, 2)
  buf.writeUInt16LE(crc16arc(buf), 2)
  return buf
}

/** True if the CRC in bytes 2-3 matches the packet. */
export function longPacketCrcOk(buf: Buffer): boolean {
  if (buf.length < LONG_HEADER_SIZE) return false
  const copy = Buffer.from(buf)
  copy.writeUInt16LE(0, 2)
  return crc16arc(copy) === buf.readUInt16LE(2)
}

export function encodeReadParameters(controller: number, xid: number): Buffer {
  if (!Number.isInteger(controller) || controller < 0 || controller > 0xffffffff) {
    throw new CodecError(`invalid controller serial number: ${controller}`)
  }
  const b = Buffer.alloc(LONG_HEADER_SIZE)
  b[0] = LongPacket.Type
  b[1] = LongPacket.ReadParameters
  b.writeUInt32LE(xid >>> 0, 4)
  b.writeUInt32LE(0, 8)
  b.writeUInt32LE(controller, 12)
  b[17] = 0x81
  b[18] = 2
  return withCrc(b)
}

/** Reply to encodeReadParameters, as the controller builds it (used by the FakeController and the tests). */
export function encodeReadParametersReply(controller: number, xid: number, table: Uint8Array): Buffer {
  if (table.length !== PARAMETER_TABLE_SIZE)
    throw new CodecError(`parameter table must be ${PARAMETER_TABLE_SIZE} bytes`)
  const b = Buffer.alloc(READ_PARAMETERS_REPLY_SIZE)
  b[0] = LongPacket.Type
  b[1] = LongPacket.ReadParametersReply
  b.writeUInt32LE(xid >>> 0, 4)
  b.writeUInt32LE(controller, 8)
  b[17] = 0x09
  b[18] = 2
  Buffer.from(table).copy(b, LONG_HEADER_SIZE)
  return withCrc(b)
}

export function isReadParametersReply(buf: Buffer): boolean {
  return (
    buf.length >= READ_PARAMETERS_REPLY_SIZE &&
    buf[0] === LongPacket.Type &&
    buf[1] === LongPacket.ReadParametersReply &&
    longPacketCrcOk(buf)
  )
}

export function decodeReadParametersReply(buf: Buffer): { controller: number; xid: number; table: Uint8Array } {
  if (!isReadParametersReply(buf)) throw new CodecError('invalid read-parameters reply (type, code, size or CRC)')
  return {
    controller: buf.readUInt32LE(8),
    xid: buf.readUInt32LE(4),
    table: Uint8Array.from(buf.subarray(LONG_HEADER_SIZE, READ_PARAMETERS_REPLY_SIZE)),
  }
}
