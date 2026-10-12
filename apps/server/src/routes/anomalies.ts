import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { anomalyPeriodSchema, anomalySettingsSchema } from '@uhppote-desk/shared'
import { requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'

export function registerAnomalyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }
  const operator = { preHandler: requireRole('operator') }
  const admin = { preHandler: requireRole('admin') }

  const period = (query: unknown) => {
    const q = anomalyPeriodSchema.parse(query)
    return { from: `${q.from} 00:00:00`, to: `${q.to} 23:59:59` }
  }

  app.get('/anomalies/unusual', viewer, async (req) => {
    const p = period(req.query)
    return ctx.anomalies.unusualAccesses(p.from, p.to)
  })

  app.get('/anomalies/denied', viewer, async (req) => {
    const p = period(req.query)
    return ctx.anomalies.deniedBursts(p.from, p.to)
  })

  app.get('/anomalies/inactive-cards', viewer, async () => ctx.anomalies.inactiveCards())

  app.get('/anomalies/settings', viewer, async () => ctx.anomalies.settings())

  app.put('/anomalies/settings', admin, async (req) => {
    const s = anomalySettingsSchema.parse(req.body)
    ctx.anomalies.saveSettings(s)
    ctx.audit.log(req.user, 'update-anomaly-settings', null, s)
    return s
  })

  /** Disables the given cards (only those still active) and removes them from the controllers. */
  app.post('/anomalies/inactive-cards/disable', operator, async (req) => {
    const { cardIds } = z.object({ cardIds: z.array(z.number().int().positive()).min(1).max(1000) }).parse(req.body)
    const disabled: number[] = []
    const pushErrors: { controllerId: number; error: string }[] = []
    for (const id of cardIds) {
      const card = ctx.people.card(id)
      if (!card || card.status !== 'active') continue
      ctx.people.updateCard(id, card.personId, 'disabled')
      ctx.audit.log(req.user, 'disable-inactive-card', `card:${card.number}`, { personId: card.personId })
      disabled.push(card.number)
      const results = await ctx.sync.pushPerson(req.user, card.personId, [card.number])
      for (const r of results) if (r.error) pushErrors.push({ controllerId: r.controllerId, error: r.error })
    }
    return { disabled: disabled.length, pushErrors }
  })
}
