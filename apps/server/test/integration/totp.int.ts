/**
 * Two-factor authentication of the operators: setup with an authenticator app, login with a code or a recovery code,
 * replay protection, attempt limit, switching it off, reset by an administrator, and the "required for" setting.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { currentStep, hotp } from '../../src/auth/totp.js'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'

const PASSWORD = 'Totp-Test-Pass-1'
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
const open: { ctx: AppContext; app: FastifyInstance; dir: string }[] = []

function config(dir: string, admin2faBypass = false): AppConfig {
  return {
    httpPort: 0,
    httpHost: '127.0.0.1',
    dataDir: dir,
    secureCookies: false,
    sessionHours: 1,
    adminPassword: PASSWORD,
    adminPasswordFromLegacyVariable: false,
    webDir: null,
    uhppote: {
      bindAddress: '127.0.0.1',
      broadcast: '127.0.0.1:1',
      listen: '127.0.0.1:0',
      listenerPublic: null,
      timeoutMs: 200,
      retries: 0,
      debug: false,
    },
    healthIntervalSec: 3600,
    collectIntervalSec: 3600,
    timeSyncThresholdSec: 30,
    initialBackfill: 10,
    backupHour: -1,
    backupKeep: 1,
    mqtt: null,
    publicUrl: null,
    admin2faBypass,
  }
}

async function start(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-totp-')), admin2faBypass = false) {
  const ctx = createContext(config(dir, admin2faBypass), quiet, path.join(dir, 'db.sqlite'))
  await ctx.auth.ensureAdmin(PASSWORD)
  const app = await buildApp(ctx)
  open.push({ ctx, app, dir })
  return { ctx, app, dir }
}

afterEach(async () => {
  for (const e of open.splice(0)) {
    await e.app.close()
    e.ctx.db.close()
    fs.rmSync(e.dir, { recursive: true, force: true })
  }
})

const cookieOf = (r: { cookies: { name: string; value: string }[] }) =>
  r.cookies
    .filter((c) => c.name === 'uhd_session' || c.name === 'uhd_device')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')

async function login(app: FastifyInstance, extra: object = {}, username = 'admin', password = PASSWORD) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, ...extra } })
  return { status: r.statusCode, body: r.json(), cookie: cookieOf(r) }
}

const post = (app: FastifyInstance, cookie: string, url: string, payload: object = {}) =>
  app.inject({ method: 'POST', url: `/api${url}`, headers: { cookie }, payload })

/** A code for the current step that is not refused as already used (the tests run within the same 30 s). */
function freshCode(ctx: AppContext, username = 'admin'): string {
  ctx.db.run('UPDATE operators SET totp_last_step = 0 WHERE username = ?', [username])
  const { totp_secret } = ctx.db.get<{ totp_secret: string }>('SELECT totp_secret FROM operators WHERE username = ?', [
    username,
  ])!
  return hotp(totp_secret, currentStep())
}

/** Logs in and activates two-factor authentication; returns cookie, secret and recovery codes. */
async function enable(app: FastifyInstance) {
  const s = await login(app)
  const setup = await post(app, s.cookie, '/auth/totp/setup', { password: PASSWORD })
  expect(setup.statusCode).toBe(200)
  const { secret, uri, qr } = setup.json() as { secret: string; uri: string; qr: string }
  expect(uri).toContain(`secret=${secret}`)
  expect(qr).toContain('<svg')
  const r = await post(app, s.cookie, '/auth/totp/enable', { code: hotp(secret, currentStep()) })
  expect(r.statusCode).toBe(200)
  return { cookie: s.cookie, secret, recoveryCodes: r.json().recoveryCodes as string[] }
}

