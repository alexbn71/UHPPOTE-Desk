import { describe, expect, it } from 'vitest'
import { computeAttendance, workDayOf, type ShiftRule } from '../../src/services/attendance.js'
import { italianHolidays } from '../../src/routes/attendance.js'

const dayShift: ShiftRule = {
  startTime: '08:30',
  endTime: '17:30',
  breakMinutes: 60,
  toleranceMinutes: 10,
  weekdays: [true, true, true, true, true, false, false],
}

const nightShift: ShiftRule = {
  startTime: '22:00',
  endTime: '06:00',
  breakMinutes: 30,
  toleranceMinutes: 5,
  weekdays: [true, true, true, true, true, true, true],
}

const person = (shift: ShiftRule | null) => [{ id: 1, name: 'Rossi Mario', shift }]
const punch = (timestamp: string) => ({ personId: 1, timestamp, direction: null, source: 'controller' as const })

// 2026-10-12 is a Monday
describe('computeAttendance', () => {
  it('regular day with an unpunched break', () => {
    const [d] = computeAttendance({
      from: '2026-10-12',
      to: '2026-10-12',
      people: person(dayShift),
      punches: [punch('2026-10-12 08:25:00'), punch('2026-10-12 17:35:00')],
      holidays: new Map(),
      leaves: [],
    })
    expect(d).toMatchObject({
      status: 'presente',
      firstIn: '08:25',
      lastOut: '17:35',
      expectedMinutes: 480,
      workedMinutes: 490, // 550 - 60 of break
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 10,
    })
  })

  it('punched break: no automatic deduction', () => {
    const [d] = computeAttendance({
      from: '2026-10-12',
      to: '2026-10-12',
      people: person(dayShift),
      punches: ['08:30', '12:30', '13:30', '17:30'].map((t) => punch(`2026-10-12 ${t}:00`)),
      holidays: new Map(),
      leaves: [],
    })
    expect(d!.workedMinutes).toBe(480)
    expect(d!.punches).toHaveLength(4)
  })

  it('late beyond the tolerance and early exit', () => {
    const [d] = computeAttendance({
      from: '2026-10-12',
      to: '2026-10-12',
      people: person(dayShift),
      punches: [punch('2026-10-12 08:45:00'), punch('2026-10-12 17:00:00')],
      holidays: new Map(),
      leaves: [],
    })
    expect(d!.lateMinutes).toBe(15)
    expect(d!.earlyLeaveMinutes).toBe(30)
  })

  it('lateness within the tolerance ignored', () => {
    const [d] = computeAttendance({
      from: '2026-10-12',
      to: '2026-10-12',
      people: person(dayShift),
      punches: [punch('2026-10-12 08:39:00'), punch('2026-10-12 17:30:00')],
      holidays: new Map(),
      leaves: [],
    })
    expect(d!.lateMinutes).toBe(0)
  })

  it('single punch = anomaly', () => {
    const [d] = computeAttendance({
      from: '2026-10-12',
      to: '2026-10-12',
      people: person(dayShift),
      punches: [punch('2026-10-12 08:30:00')],
      holidays: new Map(),
      leaves: [],
    })
    expect(d!.status).toBe('anomalia')
    expect(d!.anomalies).toContain('singlePunch')
    expect(d!.workedMinutes).toBe(0)
  })

  it('absent, rest day, holiday, leave', () => {
    const days = computeAttendance({
      from: '2026-10-12',
      to: '2026-10-18',
      people: person(dayShift),
      punches: [],
      holidays: new Map([['2026-10-13', 'Festa patronale']]),
      leaves: [{ personId: 1, fromDate: '2026-10-14', toDate: '2026-10-15', type: 'ferie' }],
    })
    expect(days.map((d) => d.status)).toEqual(['assente', 'festivo', 'ferie', 'ferie', 'assente', 'riposo', 'riposo'])
    expect(days.find((d) => d.date === '2026-10-13')!.expectedMinutes).toBe(0)
  })

  it('work on a rest day = all overtime', () => {
    const [d] = computeAttendance({
      from: '2026-10-17',
      to: '2026-10-17',
      people: person(dayShift),
      punches: [punch('2026-10-17 09:00:00'), punch('2026-10-17 12:00:00')],
      holidays: new Map(),
      leaves: [],
    })
    expect(d!.expectedMinutes).toBe(0)
    expect(d!.overtimeMinutes).toBe(180)
  })

  it('night shift across midnight', () => {
    expect(workDayOf('2026-10-13 05:55:00', nightShift)).toBe('2026-10-12')
    expect(workDayOf('2026-10-12 21:55:00', nightShift)).toBe('2026-10-12')
    const [d] = computeAttendance({
      from: '2026-10-12',
      to: '2026-10-12',
      people: person(nightShift),
      punches: [punch('2026-10-12 21:58:00'), punch('2026-10-13 06:02:00')],
      holidays: new Map(),
      leaves: [],
    })
    expect(d).toMatchObject({
      status: 'presente',
      firstIn: '21:58',
      lastOut: '06:02',
      expectedMinutes: 450,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
    })
    expect(d!.workedMinutes).toBe(484 - 30)
  })

  it('person without a shift: worked hours only', () => {
    const [d] = computeAttendance({
      from: '2026-10-12',
      to: '2026-10-12',
      people: person(null),
      punches: [punch('2026-10-12 10:00:00'), punch('2026-10-12 12:00:00')],
      holidays: new Map(),
      leaves: [],
    })
    expect(d).toMatchObject({ status: 'presente', workedMinutes: 120, expectedMinutes: 0, overtimeMinutes: 120 })
  })
})

describe('Italian public holidays', () => {
  it('Easter and Easter Monday computed correctly', () => {
    const h2026 = italianHolidays(2026)
    expect(h2026.find((h) => h.key === 'easter')!.date).toBe('2026-04-05')
    expect(h2026.find((h) => h.key === 'easterMonday')!.date).toBe('2026-04-06')
    expect(italianHolidays(2027).find((h) => h.key === 'easter')!.date).toBe('2027-03-28')
    expect(h2026).toHaveLength(12)
  })
})
