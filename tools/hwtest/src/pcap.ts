/**
 * Analysis of Wireshark captures of UHPPOTE traffic (see pcap-cli.ts): reconstructs what was written to the
 * controller parameter table — with 0xF2 (UHPPOTE Desk) or with the vendor long-packet write (type 0x24 code 0x20,
 * table + update mask) — and the last table read back from the controller.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  decodeExpansionBoard,
  expansionBoardParameters,
  isReadParametersReply,
  LONG_HEADER_SIZE,
  FunctionCode,
  PARAMETER_ADDRESS_OFFSET,
  PARAMETER_TABLE_SIZE,
  type ExpansionBoardConfig,
  type ParameterWrite,
} from '@uhppote-desk/protocol'

const exec = promisify(execFile)

const FUNCTION_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(FunctionCode).map(([name, code]) => [code, name]),
)

export interface CapturedPacket {
  frame: number
  time: number
  src: string
  srcPort: number
  dst: string
  dstPort: number
  payload: Buffer
}

export interface PcapAnalysis {
  packets: number
  /** 64-byte packets per function code and direction. */
  functions: { code: string; name: string; requests: number; replies: number; events: number }[]
  /** Packets of the vendor's long-packet protocol (size ≠ 64). */
  longPackets: { length: number; type: string; code: string; count: number }[]
  /** Parameter writes in capture order (0xF2 or vendor long write), with the controller answer when found. */
  writes: { frame: number; serial: number; index: number; value: number; ok: boolean | null; via: '0xF2' | 'long' }[]
  /** Parameter table image after all the writes (null = never written). */
  table: (number | null)[]
  /** Expansion board decoded from the written bytes (null if no relay byte was written). */
  expansion: ExpansionBoardConfig | null
  /** Last parameter table read from the controller (long-packet read reply), and its expansion board. */
  lastRead: { frame: number; serial: number; expansion: ExpansionBoardConfig; alarmEvents: number } | null
  comparison?: {
    missing: ParameterWrite[]
    different: { index: number; expected: number; captured: number }[]
    extra: number[]
  }
}

export async function readCapture(file: string, tshark = defaultTshark()): Promise<CapturedPacket[]> {
  const { stdout } = await exec(
    tshark,
    [
      '-r',
      file,
      '-Y',
      'udp.port == 60000 || udp.port == 60001',
      '-T',
      'fields',
      '-E',
      'separator=;',
      '-e',
      'frame.number',
      '-e',
      'frame.time_relative',
      '-e',
      'ip.src',
      '-e',
      'udp.srcport',
      '-e',
      'ip.dst',
      '-e',
      'udp.dstport',
      '-e',
      'udp.payload',
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  )
  return stdout
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const [frame, time, src, srcPort, dst, dstPort, hex] = line.split(';')
      return {
        frame: Number(frame),
        time: Number(time),
        src: src ?? '',
        srcPort: Number(srcPort),
        dst: dst ?? '',
        dstPort: Number(dstPort),
        payload: Buffer.from((hex ?? '').replaceAll(':', ''), 'hex'),
      }
    })
    .filter((p) => p.payload.length > 0)
}

const hex2 = (n: number) => `0x${n.toString(16).padStart(2, '0')}`

