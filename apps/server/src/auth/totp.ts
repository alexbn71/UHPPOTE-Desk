import { createHash, createHmac, randomBytes } from 'node:crypto'

/** Time-based one-time passwords (RFC 6238): SHA-1, 6 digits, 30-second steps, like every authenticator app. */
const STEP_SECONDS = 30
const DIGITS = 6
/** Steps accepted before and after the current one (clock drift of the phone). */
const WINDOW = 1

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const v = BASE32.indexOf(ch)
    if (v < 0) throw new Error(`invalid base32 character '${ch}'`)
    value = (value << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** New random secret (160 bits, base32). */
export function generateSecret(): string {
  return base32Encode(randomBytes(20))
}

/** Code of a given step (RFC 4226 dynamic truncation). */
export function hotp(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS
  return String(n).padStart(DIGITS, '0')
}

export const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS)

/**
 * Checks a code against the current step ± WINDOW.
 * Returns the matching step, or null; steps not after `lastStep` are refused, so a code cannot be used twice.
 */
export function verifyTotp(secret: string, code: string, lastStep = 0, nowMs = Date.now()): number | null {
  const digits = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(digits)) return null
  const now = currentStep(nowMs)
  for (let step = now - WINDOW; step <= now + WINDOW; step++) {
    if (step > lastStep && hotp(secret, step) === digits) return step
  }
  return null
}

/** otpauth:// address for the QR code of the authenticator apps. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`
}

// --- recovery codes ------------------------------------------------------------

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** Recovery code like `k7mq-3xht-p2wd` (about 74 bits). */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(12)
  const chars = [...bytes].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length])
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)].map((g) => g.join('')).join('-')
}

/** Normalised form of a recovery code typed by the user (case, spaces and dashes ignored). */
export const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Hash of a recovery code: they are random and long, a plain SHA-256 is enough. */
export const hashRecoveryCode = (code: string) => createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex')
