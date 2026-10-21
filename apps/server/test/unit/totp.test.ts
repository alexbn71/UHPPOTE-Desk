import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateSecret,
  hashRecoveryCode,
  hotp,
  otpauthUri,
  verifyTotp,
} from '../../src/auth/totp.js'

// RFC 6238 appendix B: SHA-1 secret "12345678901234567890", 8 digits; the 6-digit codes are the last 6 digits
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

describe('TOTP', () => {
  it('base32 round trip', () => {
    const buf = Buffer.from('any bytes \x00\xff here')
    expect(base32Decode(base32Encode(buf))).toEqual(buf)
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
    expect(base32Decode('mzxw 6ytb-oi==')).toEqual(Buffer.from('foobar'))
  })

  it('matches the RFC 6238 test vectors', () => {
    for (const [seconds, code] of RFC_VECTORS) {
      expect(hotp(RFC_SECRET, Math.floor(seconds / 30))).toBe(code.slice(2))
      expect(verifyTotp(RFC_SECRET, code.slice(2), 0, seconds * 1000)).toBe(Math.floor(seconds / 30))
    }
  })

  it('accepts one step of drift, refuses older steps and reused codes', () => {
    const secret = generateSecret()
    const now = 1_700_000_000_000
    const step = Math.floor(now / 30_000)
    expect(verifyTotp(secret, hotp(secret, step - 1), 0, now)).toBe(step - 1)
    expect(verifyTotp(secret, hotp(secret, step + 1), 0, now)).toBe(step + 1)
    expect(verifyTotp(secret, hotp(secret, step - 2), 0, now)).toBeNull()
    // already used: lastStep = step
    expect(verifyTotp(secret, hotp(secret, step), step, now)).toBeNull()
    expect(verifyTotp(secret, '12345', 0, now)).toBeNull()
    expect(verifyTotp(secret, `${hotp(secret, step).slice(0, 3)} ${hotp(secret, step).slice(3)}`, 0, now)).toBe(step)
  })

  it('builds the otpauth address and recovery codes', () => {
    expect(otpauthUri('ABC', 'admin', 'UHPPOTE Desk')).toBe(
      'otpauth://totp/UHPPOTE%20Desk%3Aadmin?secret=ABC&issuer=UHPPOTE%20Desk&algorithm=SHA1&digits=6&period=30',
    )
    const code = generateRecoveryCode()
    expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/)
    expect(hashRecoveryCode(code.toUpperCase().replace(/-/g, ' '))).toBe(hashRecoveryCode(code))
  })
})