/** `listenerPort`: UDP port of the event listener (packets sent there are events, not replies). */
export function analyse(
  packets: CapturedPacket[],
  expected?: ExpansionBoardConfig,
  listenerPort = 60001,
): PcapAnalysis {
  const functions = new Map<number, { requests: number; replies: number; events: number }>()
  const long = new Map<string, { length: number; type: string; code: string; count: number }>()
  const writes: PcapAnalysis['writes'] = []
  const pendingF2: PcapAnalysis['writes'][] = []
  const pendingLong: PcapAnalysis['writes'][] = []
  const table: (number | null)[] = new Array(PARAMETER_TABLE_SIZE).fill(null)
  let lastRead: PcapAnalysis['lastRead'] = null

  for (const pkt of packets) {
    const b = pkt.payload
    if (b.length !== 64 || (b[0] !== 0x17 && b[0] !== 0x19)) {
      // vendor long write: header, 1024-byte table, 128-byte mask of the bytes to update
      if (b[0] === 0x24 && b[1] === 0x20 && b.length >= LONG_HEADER_SIZE + PARAMETER_TABLE_SIZE + 128) {
        const batch: PcapAnalysis['writes'] = []
        for (let i = 0; i < PARAMETER_TABLE_SIZE; i++) {
          if (!(b[LONG_HEADER_SIZE + PARAMETER_TABLE_SIZE + (i >> 3)]! & (1 << (i & 7)))) continue
          const w = {
            frame: pkt.frame,
            serial: b.readUInt32LE(12),
            index: i,
            value: b[LONG_HEADER_SIZE + i]!,
            ok: null,
            via: 'long' as const,
          }
          batch.push(w)
          writes.push(w)
          table[i] = w.value
        }
        pendingLong.push(batch)
      } else if (b[0] === 0x24 && b[1] === 0x21) {
        const batch = pendingLong.shift()
        if (batch) for (const w of batch) w.ok = true
      } else if (isReadParametersReply(b)) {
        const image = Uint8Array.from(b.subarray(LONG_HEADER_SIZE, LONG_HEADER_SIZE + PARAMETER_TABLE_SIZE))
        lastRead = {
          frame: pkt.frame,
          serial: b.readUInt32LE(8),
          expansion: decodeExpansionBoard(image),
          alarmEvents: image[32]!,
        }
      }
      const key = `${b.length}/${b[0]}/${b[1]}`
      const entry = long.get(key) ?? { length: b.length, type: hex2(b[0] ?? 0), code: hex2(b[1] ?? 0), count: 0 }
      entry.count++
      long.set(key, entry)
      continue
    }
    const fc = b[1]!
    const stats = functions.get(fc) ?? { requests: 0, replies: 0, events: 0 }
    const request = pkt.dstPort === 60000
    const event = !request && pkt.dstPort === listenerPort
    const reply = !request && !event
    if (request) stats.requests++
    else if (event) stats.events++
    else stats.replies++
    functions.set(fc, stats)

    if (fc !== FunctionCode.WriteParameters) continue
    if (request) {
      const batch: PcapAnalysis['writes'] = []
      for (let k = 0; k < 8; k++) {
        const address = b.readUInt16LE(12 + 3 * k)
        if (address === 0) continue
        const index = address - PARAMETER_ADDRESS_OFFSET
        const w = {
          frame: pkt.frame,
          serial: b.readUInt32LE(4),
          index,
          value: b[14 + 3 * k]!,
          ok: null as boolean | null,
          via: '0xF2' as const,
        }
        batch.push(w)
        writes.push(w)
        if (index >= 0 && index < PARAMETER_TABLE_SIZE) table[index] = w.value
      }
      pendingF2.push(batch)
    } else if (reply) {
      const batch = pendingF2.shift()
      if (batch) for (const w of batch) w.ok = b[8] === 1
    }
  }

  const relayWritten = table.slice(136, 160).some((v) => v !== null)
  const image = Uint8Array.from(table.map((v) => v ?? 0))
  const result: PcapAnalysis = {
    packets: packets.length,
    functions: [...functions.entries()]
      .sort(([a], [b]) => a - b)
      .map(([code, s]) => ({ code: hex2(code), name: FUNCTION_NAMES[code] ?? '?', ...s })),
    longPackets: [...long.values()],
    writes,
    table,
    expansion: relayWritten ? decodeExpansionBoard(image) : null,
    lastRead,
  }
  // the duress code is optional: not written ≠ 0
  if (result.expansion && table[74] === null && table[75] === null && table[163] === null)
    result.expansion.duressCode = null

  if (expected) {
    const want = expansionBoardParameters(expected)
    const wanted = new Set(want.map((w) => w.index))
    result.comparison = {
      missing: want.filter((w) => table[w.index] === null),
      different: want
        .filter((w) => table[w.index] !== null && table[w.index] !== w.value)
        .map((w) => ({ index: w.index, expected: w.value, captured: table[w.index]! })),
      extra: table.flatMap((v, i) => (v !== null && !wanted.has(i) ? [i] : [])),
    }
  }
  return result
}

export function defaultTshark(): string {
  if (process.env.TSHARK) return process.env.TSHARK
  return process.platform === 'win32' ? 'C:\\Program Files\\Wireshark\\tshark.exe' : 'tshark'
}

/** Accepts the `expansionBoard` settings object (with `installed`) or a protocol ExpansionBoardConfig. */
export function toConfig(json: unknown): ExpansionBoardConfig {
  const o = json as { expansionBoard?: unknown }
  const x = (o.expansionBoard ?? json) as ExpansionBoardConfig
  return { relays: x.relays, doorOpenTooLong: x.doorOpenTooLong, duressCode: x.duressCode ?? null }
}
