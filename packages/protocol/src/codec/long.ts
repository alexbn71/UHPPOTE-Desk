/**
 * The vendor's older "long packet" protocol, used here to read the controller parameter table (the 64-byte
 * protocol has no read command for it) and the status of the vendor console (expansion board outputs).
 * Reconstructed from the vendor software and verified on a UT0311 with firmware v9.f8: parameter table request
 * type 0x24 / code 0x10 (20 bytes), reply type 0x24 / code 0x11 (20-byte header + the 1024-byte table).
 *
 * Header (20 bytes, little-endian): 0 type, 1 code, 2-3 CRC-16/ARC of the whole packet with these two bytes at 0,
 * 4-7 transaction id (echoed), 8-11 sender serial (0 from the PC), 12-15 recipient serial (0xFFFFFFFF = any),
 * 16 return code, 17 driver version (0x81 from the PC), 18 protocol (2), 19 reserved.
 */
import { CodecError } from '../errors.js'
import { PARAMETER_TABLE_SIZE } from './expansion.js'
import type { Quad } from './messages.js'

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

// --- status (vendor "monitor") ----------------------------------------------------------------------------

/**
 * Status request of the vendor console ("Monitor"): type 0x20 / code 0x20 (28 bytes: header + 0xFFFFFFFF + 15, as
 * the vendor sends it), reply type 0x20 / code 0x21 (360 bytes: status, the latest event records, inputs). Unlike
 * the 64-byte status it reports the expansion board outputs and its fire input. Offsets are from the start of the
 * reply; verified on a UT0311-L04 (fw v9.f8) with a UT0311-01A board (capture 010, 2026-10-21).
 */
export const LongStatusPacket = { Type: 0x20, Request: 0x20, Reply: 0x21 } as const
export const LONG_STATUS_REQUEST_SIZE = 28
export const LONG_STATUS_REPLY_SIZE = 360
export const LongStatusOffset = {
  /** Last event index, uint32 LE. */
  LastEventIndex: 40,
  /** Bits 0-3 push buttons of doors 1-4, bits 4-7 door sensors (1 = open). */
  DoorInputs: 56,
  /** Bits 0-3 lock relays of doors 1-4 (1 = unlocked). */
  Locks: 57,
  /** Bits 0-3 expansion board outputs 1-4 (1 = on); bit 7 = board fire input idle (0 = fire). */
  Expansion: 58,
  /** Inputs: bit 0 force lock, bit 1 fire alarm (like the 64-byte status inputs byte). */
  Inputs: 346,
} as const

export interface LongStatus {
  controller: number
  lastEventIndex: number
  doorOpen: Quad<boolean>
  buttonPressed: Quad<boolean>
  relayUnlocked: Quad<boolean>
  /** Outputs 1-4 of the expansion board. */
  expansionOutputs: Quad<boolean>
  /** The fire input of the expansion board is active. */
  expansionFireInput: boolean
  fireAlarm: boolean
  forceLock: boolean
}

const quadBits = (v: number, shift = 0) => [0, 1, 2, 3].map((i) => (v & (1 << (i + shift))) !== 0) as Quad<boolean>
const bitsOf = (q: Quad<boolean>, shift = 0) => q.reduce((acc, on, i) => (on ? acc | (1 << (i + shift)) : acc), 0)

export function encodeReadLongStatus(controller: number, xid: number): Buffer {
  if (!Number.isInteger(controller) || controller < 0 || controller > 0xffffffff) {
    throw new CodecError(`invalid controller serial number: ${controller}`)
  }
  const b = Buffer.alloc(LONG_STATUS_REQUEST_SIZE)
  b[0] = LongStatusPacket.Type
  b[1] = LongStatusPacket.Request
  b.writeUInt32LE(xid >>> 0, 4)
  b.writeUInt32LE(controller, 12)
  b[17] = 0x81
  b[18] = 2
  b.writeUInt32LE(0xffffffff, 20)
  b.writeUInt32LE(15, 24)
  return withCrc(b)
}

/** Reply to encodeReadLongStatus, as the controller builds it (used by the FakeController and the tests). */
export function encodeLongStatusReply(xid: number, s: LongStatus): Buffer {
  const b = Buffer.alloc(LONG_STATUS_REPLY_SIZE)
  b[0] = LongStatusPacket.Type
  b[1] = LongStatusPacket.Reply
  b.writeUInt32LE(xid >>> 0, 4)
  b.writeUInt32LE(s.controller, 8)
  b[17] = 0x09
  b[18] = 2
  b.writeUInt32LE(s.lastEventIndex >>> 0, LongStatusOffset.LastEventIndex)
  b[LongStatusOffset.DoorInputs] = bitsOf(s.buttonPressed) | bitsOf(s.doorOpen, 4)
  b[LongStatusOffset.Locks] = bitsOf(s.relayUnlocked)
  b[LongStatusOffset.Expansion] = bitsOf(s.expansionOutputs) | (s.expansionFireInput ? 0 : 0x80)
  b[LongStatusOffset.Inputs] = 0x80 | (s.forceLock ? 0x01 : 0) | (s.fireAlarm ? 0x02 : 0)
  return withCrc(b)
}

export function isLongStatusReply(buf: Buffer): boolean {
  return (
    buf.length >= LONG_STATUS_REPLY_SIZE &&
    buf[0] === LongStatusPacket.Type &&
    buf[1] === LongStatusPacket.Reply &&
    longPacketCrcOk(buf)
  )
}

export function decodeLongStatusReply(buf: Buffer): LongStatus & { xid: number } {
  if (!isLongStatusReply(buf)) throw new CodecError('invalid status reply (type, code, size or CRC)')
  const doorInputs = buf[LongStatusOffset.DoorInputs]!
  const expansion = buf[LongStatusOffset.Expansion]!
  const inputs = buf[LongStatusOffset.Inputs]!
  return {
    controller: buf.readUInt32LE(8),
    xid: buf.readUInt32LE(4),
    lastEventIndex: buf.readUInt32LE(LongStatusOffset.LastEventIndex),
    buttonPressed: quadBits(doorInputs),
    doorOpen: quadBits(doorInputs, 4),
    relayUnlocked: quadBits(buf[LongStatusOffset.Locks]!),
    expansionOutputs: quadBits(expansion),
    expansionFireInput: (expansion & 0x80) === 0,
    fireAlarm: (inputs & 0x02) !== 0,
    forceLock: (inputs & 0x01) !== 0,
  }
}
