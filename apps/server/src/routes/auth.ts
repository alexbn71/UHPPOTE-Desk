import type { FastifyInstance } from 'fastify'
import { changePasswordSchema, idParam, loginSchema, operatorInputSchema } from '@uhppote-desk/shared'
import { HttpError, requireRole, SESSION_COOKIE } from '../auth/auth.js'
import { randomPassword } from '../auth/password.js'
import type { AppContext } from '../context.js'

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const failures = new Map<string, { count: number; until: number }>()

  app.post('/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body)
    const key = `${req.ip}|${body.username.toLowerCase()}`
    const f = failures.get(key)
    if (f && f.until > Date.now()) throw new HttpError(429, 'tooManyAttempts')

    const result = await ctx.auth.login(body.username, body.password, req.ip, req.headers['user-agent'] ?? '')
    if (!result) {
      const count = (f?.count ?? 0) + 1
      failures.set(key, { count, until: count >= 5 ? Date.now() + 5 * 60_000 : 0 })
      ctx.audit.log(null, 'login-failed', `operator:${body.username}`, { ip: req.ip })
      throw new HttpError(401, 'invalidCredentials')
    }
    failures.delete(key)
    ctx.audit.log(result.user, 'login', `operator:${result.user.username}`, { ip: req.ip })
    reply.setCookie(SESSION_COOKIE, result.sessionId, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.config.secureCookies,
      maxAge: ctx.config.sessionHours * 3600,
    })
    return { user: result.user }
  })

  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE]
    if (sid) ctx.auth.logout(sid)
    if (req.user) ctx.audit.log(req.user, 'logout', `operator:${req.user.username}`)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/auth/me', async (req) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated')
    return { user: req.user }
  })

  app.post('/auth/password', async (req) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated')
    const body = changePasswordSchema.parse(req.body)
    ctx.auth.assertPasswordChangeable(req.user.id)
    const ok = await ctx.auth.changePassword(req.user.id, body.currentPassword, body.newPassword)
    if (!ok) throw new HttpError(400, 'wrongPassword')
    ctx.auth.revokeSessions(req.user.id, req.cookies[SESSION_COOKIE])
    ctx.audit.log(req.user, 'change-password', `operator:${req.user.username}`)
    return { ok: true }
  })

  // --- operator management (admin only) --------------------------------------

  const admin = { preHandler: requireRole('admin') }

  app.get('/operators', admin, async () => ctx.auth.listOperators())

  app.post('/operators', admin, async (req) => {
    const body = operatorInputSchema.parse(req.body)
    const password = body.password ?? randomPassword(12)
    const id = ctx.db.tx(() => {
      const id = ctx.db.run(
        'INSERT INTO operators (username, display_name, password_hash, role, active, must_change_password) VALUES (?, ?, ?, ?, ?, 1)',
        [body.username, body.displayName, 'pending', body.role, body.active ? 1 : 0],
      ).lastInsertRowid
      for (const z of body.zoneIds) ctx.db.run('INSERT INTO operator_zones (operator_id, zone_id) VALUES (?, ?)', [id, z])
      return id
    })
    await ctx.auth.setPassword(id, password, true)
    ctx.audit.log(req.user, 'create-operator', `operator:${body.username}`, { role: body.role })
    return { id, password: body.password ? undefined : password }
  })

  app.put('/operators/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const body = operatorInputSchema.parse(req.body)
    if (id === req.user!.id && (body.role !== 'admin' || !body.active)) {
      throw new HttpError(400, 'selfDemote')
    }
    ctx.db.tx(() => {
      ctx.db.run('UPDATE operators SET username = ?, display_name = ?, role = ?, active = ? WHERE id = ?', [
        body.username,
        body.displayName,
        body.role,
        body.active ? 1 : 0,
        id,
      ])
      ctx.db.run('DELETE FROM operator_zones WHERE operator_id = ?', [id])
      for (const z of body.zoneIds) ctx.db.run('INSERT INTO operator_zones (operator_id, zone_id) VALUES (?, ?)', [id, z])
    })
    if (body.password) {
      ctx.auth.assertPasswordChangeable(id)
      await ctx.auth.setPassword(id, body.password, true)
    }
    if (!body.active) ctx.auth.revokeSessions(id)
    ctx.audit.log(req.user, 'update-operator', `operator:${body.username}`, { role: body.role, active: body.active })
    return { ok: true }
  })

  app.post('/operators/:id/reset-password', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    ctx.auth.assertPasswordChangeable(id)
    const password = randomPassword(12)
    await ctx.auth.setPassword(id, password, true)
    ctx.auth.revokeSessions(id)
    ctx.audit.log(req.user, 'reset-password', `operator:${id}`)
    return { password }
  })

  app.delete('/operators/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    if (id === req.user!.id) throw new HttpError(400, 'selfDelete')
    ctx.db.run('DELETE FROM operators WHERE id = ?', [id])
    ctx.audit.log(req.user, 'delete-operator', `operator:${id}`)
    return { ok: true }
  })

  app.get('/audit', admin, async (req) => {
    const q = req.query as { limit?: string; offset?: string; action?: string; operatorId?: string }
    return ctx.audit.query({
      limit: Math.min(Number(q.limit ?? 100), 1000),
      offset: Number(q.offset ?? 0),
      action: q.action,
      operatorId: q.operatorId ? Number(q.operatorId) : undefined,
    })
  })
}
