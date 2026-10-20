import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  attendanceQuerySchema,
  holidayInputSchema,
  idParam,
  leaveInputSchema,
  manualPunchInputSchema,
  shiftInputSchema,
} from '@uhppote-desk/shared'
import { HttpError, requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'
import { weekdaysFromString, weekdaysToString } from '../db/database.js'
import { computeAttendance, type Leave, type Punch } from '../services/attendance.js'
import { toCsv } from '../util/csv.js'
import { requestTranslator } from '../util/lang.js'
import { addDays } from '../util/time.js'

interface ShiftRow {
  id: number
  name: string
  start_time: string
  end_time: string
  break_minutes: number
  tolerance_minutes: number
  weekdays: string
}

export function registerAttendanceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }
  const operator = { preHandler: requireRole('operator') }

  const shifts = () =>
    ctx.db.all<ShiftRow>('SELECT * FROM shifts ORDER BY name').map((s) => ({
      id: s.id,
      name: s.name,
      startTime: s.start_time,
      endTime: s.end_time,
      breakMinutes: s.break_minutes,
      toleranceMinutes: s.tolerance_minutes,
      weekdays: weekdaysFromString(s.weekdays),
    }))

  // --- shifts ----------------------------------------------------------------

  app.get('/shifts', viewer, async () => shifts())
  app.post('/shifts', operator, async (req) => {
    const b = shiftInputSchema.parse(req.body)
    const id = ctx.db.run(
      'INSERT INTO shifts (name, start_time, end_time, break_minutes, tolerance_minutes, weekdays) VALUES (?, ?, ?, ?, ?, ?)',
      [b.name, b.startTime, b.endTime, b.breakMinutes, b.toleranceMinutes, weekdaysToString(b.weekdays)],
    ).lastInsertRowid
    ctx.audit.log(req.user, 'create-shift', `shift:${id}`, b)
    return { id }
  })
  app.put('/shifts/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = shiftInputSchema.parse(req.body)
    ctx.db.run(
      'UPDATE shifts SET name = ?, start_time = ?, end_time = ?, break_minutes = ?, tolerance_minutes = ?, weekdays = ? WHERE id = ?',
      [b.name, b.startTime, b.endTime, b.breakMinutes, b.toleranceMinutes, weekdaysToString(b.weekdays), id],
    )
    ctx.audit.log(req.user, 'update-shift', `shift:${id}`, b)
    return { ok: true }
  })
  app.delete('/shifts/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    ctx.db.run('DELETE FROM shifts WHERE id = ?', [id])
    ctx.audit.log(req.user, 'delete-shift', `shift:${id}`)
    return { ok: true }
  })

  // --- holidays --------------------------------------------------------------

  app.get('/holidays', viewer, async () => ctx.db.all('SELECT date, name FROM holidays ORDER BY date'))
  app.post('/holidays', operator, async (req) => {
    const b = holidayInputSchema.parse(req.body)
    ctx.db.run('INSERT INTO holidays (date, name) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET name = excluded.name', [
      b.date,
      b.name,
    ])
    ctx.audit.log(req.user, 'save-holiday', `holiday:${b.date}`, b)
    return { ok: true }
  })
  app.delete('/holidays/:date', operator, async (req) => {
    const { date } = z.object({ date: z.string() }).parse(req.params)
    ctx.db.run('DELETE FROM holidays WHERE date = ?', [date])
    ctx.audit.log(req.user, 'delete-holiday', `holiday:${date}`)
    return { ok: true }
  })
  /** Italian public holidays for a year (fixed dates + Easter Monday), named in the request language. */
  app.post('/holidays/italian/:year', operator, async (req) => {
    const { year } = z.object({ year: z.coerce.number().int().min(2000).max(2100) }).parse(req.params)
    const tr = requestTranslator(req)
    const list = italianHolidays(year)
    for (const h of list)
      ctx.db.run('INSERT OR IGNORE INTO holidays (date, name) VALUES (?, ?)', [h.date, tr.t(`holidays.${h.key}`)])
    ctx.audit.log(req.user, 'import-holidays', `year:${year}`, { count: list.length })
    return { added: list.length }
  })

  // --- absences --------------------------------------------------------------

  app.get('/leaves', viewer, async (req) => {
    const q = z.object({ personId: z.coerce.number().int().optional() }).parse(req.query)
    return ctx.db.all(
      `SELECT l.id, l.person_id AS personId, TRIM(p.last_name || ' ' || p.first_name) AS personName, l.from_date AS fromDate,
              l.to_date AS toDate, l.type, l.notes
       FROM leaves l JOIN people p ON p.id = l.person_id ${q.personId ? 'WHERE l.person_id = ?' : ''} ORDER BY l.from_date DESC`,
      q.personId ? [q.personId] : [],
    )
  })
  app.post('/leaves', operator, async (req) => {
    const b = leaveInputSchema.parse(req.body)
    const id = ctx.db.run('INSERT INTO leaves (person_id, from_date, to_date, type, notes) VALUES (?, ?, ?, ?, ?)', [
      b.personId,
      b.fromDate,
      b.toDate,
      b.type,
      b.notes,
    ]).lastInsertRowid
    ctx.audit.log(req.user, 'create-leave', `leave:${id}`, b)
    return { id }
  })
  app.delete('/leaves/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    ctx.db.run('DELETE FROM leaves WHERE id = ?', [id])
    ctx.audit.log(req.user, 'delete-leave', `leave:${id}`)
    return { ok: true }
  })

  // --- manual punches --------------------------------------------------------

  app.get('/punches', viewer, async (req) => {
    const q = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query)
    return ctx.db.all(
      `SELECT m.id, m.person_id AS personId, TRIM(p.last_name || ' ' || p.first_name) AS personName, m.timestamp, m.direction,
              m.reason, o.username AS operator
       FROM manual_punches m JOIN people p ON p.id = m.person_id LEFT JOIN operators o ON o.id = m.operator_id
       WHERE m.timestamp BETWEEN ? AND ? ORDER BY m.timestamp DESC`,
      [q.from ?? '0000', `${q.to ?? '9999'} 23:59:59`],
    )
  })
  app.post('/punches', operator, async (req) => {
    const b = manualPunchInputSchema.parse(req.body)
    const ts = b.timestamp.length === 16 ? `${b.timestamp}:00` : b.timestamp
    const id = ctx.db.run(
      'INSERT INTO manual_punches (person_id, timestamp, direction, reason, operator_id) VALUES (?, ?, ?, ?, ?)',
      [b.personId, ts, b.direction, b.reason, req.user!.id],
    ).lastInsertRowid
    ctx.audit.log(req.user, 'create-punch', `punch:${id}`, b)
    return { id }
  })
  app.delete('/punches/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    ctx.db.run('DELETE FROM manual_punches WHERE id = ?', [id])
    ctx.audit.log(req.user, 'delete-punch', `punch:${id}`)
    return { ok: true }
  })

  // --- report ----------------------------------------------------------------

  const report = (query: unknown) => {
    const q = attendanceQuerySchema.parse(query)
    if (q.from > q.to) throw new HttpError(400, 'invalidRange')
    if (addDays(q.from, 400) < q.to) throw new HttpError(400, 'rangeTooLong')
    const shiftMap = new Map(shifts().map((s) => [s.id, s]))
    const people = ctx.people
      .list({ active: true, ...(q.departmentId ? { departmentId: q.departmentId } : {}) })
      .filter((p) => !q.personId || p.id === q.personId)
      .map((p) => ({
        id: p.id,
        name: `${p.lastName} ${p.firstName}`.trim(),
        shift: p.shiftId ? (shiftMap.get(p.shiftId) ?? null) : null,
      }))
    const ids = new Set(people.map((p) => p.id))
    // window extended by one day for night shifts
    const from = `${q.from} 00:00:00`
    const to = `${addDays(q.to, 1)} 23:59:59`
    const punches: Punch[] = [
      ...ctx.events.attendancePunches(from, to).map((p) => ({ ...p, source: 'controller' as const })),
      ...ctx.db
        .all<{
          personId: number
          timestamp: string
          direction: number
        }>('SELECT person_id AS personId, timestamp, direction FROM manual_punches WHERE timestamp BETWEEN ? AND ?', [
          from,
          to,
        ])
        .map((p) => ({ ...p, source: 'manuale' as const })),
    ].filter((p) => ids.has(p.personId))
    const holidays = new Map(
      ctx.db.all<{ date: string; name: string }>('SELECT date, name FROM holidays').map((h) => [h.date, h.name]),
    )
    const leaves = ctx.db.all<Leave>(
      'SELECT person_id AS personId, from_date AS fromDate, to_date AS toDate, type FROM leaves',
    )
    return computeAttendance({ from: q.from, to: q.to, people, punches, holidays, leaves })
  }

  const withoutLang = (query: unknown) => {
    const { lang: _lang, ...rest } = (query ?? {}) as Record<string, unknown>
    return rest
  }

  app.get('/attendance/report', viewer, async (req) => report(withoutLang(req.query)))

  app.get('/attendance/report.csv', viewer, async (req, reply) => {
    const rows = report(withoutLang(req.query))
    const tr = requestTranslator(req)
    const h = (m: number) => (m / 60).toFixed(2)
    const csv = toCsv([
      [
        'person',
        'date',
        'status',
        'in',
        'out',
        'worked',
        'expected',
        'late',
        'earlyLeave',
        'overtime',
        'punches',
        'anomalies',
      ].map((k) => tr.t(`csv.attendance.${k}`)),
      ...rows.map((r) => [
        r.personName,
        r.date,
        tr.attendanceStatus(r.status),
        r.firstIn,
        r.lastOut,
        h(r.workedMinutes),
        h(r.expectedMinutes),
        r.lateMinutes,
        r.earlyLeaveMinutes,
        h(r.overtimeMinutes),
        r.punches.map((p) => `${p.time}${p.source === 'manuale' ? '*' : ''}`).join(' '),
        r.anomalies.map((a) => tr.anomaly(a)).join(', '),
      ]),
    ])
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="attendance.csv"')
      .send(csv)
  })
}

