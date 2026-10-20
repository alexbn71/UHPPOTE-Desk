import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { PresenceDto } from '@uhppote-desk/shared'
import { requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'
import { toCsv } from '../util/csv.js'
import { requestTranslator } from '../util/lang.js'
import { localDate, localDateTime } from '../util/time.js'

const querySchema = z.object({
  /** 'today' (default) = since midnight, otherwise the last N hours. */
  period: z.union([z.literal('today'), z.coerce.number().int().min(1).max(168)]).default('today'),
})

interface Row {
  personId: number
  name: string
  department: string | null
  card: number
  plate: string | null
  door: string
  timestamp: string
  inside: number
}

/**
 * Persons inside: for every person, the last granted card swipe in the period on a door that counts for
 * presence. Inside if it was on an entry door (and not an exit reader), outside if on an exit door or an exit
 * reader (direction 2, two-reader doors).
 */
export function presence(ctx: AppContext, period: 'today' | number, now = new Date()): PresenceDto {
  const since =
    period === 'today' ? `${localDate(now)} 00:00:00` : localDateTime(new Date(now.getTime() - period * 3_600_000))
  const rows = ctx.db.all<Row>(
    `WITH accesses AS (
       SELECT e.person_id, e.card, NULL AS plate, e.timestamp, e.direction, d.presence, d.name AS door_name, e.id
       FROM events e
       JOIN doors d ON d.controller_id = e.controller_id AND d.door = e.door
       WHERE e.person_id IS NOT NULL AND e.granted = 1 AND e.type = 1 AND e.timestamp >= ? AND d.presence != 'none'
       UNION ALL
       -- vehicles let in by a plate reader (the reader direction is the door's)
       SELECT r.person_id, 0, r.plate, r.at, 1, d.presence, d.name, r.id
       FROM plate_reads r
       JOIN doors d ON d.id = r.door_id
       WHERE r.person_id IS NOT NULL AND r.opened = 1 AND r.at >= ? AND d.presence != 'none'
     ),
     last AS (
       SELECT a.*, ROW_NUMBER() OVER (PARTITION BY a.person_id ORDER BY a.timestamp DESC, a.id DESC) AS rn
       FROM accesses a
     )
     SELECT p.id AS personId, TRIM(p.last_name || ' ' || p.first_name) AS name, dep.name AS department,
            l.card, l.plate, l.door_name AS door, l.timestamp,
            CASE WHEN l.presence = 'entry' AND l.direction != 2 THEN 1 ELSE 0 END AS inside
     FROM last l
     JOIN people p ON p.id = l.person_id AND p.active = 1
     LEFT JOIN departments dep ON dep.id = p.department_id
     WHERE l.rn = 1
     ORDER BY name`,
    [since, since],
  )
  const doors = ctx.db.get<{ entry: number; exit: number }>(
    `SELECT COALESCE(SUM(presence = 'entry'), 0) AS entry, COALESCE(SUM(presence = 'exit'), 0) AS exit
     FROM doors d JOIN controllers c ON c.id = d.controller_id WHERE d.active = 1 AND c.enabled = 1`,
  )
  return {
    since,
    inside: rows.filter((r) => r.inside === 1).map(({ inside: _inside, ...r }) => r),
    leftCount: rows.filter((r) => r.inside === 0).length,
    entryDoors: doors?.entry ?? 0,
    exitDoors: doors?.exit ?? 0,
  }
}

export function registerPresenceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }

  app.get('/presence', viewer, async (req) => presence(ctx, querySchema.parse(req.query).period))

  app.get('/presence/export.csv', viewer, async (req, reply) => {
    const { period } = querySchema.parse(req.query)
    const p = presence(ctx, period)
    const tr = requestTranslator(req)
    const h = (k: string) => tr.t(`csv.presence.${k}`)
    const csv = toCsv([
      ['person', 'department', 'card', 'door', 'since'].map(h),
      ...p.inside.map((r) => [r.name, r.department ?? '', r.plate ?? r.card, r.door, r.timestamp]),
    ])
    ctx.audit.log(req.user, 'export-presence', null, { rows: p.inside.length })
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="presence-${localDate()}.csv"`)
      .send(csv)
  })
}
