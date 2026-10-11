import type { FastifyInstance } from 'fastify'
import type { WsMessage } from '@uhppote-desk/shared'
import { DIRECTION_LABELS, EVENT_TYPE_LABELS, eventQuerySchema, reasonLabel } from '@uhppote-desk/shared'
import { requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'
import { toCsv } from '../util/csv.js'

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }

  const filter = (query: unknown) => {
    const q = eventQuerySchema.parse(query)
    return { ...q, granted: q.granted === undefined ? undefined : q.granted === 'true' }
  }

  app.get('/events', viewer, async (req) => ctx.events.query(filter(req.query)))

  app.get('/events/export.csv', viewer, async (req, reply) => {
    const f = filter(req.query)
    const { rows } = ctx.events.query({ ...f, limit: 100_000, offset: 0 })
    const csv = toCsv([
      ['Data/ora', 'Controller', 'Porta', 'Tipo', 'Direzione', 'Tessera', 'Persona', 'Esito', 'Motivo', 'Indice'],
      ...rows.map((e) => [
        e.timestamp,
        e.controllerName,
        e.doorName ?? e.door,
        EVENT_TYPE_LABELS[e.type] ?? e.type,
        DIRECTION_LABELS[e.direction] ?? '',
        e.card || '',
        e.personName,
        e.granted ? 'Consentito' : 'Negato',
        reasonLabel(e.reason),
        e.index,
      ]),
    ])
    ctx.audit.log(req.user, 'export-events', null, { rows: rows.length })
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="eventi-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv)
  })

  /** WebSocket per il monitor in tempo reale (eventi, stato porte, avanzamento sincronizzazioni). */
  app.get('/ws', { websocket: true }, (socket, req) => {
    if (!req.user) {
      socket.close(4401, 'Autenticazione richiesta')
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