export type HolidayKey =
  | 'newYear'
  | 'epiphany'
  | 'easter'
  | 'easterMonday'
  | 'liberation'
  | 'labour'
  | 'republic'
  | 'assumption'
  | 'allSaints'
  | 'immaculate'
  | 'christmas'
  | 'stStephen'

/** Italian public holidays (including Easter and Easter Monday); names are translation keys under `holidays.*`. */
export function italianHolidays(year: number): { date: string; key: HolidayKey }[] {
  // Gauss/Meeus algorithm for the Gregorian Easter date
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  const pad = (n: number) => String(n).padStart(2, '0')
  const easter = `${year}-${pad(month)}-${pad(day)}`
  return [
    { date: `${year}-01-01`, key: 'newYear' },
    { date: `${year}-01-06`, key: 'epiphany' },
    { date: easter, key: 'easter' },
    { date: addDays(easter, 1), key: 'easterMonday' },
    { date: `${year}-04-25`, key: 'liberation' },
    { date: `${year}-05-01`, key: 'labour' },
    { date: `${year}-06-02`, key: 'republic' },
    { date: `${year}-08-15`, key: 'assumption' },
    { date: `${year}-11-01`, key: 'allSaints' },
    { date: `${year}-12-08`, key: 'immaculate' },
    { date: `${year}-12-25`, key: 'christmas' },
    { date: `${year}-12-26`, key: 'stStephen' },
  ]
}
