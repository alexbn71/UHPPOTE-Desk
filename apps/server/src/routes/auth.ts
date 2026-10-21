import type { FastifyInstance, FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import {
  changePasswordSchema,
  idParam,
  loginSchema,
  operatorInputSchema,
  securitySettingsSchema,
  totpCodeSchema,
  totpDisableSchema,
  totpSetupSchema,
} from '@uhppote-desk/shared'
import { HttpError, requireSession, SESSION_COOKIE } from '../auth/auth.js'
import { DEVICE_COOKIE } from '../auth/devices.js'
import { randomPassword } from '../auth/password.js'
import type { AppContext } from '../context.js'
import { requestErrorText } from '../util/lang.js'

/** Name shown by the authenticator apps. */
const TOTP_ISSUER = 'UHPPOTE Desk'

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // failed attempts (passwords and codes) per address and user: 5 wrong ones block that pair for 5 minutes
  const failures = new Map<string, { count: number; until: number }>()
  const assertNotBlocked = (key: string) => {
    const f = failures.get(key)
    if (f && f.until > Date.now()) throw new HttpError(429, 'tooManyAttempts')
  }
  const recordFailure = (key: string) => {
    const count = (failures.get(key)?.count ?? 0) + 1
    failures.set(key, { count, until: count >= 5 ? Date.now() + 5 * 60_000 : 0 })
  }

  app.post('/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body)
    const key = `${req.ip}|${body.username.toLowerCase()}`
    assertNotBlocked(key)

    const user = await ctx.auth.authenticate(body.username, body.password, false)
    if (!user) {
      recordFailure(key)
      ctx.audit.log(null, 'login-failed', `operator:${body.username}`, { ip: req.ip })
      throw new HttpError(401, 'invalidCredentials')
    }
    if (user.totpEnabled) {
      // the client asks for the code and sends password and code again
      if (!body.totp) throw new HttpError(401, 'totpRequired')
      const how = ctx.auth.verifySecondFactor(user.id!, body.totp)
      if (!how) {
        recordFailure(key)
        ctx.audit.log(null, 'login-failed', `operator:${body.username}`, { ip: req.ip, reason: 'totp' })
        throw new HttpError(401, 'invalidTotp')
      }
      if (how === 'recovery') {
        ctx.audit.log(user, 'recovery-code-used', `operator:${user.username}`, {
          ip: req.ip,
          left: ctx.auth.recoveryCodesLeft(user.id!),
        })
      }
    }
    failures.delete(key)
    ctx.auth.recordLogin(user.id!)
    const cookie = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: ctx.config.secureCookies }
    // a remembered device found in this browser is replaced by the new login
    const previous = ctx.devices.resolve(req.cookies[DEVICE_COOKIE], req.ip)
    if (previous) ctx.devices.revoke(previous.deviceId)
    if (body.remember) {
      // remembered device: only the device cookie, so that every request is known to come from this device
      const device = ctx.devices.create(
        user.id!,
        body.deviceName ?? (req.headers['user-agent'] ?? '').slice(0, 100),
        req.ip,
      )
      ctx.audit.log(user, 'login', `operator:${user.username}`, { ip: req.ip, device: device.deviceId })
      reply.clearCookie(SESSION_COOKIE, { path: '/' })
      // the server decides when the device expires; the cookie itself lasts ten years
      reply.setCookie(DEVICE_COOKIE, device.token, { ...cookie, maxAge: 10 * 365 * 86_400 })
      return { user: { ...user, deviceId: device.deviceId } }
    }
    const sessionId = ctx.auth.createSession(user.id!, req.ip, req.headers['user-agent'] ?? '')
    ctx.audit.log(user, 'login', `operator:${user.username}`, { ip: req.ip })
    reply.clearCookie(DEVICE_COOKIE, { path: '/' })
    reply.setCookie(SESSION_COOKIE, sessionId, { ...cookie, maxAge: ctx.config.sessionHours * 3600 })
    return { user }
  })

  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies[SESSION_COOKIE]
    if (sid) ctx.auth.logout(sid)
    // logging out of a remembered device forgets it (push, fingerprint/Face ID included)
    if (req.user?.deviceId) ctx.devices.revoke(req.user.deviceId)
    if (req.user) ctx.audit.log(req.user, 'logout', `operator:${req.user.username}`)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    reply.clearCookie(DEVICE_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/auth/me', async (req) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated')
    return { user: req.user }
  })

  app.post('/auth/password', async (req) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated')
    const id = req.user.id
    if (id === null) throw new HttpError(403, 'tokenNotAllowed')
    const body = changePasswordSchema.parse(req.body)
    ctx.auth.assertPasswordChangeable(id)
    const ok = await ctx.auth.changePassword(id, body.currentPassword, body.newPassword)
    if (!ok) throw new HttpError(400, 'wrongPassword')
    ctx.auth.revokeSessions(id, req.cookies[SESSION_COOKIE])
    // the other remembered devices must log in again with the new password
    ctx.devices.revokeAll(id, req.user.deviceId)
    ctx.audit.log(req.user, 'change-password', `operator:${req.user.username}`)
    return { ok: true }
  })

  // --- two-factor authentication of the logged-in operator ---------------------

  /** Operator of the request (not an API token). */
  const self = (req: FastifyRequest) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated')
    if (req.user.id === null) throw new HttpError(403, 'tokenNotAllowed')
    return { ...req.user, id: req.user.id }
  }
  const selfKey = (req: FastifyRequest, id: number) => `${req.ip}|#${id}`

  app.get('/auth/totp', async (req) => {
    const user = self(req)
    return {
      enabled: user.totpEnabled,
      required: ctx.auth.totpRequiredFor(user.role),
      recoveryCodesLeft: user.totpEnabled ? ctx.auth.recoveryCodesLeft(user.id) : 0,
    }
  })

  app.post('/auth/totp/setup', async (req) => {
    const user = self(req)
    const body = totpSetupSchema.parse(req.body)
    const key = selfKey(req, user.id)
    assertNotBlocked(key)
    if (!(await ctx.auth.checkPassword(user.id, body.password))) {
      recordFailure(key)
      throw new HttpError(400, 'wrongPassword')
    }
    const { secret, uri } = ctx.auth.beginTotpSetup(user.id, TOTP_ISSUER)
    const qr = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
    return { secret, uri, qr }
  })

  app.post('/auth/totp/enable', async (req) => {
    const user = self(req)
    const body = totpCodeSchema.parse(req.body)
    const key = selfKey(req, user.id)
    assertNotBlocked(key)
    const recoveryCodes = ctx.auth.confirmTotpSetup(user.id, body.code)
    if (!recoveryCodes) {
      recordFailure(key)
      throw new HttpError(400, 'invalidTotp')
    }
    failures.delete(key)
    // the other sessions and remembered devices logged in without the second factor: they log in again
    ctx.auth.revokeSessions(user.id, req.cookies[SESSION_COOKIE])
    ctx.devices.revokeAll(user.id, user.deviceId)
    ctx.audit.log(req.user, 'totp-enable', `operator:${user.username}`)
    return { recoveryCodes }
  })

  app.post('/auth/totp/recovery-codes', async (req) => {
    const user = self(req)
    const body = totpCodeSchema.parse(req.body)
    const key = selfKey(req, user.id)
    assertNotBlocked(key)
    if (!user.totpEnabled) throw new HttpError(400, 'totpNotEnabled')
    if (!ctx.auth.verifySecondFactor(user.id, body.code)) {
      recordFailure(key)
      throw new HttpError(400, 'invalidTotp')
    }
    failures.delete(key)
    const recoveryCodes = ctx.auth.replaceRecoveryCodes(user.id)
    ctx.audit.log(req.user, 'totp-recovery-codes', `operator:${user.username}`)
    return { recoveryCodes }
  })

  app.post('/auth/totp/disable', async (req) => {
    const user = self(req)
    const body = totpDisableSchema.parse(req.body)
    const key = selfKey(req, user.id)
    assertNotBlocked(key)
    if (!user.totpEnabled) throw new HttpError(400, 'totpNotEnabled')
    if (ctx.auth.totpRequiredFor(user.role)) throw new HttpError(400, 'totpRequiredByPolicy')
    if (!(await ctx.auth.checkPassword(user.id, body.password))) {
      recordFailure(key)
      throw new HttpError(400, 'wrongPassword')
    }
    if (!ctx.auth.verifySecondFactor(user.id, body.code)) {
      recordFailure(key)
      throw new HttpError(400, 'invalidTotp')
    }
    failures.delete(key)
    ctx.auth.disableTotp(user.id)
    ctx.audit.log(req.user, 'totp-disable', `operator:${user.username}`)
    return { ok: true }
  })

  // --- operator management (admin only, not with API tokens) ------------------

  const admin = { preHandler: requireSession('admin') }

  /** Security settings: who must use two-factor authentication. */
  app.get('/security/settings', admin, async () => ctx.auth.securitySettings())

  app.put('/security/settings', admin, async (req) => {
    const s = securitySettingsSchema.parse(req.body)
    ctx.auth.saveSecuritySettings(s)
    ctx.audit.log(req.user, 'update-security-settings', null, s)
    return s
  })

  /** Lost phone: an administrator switches off the two-factor authentication of another operator. */
  app.post('/operators/:id/reset-totp', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    if (id === req.user!.id) throw new HttpError(400, 'selfTotpReset')
    if (!ctx.auth.hasTotp(id)) throw new HttpError(400, 'totpNotEnabled')
    ctx.auth.disableTotp(id)
    // whoever has the phone may also have a remembered device or an open session on it
    ctx.auth.revokeSessions(id)
    ctx.devices.revokeAll(id)
    ctx.audit.log(req.user, 'totp-reset', `operator:${id}`)
    return { ok: true }
  })

  app.get('/operators', admin, async () => ctx.auth.listOperators())

  app.post('/operators', admin, async (req) => {
    const body = operatorInputSchema.parse(req.body)
    const password = body.password ?? randomPassword(12)
    const id = ctx.db.tx(() => {
      const id = ctx.db.run(
        'INSERT INTO operators (username, display_name, password_hash, role, active, must_change_password) VALUES (?, ?, ?, ?, ?, 1)',
        [body.username, body.displayName, 'pending', body.role, body.active ? 1 : 0],
      ).lastInsertRowid
      for (const z of body.zoneIds)
        ctx.db.run('INSERT INTO operator_zones (operator_id, zone_id) VALUES (?, ?)', [id, z])
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
      for (const z of body.zoneIds)
        ctx.db.run('INSERT INTO operator_zones (operator_id, zone_id) VALUES (?, ?)', [id, z])
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
    ctx.devices.revokeAll(id)
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
    const result = ctx.audit.query({
      limit: Math.min(Number(q.limit ?? 100), 1000),
      offset: Number(q.offset ?? 0),
      action: q.action,
      operatorId: q.operatorId ? Number(q.operatorId) : undefined,
    })
    // errors in the reader's language
    const rows = result.rows.map(({ errorInfo, ...r }) => ({
      ...r,
      error: errorInfo ? requestErrorText(req, errorInfo) : r.error,
    }))
    return { ...result, rows }
  })
}
