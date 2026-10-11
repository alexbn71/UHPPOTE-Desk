import { CodecError } from '../errors.js'
import { PACKET_SIZE, SOM } from './constants.js'

/** 'YYYY-MM-DD' */
export type DateString = string
/** 'YYYY-MM-DD HH:mm:ss' (ora locale del controller, senza fuso) */
export type DateTimeString = string
/** 'HH:mm' */
export type TimeString = string

function bcdByte(n: number): number {
  return ((Math.floor(n / 10) % 10) << 4) | n % 10
}

function bcdDigits(buf: Buffer, offset: number, length: number): string | null {
  let s = ''
  for (let i = 0; i < length; i++) {
    const b = buf[offset + i]!
    const hi = b >>> 4
    const lo = b & 0x0f
    if (hi > 9 || lo > 9) return null
    s += `${hi}${lo}`
  }
  return s
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/
const HHMM_RE = /^(\d{1,2}):(\d{2})$/

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function parseDate(value: DateString, field = 'date'): [number, number, number] {
  const m = DATE_RE.exec(value)
  if (!m) throw new CodecError(`${field}: invalid date '${value}' (expected YYYY-MM-DD)`)
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (!isValidDate(y, mo, d)) throw new CodecError(`${field}: non-existent date '${value}'`)
  return [y, mo, d]
}

export function parseDateTime(value: DateTimeString, field = 'datetime'): [number, number, number, number, number, number] {
  const m = DATETIME_RE.exec(value)
  if (!m) throw new CodecError(`${field}: invalid date/time '${value}' (expected YYYY-MM-DD HH:mm:ss)`)
  const v = m.slice(1).map(Number) as [number, number, number, number, number, number]
  if (!isValidDate(v[0], v[1], v[2]) || v[3] > 23 || v[4] > 59 || v[5] > 59) {
    throw new CodecError(`${field}: non-existent date/time '${value}'`)
  }
  return v
}

export function parseHHmm(value: TimeString, field = 'time'): [number, number] {
  const m = HHMM_RE.exec(value)
  if (!m) throw new CodecError(`${field}: invalid time '${value}' (expected HH:mm)`)
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 24 || mi > 59 || (h === 24 && mi !== 0)) throw new CodecError(`${field}: non-existent time '${value}'`)
  return [h, mi]
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

/** Costruisce un pacchetto da 64 byte con header standard. */
export class Writer {
  readonly buf: Buffer

  constructor(functionCode: number, controller: number) {
    if (!Number.isInteger(controller) || controller < 0 || controller > 0xffffffff) {
      throw new CodecError(`invalid controller serial number: ${controller}`)
    }
    this.buf = Buffer.alloc(PACKET_SIZE)
    this.buf[0] = SOM
    this.buf[1] = functionCode
    this.buf.writeUInt32LE(controller, 4)
  }

  u8(offset: number, v: number, field = 'uint8'): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new CodecError(`${field}: value out of range (0-255): ${v}`)
    this.buf.writeUInt8(v, offset)
    return this
  }

  u16(offset: number, v: number, field = 'uint16'): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new CodecError(`${field}: value out of range (0-65535): ${v}`)
    this.buf.writeUInt16LE(v, offset)
    return this
  }

  u32(offset: number, v: number, field = 'uint32'): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new CodecError(`${field}: value out of range: ${v}`)
    this.buf.writeUInt32LE(v, offset)
    return this
  }

  bool(offset: number, v: boolean): this {
    this.buf[offset] = v ? 1 : 0
    return this
  }

  /** PIN a 3 byte little-endian (tessere). */
  pin24(offset: number, v: number, field = 'PIN'): this {
    if (!Number.isInteger(v) || v < 0 || v > 999999) throw new CodecError(`${field}: PIN out of range (0-999999): ${v}`)
    this.buf.writeUIntLE(v, offset, 3)
    return this
  }

  /** PIN a 4 byte little-endian (passcode porta). */
  pin32(offset: number, v: number, field = 'passcode'): this {
    if (!Number.isInteger(v) || v < 0 || v > 999999) throw new CodecError(`${field}: passcode out of range (0-999999): ${v}`)
    this.buf.writeUInt32LE(v, offset)
    return this
  }

  ipv4(offset: number, v: string, field = 'IPv4'): this {
    const parts = v.split('.')
    if (parts.length !== 4) throw new CodecError(`${field}: invalid address '${v}'`)
    parts.forEach((p, i) => {
      if (!/^\d{1,3}$/.test(p) || Number(p) > 255) throw new CodecError(`${field}: invalid address '${v}'`)
      this.buf[offset + i] = Number(p)
    })
    return this
  }

  /** Data BCD YYYYMMDD; null = assente (zeri). */
  date(offset: number, v: DateString | null, field = 'date'): this {
    if (v === null) return this
    const [y, m, d] = parseDate(v, field)
    this.buf[offset] = bcdByte(Math.floor(y / 100))
    this.buf[offset + 1] = bcdByte(y % 100)
    this.buf[offset + 2] = bcdByte(m)
    this.buf[offset + 3] = bcdByte(d)
    return this
  }

  datetime(offset: number, v: DateTimeString, field = 'datetime'): this {
    const [y, mo, d, h, mi, s] = parseDateTime(v, field)
    const bytes = [Math.floor(y / 100), y % 100, mo, d, h, mi, s]
    bytes.forEach((b, i) => (this.buf[offset + i] = bcdByte(b)))
    return this
  }

  hhmm(offset: number, v: TimeString, field = 'time'): this {
    const [h, m] = parseHHmm(v, field)
    this.buf[offset] = bcdByte(h)
    this.buf[offset + 1] = bcdByte(m)
    return this
  }
}

