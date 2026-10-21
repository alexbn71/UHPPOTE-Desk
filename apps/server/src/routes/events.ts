import type { FastifyInstance } from 'fastify'
import type { WsMessage } from '@uhppote-desk/shared'
import { eventQuerySchema } from '@uhppote-desk/shared'
import { requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'
import { toCsv } from '../util/csv.js'
import { localDateTime } from '../util/time.js'
import { requestTranslator } from '../util/lang.js'

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }

  const filter = (query: unknown) => {
    const q = eventQuerySchema.parse(query)
    return { ...q, granted: q.granted === undefined ? undefined : q.granted === 'true' }
  }

  app.get('/events', viewer, async (req) => ctx.events.query(filter(req.query)))

  app.get('/events/stats', viewer, async () => ctx.events.stats(localDateTime()))

  app.get('/events/export.csv', viewer, async (req, reply) => {
    const { lang: _lang, ...query } = req.query as Record<string, unknown>
    const f = filter(query)
    const tr = requestTranslator(req)
    const h = (k: string) => tr.t(`csv.events.${k}`)
    const { rows } = ctx.events.query({ ...f, limit: 100_000, offset: 0 })
    const csv = toCsv([
      ['time', 'controller', 'door', 'type', 'direction', 'card', 'person', 'outcome', 'reason', 'index'].map(h),
      ...rows.map((e) => [
        e.timestamp,
        e.controllerName,
        e.doorName ?? e.door,
        tr.eventType(e.type),
        tr.direction(e.direction),
        e.card || '',
        e.personName,
        e.granted ? h('granted') : h('denied'),
        tr.reason(e.reason),
        e.index,
      ]),
    ])
    ctx.audit.log(req.user, 'export-events', null, { rows: rows.length })
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="events-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv)
  })

  /** WebSocket for the live monitor (events, door state, synchronisation progress). */
  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!req.user) {
      socket.close(4401, 'Autenticazione richiesta')
      return
    }
    // like requireRole: nothing before the forced password change or two-factor setup
    if (req.user.mustChangePassword || req.user.mustSetupTotp) {
      socket.close(4403, 'Forbidden')
      return
    }
    const send = (msg: WsMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
    }
    for (const state of ctx.hub.allStates()) send({ type: 'status', state })
    ctx.hub.on('message', send)
    const ping = setInterval(() => socket.ping(), 30_000)
    socket.on('close', () => {
      clearInterval(ping)
      ctx.hub.off('message', send)
    })
  })
}