describe('two-factor authentication', () => {
  it('setup needs the password and a valid code of the new secret', async () => {
    const { app } = await start()
    const s = await login(app)
    expect(s.body.user).toMatchObject({ totpEnabled: false, mustSetupTotp: false })
    expect((await post(app, s.cookie, '/auth/totp/setup', { password: 'wrong' })).json().code).toBe('wrongPassword')
    expect((await post(app, s.cookie, '/auth/totp/enable', { code: '123456' })).json().code).toBe('totpNoSetup')
    const { secret } = (await post(app, s.cookie, '/auth/totp/setup', { password: PASSWORD })).json()
    const wrong = String((Number(hotp(secret, currentStep())) + 1) % 1_000_000).padStart(6, '0')
    expect((await post(app, s.cookie, '/auth/totp/enable', { code: wrong })).json().code).toBe('invalidTotp')
    const ok = await post(app, s.cookie, '/auth/totp/enable', { code: hotp(secret, currentStep()) })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().recoveryCodes).toHaveLength(10)
    const status = await app.inject({ method: 'GET', url: '/api/auth/totp', headers: { cookie: s.cookie } })
    expect(status.json()).toEqual({ enabled: true, required: false, recoveryCodesLeft: 10, bypass: false })
    // a second setup is refused while active
    expect((await post(app, s.cookie, '/auth/totp/setup', { password: PASSWORD })).json().code).toBe(
      'totpAlreadyEnabled',
    )
  })

  it('login asks for the code, refuses wrong and reused codes, accepts recovery codes once', async () => {
    const { app, ctx } = await start()
    const { cookie: firstCookie, recoveryCodes } = await enable(app)
    // the session that activated it stays valid
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: firstCookie } })).statusCode,
    ).toBe(200)

    const noCode = await login(app)
    expect(noCode.status).toBe(401)
    expect(noCode.body.code).toBe('totpRequired')
    expect(noCode.cookie).toBe('')
    expect((await login(app, { totp: '000000' })).body.code).toBe('invalidTotp')

    const code = freshCode(ctx)
    const ok = await login(app, { totp: code })
    expect(ok.status).toBe(200)
    expect(ok.body.user).toMatchObject({ totpEnabled: true })
    expect(ok.cookie).toMatch(/uhd_session=/)
    // the same code cannot be used again
    expect((await login(app, { totp: code })).body.code).toBe('invalidTotp')

    // recovery code, written differently (upper case, spaces): works once
    const typed = recoveryCodes[0]!.toUpperCase().replace(/-/g, ' ')
    expect((await login(app, { totp: typed })).status).toBe(200)
    expect((await login(app, { totp: recoveryCodes[0] })).body.code).toBe('invalidTotp')
    const status = await app.inject({ method: 'GET', url: '/api/auth/totp', headers: { cookie: ok.cookie } })
    expect(status.json().recoveryCodesLeft).toBe(9)

    // remembered device: the second factor is asked as well
    expect((await login(app, { remember: true })).body.code).toBe('totpRequired')
    const device = await login(app, { remember: true, totp: freshCode(ctx) })
    expect(device.status).toBe(200)
    expect(device.cookie).toMatch(/uhd_device=/)

    const audit = ctx.db.all<{ action: string }>('SELECT action FROM audit_log ORDER BY id').map((a) => a.action)
    expect(audit).toContain('totp-enable')
    expect(audit).toContain('recovery-code-used')
  })

  it('wrong codes count as failed attempts', async () => {
    const { app } = await start()
    await enable(app)
    for (let i = 0; i < 5; i++) expect((await login(app, { totp: '000000' })).body.code).toBe('invalidTotp')
    expect((await login(app, { totp: '000000' })).status).toBe(429)
  })

  it('activating it logs out the other sessions; new recovery codes replace the old ones', async () => {
    const { app, ctx } = await start()
    const other = await login(app)
    const { cookie, recoveryCodes } = await enable(app)
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: other.cookie } })).statusCode,
    ).toBe(401)
    expect((await post(app, cookie, '/auth/totp/recovery-codes', { code: '000000' })).json().code).toBe('invalidTotp')
    const r = await post(app, cookie, '/auth/totp/recovery-codes', { code: freshCode(ctx) })
    const fresh = r.json().recoveryCodes as string[]
    expect(fresh).toHaveLength(10)
    expect((await login(app, { totp: recoveryCodes[1] })).body.code).toBe('invalidTotp')
    expect((await login(app, { totp: fresh[0] })).status).toBe(200)
  })

  it('switching it off needs password and code', async () => {
    const { app, ctx } = await start()
    const { cookie } = await enable(app)
    const code = freshCode(ctx)
    expect((await post(app, cookie, '/auth/totp/disable', { password: 'wrong', code })).json().code).toBe(
      'wrongPassword',
    )
    expect((await post(app, cookie, '/auth/totp/disable', { password: PASSWORD, code: '000000' })).json().code).toBe(
      'invalidTotp',
    )
    expect((await post(app, cookie, '/auth/totp/disable', { password: PASSWORD, code })).statusCode).toBe(200)
    expect((await login(app)).status).toBe(200)
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM operator_recovery_codes')!.n).toBe(0)
  })

  it('an administrator resets it for another operator, not for themselves', async () => {
    const { app, ctx } = await start()
    const s = await login(app)
    const created = await post(app, s.cookie, '/operators', {
      username: 'mario',
      displayName: 'Mario',
      role: 'operator',
      active: true,
      password: 'Mario-Pass-123',
      zoneIds: [],
    })
    const marioId = created.json().id as number
    // mario: change the forced password, then activate two-factor authentication
    let m = await login(app, {}, 'mario', 'Mario-Pass-123')
    await post(app, m.cookie, '/auth/password', { currentPassword: 'Mario-Pass-123', newPassword: 'Mario-Pass-456' })
    const { secret } = (await post(app, m.cookie, '/auth/totp/setup', { password: 'Mario-Pass-456' })).json()
    expect((await post(app, m.cookie, '/auth/totp/enable', { code: hotp(secret, currentStep()) })).statusCode).toBe(200)

    const list = (await app.inject({ method: 'GET', url: '/api/operators', headers: { cookie: s.cookie } })).json()
    expect(list.find((o: { id: number }) => o.id === marioId).totpEnabled).toBe(true)
    const adminId = s.body.user.id as number
    expect((await post(app, s.cookie, `/operators/${adminId}/reset-totp`)).json().code).toBe('selfTotpReset')
    expect((await post(app, s.cookie, `/operators/${marioId}/reset-totp`)).statusCode).toBe(200)
    // sessions of mario are closed; the password alone is enough again
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: m.cookie } })).statusCode).toBe(
      401,
    )
    m = await login(app, {}, 'mario', 'Mario-Pass-456')
    expect(m.status).toBe(200)
    expect(m.body.user.totpEnabled).toBe(false)
    expect(ctx.auth.hasTotp(marioId)).toBe(false)
  })
})

