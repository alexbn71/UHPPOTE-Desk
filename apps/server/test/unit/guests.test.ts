import { describe, expect, it } from 'vitest'
import { guestStatus } from '../../src/services/guests.js'

const ALL = [true, true, true, true, true, true, true]
const base = {
  validFrom: '2026-10-01 00:00',
  validTo: '2026-12-31 23:59',
  weekdays: ALL,
  timeFrom: null,
  timeTo: null,
  maxOpens: null,
  locked: false,
  revokedAt: null,
  opens: 0,
}

describe('guestStatus', () => {
  it('follows the validity period (end excluded)', () => {
    expect(guestStatus(base, '2026-09-30 23:59:59')).toBe('notYet')
    expect(guestStatus(base, '2026-10-01 00:00:00')).toBe('active')
    expect(guestStatus(base, '2026-12-31 23:58:59')).toBe('active')
    expect(guestStatus(base, '2026-12-31 23:59:00')).toBe('expired')
  })

  it('checks the weekdays (Monday first) and the daily window', () => {
    // every Tuesday 9:00–12:00; 2026-10-20 is a Tuesday
    const tuesday = {
      ...base,
      weekdays: [false, true, false, false, false, false, false],
      timeFrom: '09:00',
      timeTo: '12:00',
    }
    expect(guestStatus(tuesday, '2026-10-20 08:59:00')).toBe('outsideHours')
    expect(guestStatus(tuesday, '2026-10-20 09:00:00')).toBe('active')
    expect(guestStatus(tuesday, '2026-10-20 11:59:00')).toBe('active')
    expect(guestStatus(tuesday, '2026-10-20 12:00:00')).toBe('outsideHours')
    expect(guestStatus(tuesday, '2026-10-21 10:00:00')).toBe('outsideHours')
  })

  it('handles windows across midnight and up to 24:00', () => {
    const night = { ...base, timeFrom: '22:00', timeTo: '06:00' }
    expect(guestStatus(night, '2026-10-20 23:30:00')).toBe('active')
    expect(guestStatus(night, '2026-10-21 05:59:00')).toBe('active')
    expect(guestStatus(night, '2026-10-21 12:00:00')).toBe('outsideHours')
    const evening = { ...base, timeFrom: '18:00', timeTo: '24:00' }
    expect(guestStatus(evening, '2026-10-20 23:59:00')).toBe('active')
    expect(guestStatus(evening, '2026-10-20 17:59:00')).toBe('outsideHours')
  })

  it('revoked, expired and used up win over the lock and the hours', () => {
    expect(guestStatus({ ...base, revokedAt: '2026-10-02 10:00:00', locked: true }, '2026-10-20 10:00:00')).toBe(
      'revoked',
    )
    expect(guestStatus({ ...base, maxOpens: 2, opens: 2, locked: true }, '2026-10-20 10:00:00')).toBe('used')
    expect(guestStatus({ ...base, maxOpens: 2, opens: 1 }, '2026-10-20 10:00:00')).toBe('active')
    expect(guestStatus({ ...base, locked: true }, '2026-10-20 10:00:00')).toBe('locked')
  })
})
