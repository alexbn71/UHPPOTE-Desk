import type { FastifyInstance } from 'fastify'
import { idParam, notificationInputSchema } from '@uhppote-desk/shared'
import { HttpError, requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'
import { maskChannel } from '../db/notifications.js'

export function registerNotificationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { preHandler: requireRole('admin') }

  const existing = (id: number) => {
    const c = ctx.notifications.get(id)
    if (!c) throw new HttpError(404, 'notFound')
    return c
  }
  // the configuration holds credentials: only the channel type and the non-secret settings are audited
  const auditDetails = (b: { name: string; enabled: boolean; events: string[]; doorIds: number[]; dailyReport: boolean; config: { type: string } }) => ({
    name: b.name,
    type: b.config.type,
    enabled: b.enabled,
    events: b.events,
    doorIds: b.doorIds,
    dailyReport: b.dailyReport,
  })

  app.get('/notifications', admin, async () => ctx.notifications.list().map(maskChannel))

  app.post('/notifications', admin, async (req) => {
    const b = notificationInputSchema.parse(req.body)
    const id = ctx.notifications.create(b)
    ctx.audit.log(req.user, 'create-notification', `notification:${id}`, auditDetails(b))
    ctx.notificationService.refresh()
    return maskChannel(ctx.notifications.get(id)!)
  })

  app.put('/notifications/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    existing(id)
    const b = notificationInputSchema.parse(req.body)
    ctx.notifications.update(id, b)
    ctx.audit.log(req.user, 'update-notification', `notification:${id}`, auditDetails(b))
    ctx.notificationService.refresh()
    return maskChannel(ctx.notifications.get(id)!)
  })

  app.delete('/notifications/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const c = existing(id)
    ctx.notifications.delete(id)
    ctx.audit.log(req.user, 'delete-notification', `notification:${id}`, { name: c.name, type: c.config.type })
    ctx.notificationService.refresh()
    return { ok: true }
  })

  app.post('/notifications/:id/test', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    existing(id)
    return ctx.notificationService.test(id)
  })

  app.post('/notifications/:id/report', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    existing(id)
    return ctx.notificationService.sendReport(id)
  })
}