/** Lettura tipizzata di un pacchetto da 64 byte. */
export class Reader {
  constructor(readonly buf: Buffer) {}

  get functionCode(): number {
    return this.buf[1]!
  }

  get controller(): number {
    return this.buf.readUInt32LE(4)
  }

  u8(offset: number): number {
    return this.buf.readUInt8(offset)
  }

  u16(offset: number): number {
    return this.buf.readUInt16LE(offset)
  }

  u32(offset: number): number {
    return this.buf.readUInt32LE(offset)
  }

  /** Tollerante: qualsiasi valore diverso da 0 è true. */
  bool(offset: number): boolean {
    return this.buf[offset] !== 0
  }

  pin24(offset: number): number {
    return this.buf.readUIntLE(offset, 3)
  }

  ipv4(offset: number): string {
    return [0, 1, 2, 3].map((i) => this.buf[offset + i]).join('.')
  }

  mac(offset: number): string {
    return [...this.buf.subarray(offset, offset + 6)].map((b) => b.toString(16).padStart(2, '0')).join(':')
  }

  /** Versione firmware: 2 byte BCD → 'v8.92'. */
  version(offset: number): string {
    const hi = this.buf[offset]!
    const lo = this.buf[offset + 1]!
    return `v${hi.toString(16)}.${lo.toString(16).padStart(2, '0')}`
  }

  /** Data BCD YYYYMMDD; null se zero o non valida. */
  date(offset: number): DateString | null {
    const s = bcdDigits(this.buf, offset, 4)
    if (s === null || s === '00000000') return null
    const [y, m, d] = [Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8))]
    if (!isValidDate(y, m, d)) return null
    return `${pad(y, 4)}-${pad(m)}-${pad(d)}`
  }

  /** Data/ora BCD YYYYMMDDHHmmss; null se zero o non valida. */
  datetime(offset: number): DateTimeString | null {
    const s = bcdDigits(this.buf, offset, 7)
    if (s === null || /^0+$/.test(s)) return null
    const [y, mo, d, h, mi, se] = [
      Number(s.slice(0, 4)),
      Number(s.slice(4, 6)),
      Number(s.slice(6, 8)),
      Number(s.slice(8, 10)),
      Number(s.slice(10, 12)),
      Number(s.slice(12, 14)),
    ]
    if (!isValidDate(y, mo, d) || h > 23 || mi > 59 || se > 59) return null
    return `${pad(y, 4)}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(se)}`
  }

  /** Data breve BCD YYMMDD (secolo 20). */
  shortdate(offset: number): DateString | null {
    const s = bcdDigits(this.buf, offset, 3)
    if (s === null || s === '000000') return null
    const [y, m, d] = [2000 + Number(s.slice(0, 2)), Number(s.slice(2, 4)), Number(s.slice(4, 6))]
    if (!isValidDate(y, m, d)) return null
    return `${y}-${pad(m)}-${pad(d)}`
  }

  /** Ora BCD HHmmss. */
  time(offset: number): string | null {
    const s = bcdDigits(this.buf, offset, 3)
    if (s === null) return null
    return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`
  }

  hhmm(offset: number): TimeString | null {
    const s = bcdDigits(this.buf, offset, 2)
    if (s === null) return null
    return `${s.slice(0, 2)}:${s.slice(2, 4)}`
  }
}
