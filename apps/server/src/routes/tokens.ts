import type { FastifyInstance } from 'fastify'
import { apiTokenInputSchema, idParam } from '@uhppote-desk/shared'
import { HttpError, requireSession } from '../auth/auth.js'
import type { AppContext } from '../context.js'

/** API token management: administrators logged in with a password only, never with a token. */
export function registerTokenRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { preHandler: requireSession('admin') }

  const existing = (id: number) => {
    const t = ctx.tokens.get(id)
    if (!t) throw new HttpError(404, 'notFound')
    return t
  }

  app.get('/tokens', admin, async () => ctx.tokens.list())

  /** The token is returned only here, once. */
  app.post('/tokens', admin, async (req) => {
    const b = apiTokenInputSchema.parse(req.body)
    const created = ctx.tokens.create(b, req.user!.username)
    ctx.audit.log(req.user, 'create-token', `token:${created.apiToken.id}`, { ...b, prefix: created.apiToken.prefix })
    return created
  })

  app.put('/tokens/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    existing(id)
    const b = apiTokenInputSchema.parse(req.body)
    ctx.tokens.update(id, b)
    ctx.audit.log(req.user, 'update-token', `token:${id}`, b)
    return ctx.tokens.get(id)
  })

  app.delete('/tokens/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const t = existing(id)
    ctx.tokens.delete(id)
    ctx.audit.log(req.user, 'delete-token', `token:${id}`, { name: t.name, prefix: t.prefix })
    return { ok: true }
  })
}
