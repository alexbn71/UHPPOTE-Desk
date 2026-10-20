import type { AttendanceDayDto } from '@uhppote-desk/shared'
import { addDays, minutesOf, parseLocal } from '../util/time.js'

export interface ShiftRule {
  startTime: string
  endTime: string
  breakMinutes: number
  toleranceMinutes: number
  /** Mon..Sun */
  weekdays: boolean[]
}

export interface AttendancePerson {
  id: number
  name: string
  shift: ShiftRule | null
}

export interface Punch {
  personId: number
  /** 'YYYY-MM-DD HH:mm:ss' */
  timestamp: string
  direction: number | null
  source: 'controller' | 'manuale'
}

export interface Leave {
  personId: number
  fromDate: string
  toDate: string
  type: 'ferie' | 'permesso' | 'malattia' | 'trasferta' | 'altro'
}

/** Margin (minutes) after the end of a night shift within which punches belong to the previous day. */
const NIGHT_SHIFT_GRACE = 240

function isNightShift(s: ShiftRule): boolean {
  return minutesOf(s.endTime) <= minutesOf(s.startTime)
}

function weekdayIndex(date: string): number {
  return (parseLocal(date).getDay() + 6) % 7 // Mon = 0
}

function shiftMinutes(s: ShiftRule): number {
  const start = minutesOf(s.startTime)
  let end = minutesOf(s.endTime)
  if (end <= start) end += 1440
  return Math.max(0, end - start - s.breakMinutes)
}

/** Working day a punch belongs to. */
export function workDayOf(timestamp: string, shift: ShiftRule | null): string {
  const date = timestamp.slice(0, 10)
  if (shift && isNightShift(shift)) {
    const t = minutesOf(timestamp.slice(11, 16))
    if (t < minutesOf(shift.endTime) + NIGHT_SHIFT_GRACE) return addDays(date, -1)
  }
  return date
}

/** Minutes since midnight of the working day (can exceed 1440 for night shifts). */
function minuteOfWorkDay(timestamp: string, workDay: string): number {
  const diff = (parseLocal(timestamp).getTime() - parseLocal(`${workDay} 00:00:00`).getTime()) / 60000
  return Math.round(diff)
}

const fmtTime = (ts: string) => ts.slice(11, 16)

/**
 * Computes the daily attendance summary.
 * Rules:
 * - punches are paired in chronological order (in, out, in, out…);
 * - with a single pair of punches the shift break is deducted;
 * - an odd number of punches is an anomaly (the last one is ignored in the calculation);
 * - late arrival/early exit take the shift tolerance into account.
 */
export function computeAttendance(input: {
  from: string
  to: string
  people: AttendancePerson[]
  punches: Punch[]
  holidays: Map<string, string>
  leaves: Leave[]
}): AttendanceDayDto[] {
  const byPersonDay = new Map<string, Punch[]>()
  const shiftOf = new Map(input.people.map((p) => [p.id, p.shift]))
  for (const p of input.punches) {
    const day = workDayOf(p.timestamp, shiftOf.get(p.personId) ?? null)
    const key = `${p.personId}|${day}`
    byPersonDay.set(key, [...(byPersonDay.get(key) ?? []), p])
  }

  const days: string[] = []
  for (let d = input.from; d <= input.to; d = addDays(d, 1)) days.push(d)

  const result: AttendanceDayDto[] = []
  for (const person of input.people) {
    for (const date of days) {
      const punches = (byPersonDay.get(`${person.id}|${date}`) ?? []).sort((a, b) =>
        a.timestamp.localeCompare(b.timestamp),
      )
      const leave = input.leaves.find((l) => l.personId === person.id && l.fromDate <= date && l.toDate >= date)
      const holiday = input.holidays.get(date)
      const shift = person.shift
      const scheduled = !!shift && shift.weekdays[weekdayIndex(date)] === true
      const expectedMinutes = scheduled && !holiday && !leave ? shiftMinutes(shift) : 0

      const anomalies: AttendanceDayDto['anomalies'] = []
      let worked = 0
      const pairs = Math.floor(punches.length / 2)
      for (let i = 0; i < pairs; i++) {
        worked +=
          minuteOfWorkDay(punches[2 * i + 1]!.timestamp, date) - minuteOfWorkDay(punches[2 * i]!.timestamp, date)
      }
      if (punches.length % 2 === 1) anomalies.push(punches.length === 1 ? 'singlePunch' : 'oddPunches')
      if (pairs === 1 && shift && worked > shift.breakMinutes + 240) worked -= shift.breakMinutes

      let late = 0
      let early = 0
      if (shift && expectedMinutes > 0 && punches.length > 0) {
        const start = minutesOf(shift.startTime)
        let end = minutesOf(shift.endTime)
        if (end <= start) end += 1440
        const first = minuteOfWorkDay(punches[0]!.timestamp, date)
        if (first - start > shift.toleranceMinutes) late = first - start
        if (punches.length >= 2) {
          const last = minuteOfWorkDay(punches.at(-1)!.timestamp, date)
          if (end - last > shift.toleranceMinutes) early = end - last
        }
      }

      let status: AttendanceDayDto['status']
      if (leave) status = leave.type
      else if (holiday && punches.length === 0) status = 'festivo'
      else if (punches.length === 0) status = expectedMinutes > 0 ? 'assente' : 'riposo'
      else if (anomalies.length) status = 'anomalia'
      else status = 'presente'

      result.push({
        personId: person.id,
        personName: person.name,
        date,
        status,
        firstIn: punches[0] ? fmtTime(punches[0].timestamp) : null,
        lastOut: punches.length >= 2 ? fmtTime(punches.at(-1)!.timestamp) : null,
        punches: punches.map((p) => ({ time: fmtTime(p.timestamp), direction: p.direction, source: p.source })),
        workedMinutes: worked,
        expectedMinutes,
        lateMinutes: late,
        earlyLeaveMinutes: early,
        overtimeMinutes: Math.max(0, worked - expectedMinutes),
        anomalies,
      })
    }
  }
  return result
}
