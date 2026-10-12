import type { FastifyInstance } from 'fastify'
import { idParam, webhookInputSchema } from '@uhppote-desk/shared'
import { HttpError, requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'
import { newWebhookSecret } from '../db/webhooks.js'

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { preHandler: requireRole('admin') }

  const existing = (id: number) => {
    const w = ctx.webhooks.get(id)
    if (!w) throw new HttpError(404, 'notFound')
    return w
  }
  // header values may hold credentials: only their names go to the audit log
  const auditDetails = (b: { name: string; url: string; enabled: boolean; events: string[]; doorIds: number[]; headers: Record<string, string> }) => ({
    name: b.name,
    url: b.url,
    enabled: b.enabled,
    events: b.events,
    doorIds: b.doorIds,
    headers: Object.keys(b.headers),
  })

  app.get('/webhooks', admin, async () => ctx.webhooks.list())

  app.post('/webhooks', admin, async (req) => {
    const b = webhookInputSchema.parse(req.body)
    const id = ctx.webhooks.create(b)
    ctx.audit.log(req.user, 'create-webhook', `webhook:${id}`, auditDetails(b))
    return ctx.webhooks.get(id)
  })

  app.put('/webhooks/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    existing(id)
    const b = webhookInputSchema.parse(req.body)
    ctx.webhooks.update(id, b)
    ctx.audit.log(req.user, 'update-webhook', `webhook:${id}`, auditDetails(b))
    return ctx.webhooks.get(id)
  })

  app.delete('/webhooks/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const w = existing(id)
    ctx.webhooks.delete(id)
    ctx.audit.log(req.user, 'delete-webhook', `webhook:${id}`, { name: w.name, url: w.url })
    return { ok: true }
  })

  app.post('/webhooks/:id/secret', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    existing(id)
    ctx.webhooks.setSecret(id, newWebhookSecret())
    ctx.audit.log(req.user, 'regenerate-webhook-secret', `webhook:${id}`)
    return ctx.webhooks.get(id)
  })

  app.post('/webhooks/:id/test', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    existing(id)
    const result = await ctx.webhookService.test(id)
    ctx.audit.log(req.user, 'test-webhook', `webhook:${id}`, { ok: result?.ok, statusCode: result?.statusCode }, result && !result.ok ? result.error : null)
    return result
  })

  app.get('/webhooks/:id/deliveries', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    existing(id)
    return ctx.webhooks.deliveries(id)
  })
}