/** Sets who must use two-factor authentication, as an administrator from the app. */
async function setRequired(app: FastifyInstance, require2fa: string) {
  const s = await login(app)
  const r = await app.inject({
    method: 'PUT',
    url: '/api/security/settings',
    headers: { cookie: s.cookie },
    payload: { require2fa },
  })
  expect(r.statusCode).toBe(200)
  return s
}

describe('two-factor authentication required (security settings)', () => {
  it('only administrators change it, it is kept across restarts and audited', async () => {
    const { app, ctx, dir } = await start()
    const s = await login(app)
    expect(
      (await app.inject({ method: 'GET', url: '/api/security/settings', headers: { cookie: s.cookie } })).json(),
    ).toEqual({ require2fa: 'none' })
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/security/settings',
      headers: { cookie: s.cookie },
      payload: { require2fa: 'sometimes' },
    })
    expect(bad.statusCode).toBe(400)
    await post(app, s.cookie, '/operators', {
      username: 'reader',
      displayName: 'Reader',
      role: 'viewer',
      active: true,
      password: 'Reader-Pass-123',
      zoneIds: [],
    })
    const reader = await login(app, {}, 'reader', 'Reader-Pass-123')
    const refused = await app.inject({
      method: 'PUT',
      url: '/api/security/settings',
      headers: { cookie: reader.cookie },
      payload: { require2fa: 'none' },
    })
    expect(refused.statusCode).toBe(403)

    await setRequired(app, 'admin')
    expect(ctx.db.all<{ action: string }>('SELECT action FROM audit_log').map((a) => a.action)).toContain(
      'update-security-settings',
    )
    // restart on the same data folder: still required
    open.splice(
      open.findIndex((e) => e.dir === dir),
      1,
    )
    await app.close()
    ctx.db.close()
    const again = await start(dir)
    expect((await login(again.app)).body.user.mustSetupTotp).toBe(true)
  })

  it('forces the setup before anything else and refuses switching it off', async () => {
    const { app, ctx } = await start()
    // the session that changed the setting is affected at once
    const s = await setRequired(app, 'admin')
    expect(
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: s.cookie } })).json().user,
    ).toMatchObject({ totpEnabled: false, mustSetupTotp: true })
    expect(
      (await app.inject({ method: 'GET', url: '/api/controllers', headers: { cookie: s.cookie } })).json().code,
    ).toBe('mustSetupTotp')
    const status = await app.inject({ method: 'GET', url: '/api/auth/totp', headers: { cookie: s.cookie } })
    expect(status.json()).toMatchObject({ enabled: false, required: true })

    const { secret } = (await post(app, s.cookie, '/auth/totp/setup', { password: PASSWORD })).json()
    await post(app, s.cookie, '/auth/totp/enable', { code: hotp(secret, currentStep()) })
    expect(
      (await app.inject({ method: 'GET', url: '/api/controllers', headers: { cookie: s.cookie } })).statusCode,
    ).toBe(200)
    expect(
      (await post(app, s.cookie, '/auth/totp/disable', { password: PASSWORD, code: freshCode(ctx) })).json().code,
    ).toBe('totpRequiredByPolicy')
  })

  it('applies from the chosen role up', async () => {
    const { app, ctx } = await start()
    await post(app, (await login(app)).cookie, '/operators', {
      username: 'reader',
      displayName: 'Reader',
      role: 'viewer',
      active: true,
      password: 'Reader-Pass-123',
      zoneIds: [],
    })
    await setRequired(app, 'operator')
    // admin is above operator: must set it up; a viewer does not
    expect((await login(app)).body.user.mustSetupTotp).toBe(true)
    expect((await login(app, {}, 'reader', 'Reader-Pass-123')).body.user.mustSetupTotp).toBe(false)
    ctx.auth.saveSecuritySettings({ require2fa: 'all' })
    expect((await login(app, {}, 'reader', 'Reader-Pass-123')).body.user.mustSetupTotp).toBe(true)
    // an administrator who must set it up cannot switch the requirement off first: the setup comes first
    const blocked = await app.inject({
      method: 'PUT',
      url: '/api/security/settings',
      headers: { cookie: (await login(app)).cookie },
      payload: { require2fa: 'none' },
    })
    expect(blocked.json().code).toBe('mustSetupTotp')
  })
})

