/**
 * Administrator password: ADMIN_PASSWORD set (applied at every start, not changeable from the app)
 * versus not set (generated on first start, change required).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined }
const open: { ctx: AppContext; app: FastifyInstance; dir: string }[] = []

function config(dir: string, adminPassword: string | null): AppConfig {
  return {
    httpPort: 0,
    httpHost: '127.0.0.1',
    dataDir: dir,
    secureCookies: false,
    sessionHours: 1,
    adminPassword,
    adminPasswordFromLegacyVariable: false,
    webDir: null,
    uhppote: { bindAddress: '127.0.0.1', broadcast: '127.0.0.1:1', listen: '127.0.0.1:0', listenerPublic: null, timeoutMs: 200, retries: 0, debug: false },
    healthIntervalSec: 3600,
    collectIntervalSec: 3600,
    timeSyncThresholdSec: 30,
    initialBackfill: 10,
    backupHour: -1,
    backupKeep: 1,
    mqtt: null,
  }
}

/** Simulates a server start on the given data folder (same database across "restarts"). */
async function start(dir: string, adminPassword: string | null) {
  const ctx = createContext(config(dir, adminPassword), quiet, path.join(dir, 'db.sqlite'))
  const result = await ctx.auth.ensureAdmin(adminPassword)
  const app = await buildApp(ctx)
  open.push({ ctx, app, dir })
  return { ctx, app, result }
}

async function stop(entry: { ctx: AppContext; app: FastifyInstance }) {
  await entry.app.close()
  entry.ctx.db.close()
}

afterEach(async () => {
  for (const e of open.splice(0)) {
    await stop(e)
    fs.rmSync(e.dir, { recursive: true, force: true })
  }
})

async function login(app: FastifyInstance, password: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password } })
  const cookie = r.cookies.find((c) => c.name === 'uhd_session')
  return { status: r.statusCode, user: r.statusCode === 200 ? r.json().user : null, cookie: cookie ? `uhd_session=${cookie.value}` : '' }
}

describe('ADMIN_PASSWORD set', () => {
  it('creates admin with that password, no forced change, not changeable from the app', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-admin-'))
    const { app, result } = await start(dir, 'Env-Password-1')
    expect(result.action).toBe('created-env')
    const s = await login(app, 'Env-Password-1')
    expect(s.status).toBe(200)
    expect(s.user).toMatchObject({ username: 'admin', mustChangePassword: false, passwordManaged: true })
    // the protected routes work immediately (no forced password change)
    expect((await app.inject({ method: 'GET', url: '/api/controllers', headers: { cookie: s.cookie } })).statusCode).toBe(200)
    // changing it from the app is refused with a translatable code
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: s.cookie },
      payload: { currentPassword: 'Env-Password-1', newPassword: 'Another-Password-1' },
    })
    expect(r.statusCode).toBe(400)
    expect(r.json().code).toBe('passwordManagedByEnv')
    const adminId = s.user.id
    expect((await app.inject({ method: 'POST', url: `/api/operators/${adminId}/reset-password`, headers: { cookie: s.cookie } })).json().code).toBe('passwordManagedByEnv')
  })

  it('is applied again at every start, also when the variable changes or the database already exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-admin-'))
    // first start without the variable: generated password
    let s = await start(dir, null)
    expect(s.result.action).toBe('created-generated')
    await stop(open.pop()!)
    // restart with ADMIN_PASSWORD: the existing admin takes that password, no forced change
    s = await start(dir, 'Env-Password-1')
    expect(s.result.action).toBe('updated-env')
    expect((await login(s.app, 'Env-Password-1')).user).toMatchObject({ mustChangePassword: false })
    await stop(open.pop()!)
    // same value again: nothing to do
    s = await start(dir, 'Env-Password-1')
    expect(s.result.action).toBe('unchanged')
    await stop(open.pop()!)
    // new value: the old one no longer works
    s = await start(dir, 'Env-Password-2')
    expect(s.result.action).toBe('updated-env')
    expect((await login(s.app, 'Env-Password-1')).status).toBe(401)
    expect((await login(s.app, 'Env-Password-2')).status).toBe(200)
  })
})

describe('ADMIN_PASSWORD not set', () => {
  it('generates a password on the first start only and requires a change at first login', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-admin-'))
    const s = await start(dir, null)
    expect(s.result.action).toBe('created-generated')
    expect(s.result.password).toMatch(/^\S{16}$/)
    const l = await login(s.app, s.result.password!)
    expect(l.user).toMatchObject({ mustChangePassword: true, passwordManaged: false })
    expect((await s.app.inject({ method: 'GET', url: '/api/controllers', headers: { cookie: l.cookie } })).statusCode).toBe(403)
    const r = await s.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: l.cookie },
      payload: { currentPassword: s.result.password, newPassword: 'Chosen-Password-1' },
    })
    expect(r.statusCode).toBe(200)
    await stop(open.pop()!)
    // restart: nothing is regenerated and the chosen password still works
    const again = await start(dir, null)
    expect(again.result.action).toBe('unchanged')
    expect((await login(again.app, 'Chosen-Password-1')).user).toMatchObject({ mustChangePassword: false })
  })
})
