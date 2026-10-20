import { describe, expect, it } from 'vitest'
import { normalizePlate, plateMatchKey, plateReadings } from '@uhppote-desk/shared'
import type { TimeProfileRecord } from '../../src/db/repos.js'
import { profileAllows } from '../../src/services/plates.js'

describe('plate text', () => {
  it('normalises to upper-case letters and digits', () => {
    expect(normalizePlate(' gw-422 sx ')).toBe('GW422SX')
  })

  it('matches readings that confuse look-alike characters', () => {
    expect(plateMatchKey('AB123CD')).toBe(plateMatchKey('A8123CD'))
    expect(plateMatchKey('ZO001IS')).toBe(plateMatchKey('20001I5'))
    expect(plateMatchKey('AB123CD')).not.toBe(plateMatchKey('AB123CE'))
  })

  it('splits the readings and drops labels and noise', () => {
    expect(plateReadings('car, AB123CD;GW-422SX | person AB123CD x1')).toEqual(['AB123CD', 'GW422SX'])
    expect(plateReadings('')).toEqual([])
  })
})

describe('profileAllows', () => {
  const week = [true, true, true, true, true, false, false]
  const profiles: TimeProfileRecord[] = [
    {
      id: 2,
      name: 'Office',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      weekdays: week,
      segments: [
        { start: '08:00', end: '12:30' },
        { start: '14:00', end: '18:00' },
        { start: '00:00', end: '00:00' },
      ],
      linkedTo: 3,
    },
    {
      id: 3,
      name: 'Saturday morning',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      weekdays: [false, false, false, false, false, true, false],
      segments: [{ start: '09:00', end: '12:00' }],
      linkedTo: 2,
    },
  ]

  it('checks weekdays and segments, both ends included', () => {
    // 2026-10-20 is a Tuesday
    expect(profileAllows(profiles, 2, '2026-10-20 08:00:00')).toBe(true)
    expect(profileAllows(profiles, 2, '2026-10-20 12:30:59')).toBe(true)
    expect(profileAllows(profiles, 2, '2026-10-20 13:00:00')).toBe(false)
    // an unused segment (00:00-00:00) allows nothing
    expect(profileAllows(profiles, 2, '2026-10-20 00:00:00')).toBe(false)
  })

  it('follows the linked profile, without looping', () => {
    // Saturday: not in "Office", allowed by the linked "Saturday morning"
    expect(profileAllows(profiles, 2, '2026-10-24 10:00:00')).toBe(true)
    // Sunday: neither (2 → 3 → 2 stops)
    expect(profileAllows(profiles, 2, '2026-10-25 10:00:00')).toBe(false)
  })

  it('respects the validity dates and missing profiles', () => {
    expect(profileAllows(profiles, 2, '2027-01-05 10:00:00')).toBe(false)
    expect(profileAllows(profiles, 99, '2026-10-20 10:00:00')).toBe(false)
  })
})
