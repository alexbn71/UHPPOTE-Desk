/**
 * API tokens: creation, Bearer authentication, access levels, zone and door restrictions,
 * expiry, audit, and the operations that stay reserved to password sessions.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeController } from '@uhppote-desk/protocol/testing'
import type { ApiTokenDto } from '@uhppote-desk/shared'
import { buildApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'
import { localDate } from '../../src/util/time.js'

const SERIAL = 423187760
const PASSWORD = 'Token-Test-1'
const OPEN_DOOR = 0x40

let fake: FakeController
let ctx: AppContext
let app: FastifyInstance
let cookie = ''
let controllerId = 0
let dataDir = ''

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: (m: string) => console.error(m),
  debug: () => undefined,
}

function config(dir: string): AppConfig {
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
      timeoutMs: 400,
      retries: 1,
      debug: false,
    },
    healthIntervalSec: 3600,
    collectIntervalSec: 3600,
    timeSyncThresholdSec: 30,
    initialBackfill: 100,
    backupHour: -1,
    backupKeep: 1,
    mqtt: null,
    publicUrl: null,
  }
}

/** Request with the admin session (default) or with a Bearer token. */
async function api(method: string, url: string, body?: unknown, token?: string): Promise<LightMyRequestResponse> {
  const headers = token ? { authorization: `Bearer ${token}` } : { cookie }
  return app.inject({
    method: method as 'GET',
    url: `/api${url}`,
    headers,
    ...(body !== undefined ? { payload: body as object } : {}),
  })
}

async function createToken(body: Record<string, unknown>): Promise<{ token: string; apiToken: ApiTokenDto }> {
  const r = await api('POST', '/tokens', { name: 'Test', zoneIds: [], doorIds: [], ...body })
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}

const doorId = (n: number) => ctx.controllers.doorByNumber(controllerId, n)!.id
const opens = () => fake.requestCount.get(OPEN_DOOR) ?? 0

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-tokens-'))
  fake = new FakeController({ id: SERIAL })
  await fake.start()
  ctx = createContext(config(dataDir), quiet, ':memory:')
  await ctx.auth.ensureAdmin(PASSWORD)
  app = await buildApp(ctx)
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: PASSWORD },
  })
  cookie = `uhd_session=${login.cookies.find((c) => c.name === 'uhd_session')!.value}`
  controllerId = ctx.controllers.create({
    serial: SERIAL,
    name: 'Gate',
    host: fake.endpoint.host,
    port: fake.endpoint.port,
    transport: 'udp',
    zoneId: null,
    enabled: true,
  })
})

afterAll(async () => {
  await app.close()
  ctx.db.close()
  await fake.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('token management', () => {
  it('returns the token once and stores only its hash', async () => {
    const { token, apiToken } = await createToken({ name: 'CasaAuto', access: 'read' })
    expect(token).toMatch(/^uhd_[A-Za-z0-9_-]{43}$/)
    expect(apiToken).toMatchObject({
      name: 'CasaAuto',
      access: 'read',
      prefix: token.slice(0, 10),
      active: true,
      createdBy: 'admin',
      lastUsedAt: null,
    })
    const listed = (await api('GET', '/tokens')).json() as ApiTokenDto[]
    expect(JSON.stringify(listed)).not.toContain(token)
    const row = ctx.db.get<{ token_hash: string }>('SELECT token_hash FROM api_tokens WHERE id = ?', [apiToken.id])!
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(ctx.db.all('SELECT details FROM audit_log'))).not.toContain(token)
  })

  it('cannot be managed with a token, not even an admin one', async () => {
    const { token } = await createToken({ name: 'Admin script', access: 'admin' })
    expect((await api('GET', '/tokens', undefined, token)).statusCode).toBe(403)
    expect((await api('POST', '/tokens', { name: 'x', access: 'admin' }, token)).json().code).toBe('tokenNotAllowed')
    expect((await api('GET', '/operators', undefined, token)).statusCode).toBe(403)
    expect(
      (await api('POST', '/auth/password', { currentPassword: 'a', newPassword: 'abcdefgh' }, token)).json().code,
    ).toBe('tokenNotAllowed')
    // everything else works like an administrator
    expect((await api('GET', '/webhooks', undefined, token)).statusCode).toBe(200)
  })
})

describe('Bearer authentication', () => {
  it('authenticates, records the last use and refuses unknown, inactive or expired tokens', async () => {
    const { token, apiToken } = await createToken({ name: 'Reader', access: 'read' })
    const me = await api('GET', '/auth/me', undefined, token)
    expect(me.json().user).toMatchObject({
      id: null,
      tokenId: apiToken.id,
      username: 'token:Reader',
      role: 'viewer',
      canOpenDoors: false,
    })
    expect((await api('GET', '/doors', undefined, token)).statusCode).toBe(200)
    expect(ctx.tokens.get(apiToken.id)!.lastUsedAt).not.toBeNull()
    expect(ctx.tokens.get(apiToken.id)!.lastUsedIp).toBe('127.0.0.1')

    expect((await api('GET', '/doors', undefined, 'uhd_wrong')).statusCode).toBe(401)
    expect((await api('GET', '/doors', undefined, 'not-a-token')).statusCode).toBe(401)

    await api('PUT', `/tokens/${apiToken.id}`, { ...apiToken, active: false })
    expect((await api('GET', '/doors', undefined, token)).statusCode).toBe(401)

    const yesterday = new Date(Date.now() - 86_400_000)
    await api('PUT', `/tokens/${apiToken.id}`, { ...apiToken, active: true, expiresAt: localDate(yesterday) })
    expect((await api('GET', '/doors', undefined, token)).statusCode).toBe(401)
    await api('PUT', `/tokens/${apiToken.id}`, { ...apiToken, active: true, expiresAt: localDate() })
    expect((await api('GET', '/doors', undefined, token)).statusCode).toBe(200)

    await api('DELETE', `/tokens/${apiToken.id}`)
    expect((await api('GET', '/doors', undefined, token)).statusCode).toBe(401)
  })

  it('a Bearer header takes precedence over the session cookie', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/doors',
      headers: { cookie, authorization: 'Bearer uhd_wrong' },
    })
    expect(r.statusCode).toBe(401)
  })
})