describe('ADMIN_2FA_BYPASS (emergency access)', () => {
  /** Restarts on the same data folder with or without the variable. */
  async function restart(entry: { ctx: AppContext; app: FastifyInstance; dir: string }, bypass: boolean) {
    open.splice(open.indexOf(open.find((e) => e.dir === entry.dir)!), 1)
    await entry.app.close()
    entry.ctx.db.close()
    return start(entry.dir, bypass)
  }

  it('administrators log in without the code and reset their own, operators still need the code', async () => {
    const first = await start()
    const { cookie: adminCookie } = await enable(first.app)
    // an operator with two-factor authentication too
    await post(first.app, adminCookie, '/operators', {
      username: 'mario',
      displayName: 'Mario',
      role: 'operator',
      active: true,
      password: 'Mario-Pass-123',
      zoneIds: [],
    })
    let m = await login(first.app, {}, 'mario', 'Mario-Pass-123')
    await post(first.app, m.cookie, '/auth/password', {
      currentPassword: 'Mario-Pass-123',
      newPassword: 'Mario-Pass-456',
    })
    const { secret } = (await post(first.app, m.cookie, '/auth/totp/setup', { password: 'Mario-Pass-456' })).json()
    await post(first.app, m.cookie, '/auth/totp/enable', { code: hotp(secret, currentStep()) })
    // two-factor authentication required for administrators
    first.ctx.auth.saveSecuritySettings({ require2fa: 'admin' })

    // lost phone: restart with the variable
    const { app, ctx } = await restart(first, true)
    const admin = await login(app)
    expect(admin.status).toBe(200)
    expect(admin.body.user).toMatchObject({ totpEnabled: true, totpBypass: true })
    const audit = ctx.db.get<{ details: string }>(
      "SELECT details FROM audit_log WHERE action = 'login' ORDER BY id DESC LIMIT 1",
    )!
    expect(JSON.parse(audit.details)).toMatchObject({ totpBypass: true })
    // the operator is not concerned: the code is still asked
    m = await login(app, {}, 'mario', 'Mario-Pass-456')
    expect(m.body.code).toBe('totpRequired')
    expect(m.body.user).toBeUndefined()

    // reset: switched off with the password only, although mandatory for administrators
    const status = await app.inject({ method: 'GET', url: '/api/auth/totp', headers: { cookie: admin.cookie } })
    expect(status.json()).toMatchObject({ enabled: true, required: true, bypass: true })
    expect((await post(app, admin.cookie, '/auth/totp/disable', { password: 'wrong' })).json().code).toBe(
      'wrongPassword',
    )
    expect((await post(app, admin.cookie, '/auth/totp/disable', { password: PASSWORD })).statusCode).toBe(200)
    // mandatory: set up again with the new phone before anything else
    expect((await login(app)).body.user).toMatchObject({ totpEnabled: false, mustSetupTotp: true })

    // the operator cannot switch it off without the code, even with the variable
    m = await login(app, { totp: freshCode(ctx, 'mario') }, 'mario', 'Mario-Pass-456')
    expect((await post(app, m.cookie, '/auth/totp/disable', { password: 'Mario-Pass-456' })).json().code).toBe(
      'invalidTotp',
    )
  })

  it('without the variable the administrator needs the code again', async () => {
    const first = await start(undefined, true)
    await enable(first.app)
    expect((await login(first.app)).status).toBe(200)
    const { app } = await restart(first, false)
    expect((await login(app)).body.code).toBe('totpRequired')
  })
})
