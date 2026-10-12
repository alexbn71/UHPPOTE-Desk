import type { FastifyInstance } from 'fastify'
import { idParam, ruleInputSchema } from '@uhppote-desk/shared'
import { HttpError, requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'

export function registerRuleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { preHandler: requireRole('admin') }

  const existing = (id: number) => {
    const r = ctx.rules.get(id)
    if (!r) throw new HttpError(404, 'notFound')
    return r
  }

  app.get('/rules', admin, async () => ctx.rules.list())

  app.post('/rules', admin, async (req) => {
    const b = ruleInputSchema.parse(req.body)
    const id = ctx.rules.create(b)
    ctx.audit.log(req.user, 'create-rule', `rule:${id}`, b)
    return ctx.rules.get(id)
  })

  app.put('/rules/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    existing(id)
    const b = ruleInputSchema.parse(req.body)
    ctx.rules.update(id, b)
    ctx.audit.log(req.user, 'update-rule', `rule:${id}`, b)
    return ctx.rules.get(id)
  })

  app.delete('/rules/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const r = existing(id)
    ctx.rules.delete(id)
    ctx.audit.log(req.user, 'delete-rule', `rule:${id}`, { name: r.name })
    return { ok: true }
  })

  app.get('/rules/:id/runs', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    existing(id)
    return ctx.rules.runs(id)
  })
}
