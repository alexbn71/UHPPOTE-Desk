import { describe, expect, it } from 'vitest'
import { anomalySettingsSchema } from '@uhppote-desk/shared'
import { circularDistance, classifyAccess, findBursts, inWindow, minuteOfDay, usualWindow } from '../../src/services/anomalies.js'

const s = anomalySettingsSchema.parse({})
const at = (hhmm: string) => minuteOfDay(hhmm)

describe('time helpers', () => {
  it('measures distances across midnight', () => {
    expect(circularDistance(at('23:50'), at('00:10'))).toBe(20)
    expect(circularDistance(at('08:00'), at('20:00'))).toBe(720)
  })

  it('checks windows that cross midnight', () => {
    expect(inWindow(at('23:00'), at('22:00'), at('06:00'))).toBe(true)
    expect(inWindow(at('05:59'), at('22:00'), at('06:00'))).toBe(true)
    expect(inWindow(at('06:00'), at('22:00'), at('06:00'))).toBe(false)
    expect(inWindow(at('12:00'), at('09:00'), at('17:00'))).toBe(true)
  })

  it('computes the usual window from the 5th to the 95th percentile', () => {
    const minutes = [...Array.from({ length: 18 }, (_, i) => at('08:00') + i), at('03:00'), at('19:00')]
    expect(usualWindow(minutes)).toEqual([at('08:00'), at('08:17')])
  })
})

describe('classifyAccess', () => {
  const morning = { minutes: Array.from({ length: 20 }, (_, i) => at('08:00') + i * 3), nonWorking: 0 }

  it('accepts accesses near the usual times', () => {
    expect(classifyAccess(at('08:30'), false, morning, s)).toBeNull()
    expect(classifyAccess(at('10:00'), false, morning, s)).toBeNull() // 63 min after the last usual time
  })

  it('flags accesses far from the usual times', () => {
    expect(classifyAccess(at('14:00'), false, morning, s)).toBe('hour')
    expect(classifyAccess(at('03:00'), false, morning, s)).toBe('hour')
  })

  it('flags non-working days for people who never came on one', () => {
    expect(classifyAccess(at('08:30'), true, morning, s)).toBe('day')
    expect(classifyAccess(at('08:30'), true, { ...morning, nonWorking: 2 }, s)).toBeNull()
  })

  it('uses only the night window without enough history', () => {
    const few = { minutes: [at('08:00'), at('08:10')], nonWorking: 0 }
    expect(classifyAccess(at('23:30'), false, few, s)).toBe('night')
    expect(classifyAccess(at('14:00'), true, few, s)).toBeNull()
  })

  it('follows the tolerance setting', () => {
    expect(classifyAccess(at('10:00'), false, morning, { ...s, toleranceMinutes: 30 })).toBe('hour')
  })
})

describe('findBursts', () => {
  const ev = (key: string, hhmm: string) => ({ key, timestamp: `2026-10-12 ${hhmm}:00` })
  const bursts = (events: ReturnType<typeof ev>[]) => findBursts(events, (e) => e.key, 3, 10).map((b) => b.map((e) => `${e.key}@${e.timestamp!.slice(11, 16)}`))

  it('needs the threshold within the window, per key', () => {
    expect(bursts([ev('a', '10:00'), ev('a', '10:04'), ev('a', '10:09'), ev('b', '10:01'), ev('b', '10:02')])).toEqual([['a@10:00', 'a@10:04', 'a@10:09']])
    expect(bursts([ev('a', '10:00'), ev('a', '10:06'), ev('a', '10:12')])).toEqual([])
  })

  it('merges overlapping windows and splits distant bursts', () => {
    const list = ['10:00', '10:03', '10:06', '10:09', '10:12', '11:00', '11:01', '11:02'].map((t) => ev('a', t))
    expect(bursts(list).map((b) => b.length)).toEqual([5, 3])
  })
})