describe('access levels and restrictions', () => {
  it('read: no changes and no door opening', async () => {
    const { token } = await createToken({ name: 'Read', access: 'read' })
    expect((await api('POST', `/doors/${doorId(1)}/open`, undefined, token)).statusCode).toBe(403)
    expect((await api('POST', '/people', { code: 'X1', lastName: 'Rossi' }, token)).statusCode).toBe(403)
  })

  it('doors: opens only the allowed doors and changes nothing else', async () => {
    const { token } = await createToken({ name: 'CasaAuto gate', access: 'doors', doorIds: [doorId(1)] })
    const before = opens()
    expect((await api('POST', `/doors/${doorId(1)}/open`, undefined, token)).statusCode).toBe(200)
    expect(opens()).toBe(before + 1)
    const denied = await api('POST', `/doors/${doorId(2)}/open`, undefined, token)
    expect(denied.statusCode).toBe(403)
    expect(denied.json().code).toBe('doorForbidden')
    expect(opens()).toBe(before + 1)
    expect((await api('POST', '/people', { code: 'X2', lastName: 'Bianchi' }, token)).statusCode).toBe(403)

    const audit = ctx.db.get<{ operator_id: number | null; operator_name: string; details: string }>(
      "SELECT operator_id, operator_name, details FROM audit_log WHERE action = 'open-door' ORDER BY id DESC LIMIT 1",
    )!
    expect(audit).toMatchObject({ operator_id: null, operator_name: 'token:CasaAuto gate' })
  })

  it('zone restriction applies as for operators', async () => {
    const zone = (await api('POST', '/zones', { name: 'Elsewhere', parentId: null })).json().id as number
    const { token } = await createToken({ name: 'Other site', access: 'operator', zoneIds: [zone] })
    const r = await api('POST', `/doors/${doorId(1)}/open`, undefined, token)
    expect(r.json().code).toBe('zoneForbidden')
  })

  it('operator: can change data, and actions without an operator id work', async () => {
    const { token } = await createToken({ name: 'HR sync', access: 'operator' })
    const person = await api(
      'POST',
      '/people',
      { code: 'HR1', lastName: 'Verdi', validFrom: '2026-01-01', validTo: '2030-12-31' },
      token,
    )
    expect(person.statusCode, person.body).toBe(200)
    const punch = await api(
      'POST',
      '/punches',
      { personId: person.json().id, timestamp: '2026-10-12 08:00', direction: 1, reason: 'forgot card' },
      token,
    )
    expect(punch.statusCode, punch.body).toBe(200)
    expect((await api('POST', `/doors/${doorId(3)}/open`, undefined, token)).statusCode).toBe(200)
  })
})
