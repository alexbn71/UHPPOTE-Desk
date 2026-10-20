/**
 * Guest passes: links that open doors without login, bound to the first phone, with PIN, validity window,
 * maximum openings, rate limiting, integration events and the operators' door restrictions.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeController } from '@uhppote-desk/protocol/testing'
import type { GuestLinkDto, GuestPassDto, GuestViewDto } from '@uhppote-desk/shared'
import { buildApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'
import type { IntegrationEvent } from '../../src/services/integrationEvents.js'
import { addDays, localDate, localDateTime } from '../../src/util/time.js'

const SERIAL = 423187761
const PASSWORD = 'Guest-Test-1'
const OPEN_DOOR = 0x40

let fake: FakeController
let ctx: AppContext
let app: FastifyInstance
let cookie = ''
let controllerId = 0
let dataDir = ''
const published: IntegrationEvent[] = []

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

/** Operator request (admin session by default). */
async function api(method: string, url: string, body?: unknown, session = cookie): Promise<LightMyRequestResponse> {
  return app.inject({
    method: method as 'GET',
    url: `/api${url}`,
    headers: { cookie: session, origin: 'https://doors.example.com' },
    ...(body !== undefined ? { payload: body as object } : {}),
  })
}

/** A guest's browser: keeps its own device cookie, like a phone. */
function phone(ip = '10.0.0.1') {
  let device = ''
  const send = async (method: string, url: string, body?: unknown) => {
    const r = await app.inject({
      method: method as 'GET',
      url: `/api${url}`,
      remoteAddress: ip,
      headers: device ? { cookie: `uhd_guest=${device}` } : {},
      ...(body !== undefined ? { payload: body as object } : {}),
    })
    device = r.cookies.find((c) => c.name === 'uhd_guest')?.value ?? device
    return r
  }
  return {
    view: (token: string) => send('GET', `/guest/${token}`),
    open: (token: string, doorId: number, pin?: string) =>
      send('POST', `/guest/${token}/doors/${doorId}/open`, pin === undefined ? {} : { pin }),
  }
}

const now = () => localDateTime().slice(0, 16)
const inMinutes = (m: number) => localDateTime(new Date(Date.now() + m * 60_000)).slice(0, 16)

async function createPass(body: Record<string, unknown> = {}, session = cookie): Promise<GuestLinkDto> {
  const r = await api(
    'POST',
    '/guests',
    { name: 'Mario', doorIds: [doorId(1)], validFrom: now(), validTo: inMinutes(120), bindDevice: false, ...body },
    session,
  )
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}

const doorId = (n: number) => ctx.controllers.doorByNumber(controllerId, n)!.id
const opens = () => fake.requestCount.get(OPEN_DOOR) ?? 0

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-guests-'))
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
  ctx.integrationEvents.on('event', (e) => published.push(e))
})

afterAll(async () => {
  await app.close()
  ctx.db.close()
  await fake.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('pass management', () => {
  it('returns the link once and stores only hashes, never the PIN', async () => {
    const { pass, token, link } = await createPass({ pin: '4821' })
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(link).toBe(`https://doors.example.com/g/${token}`)
    expect(pass).toMatchObject({ name: 'Mario', hasPin: true, status: 'active', opens: 0, createdBy: 'admin' })
    const listed = (await api('GET', '/guests')).json() as GuestPassDto[]
    expect(JSON.stringify(listed)).not.toContain(token)
    const row = ctx.db.get<{ token_hash: string; pin_hash: string }>('SELECT * FROM guest_passes WHERE id = ?', [
      pass.id,
    ])!
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.pin_hash).not.toContain('4821')
    const audit = JSON.stringify(ctx.db.all('SELECT details FROM audit_log'))
    expect(audit).not.toContain(token)
    expect(audit).not.toContain('4821')
  })

  it('validates the period and the daily window', async () => {
    const base = { name: 'X', doorIds: [doorId(1)] }
    expect((await api('POST', '/guests', { ...base, validFrom: now(), validTo: now() })).statusCode).toBe(400)
    expect(
      (await api('POST', '/guests', { ...base, validFrom: now(), validTo: inMinutes(60), timeFrom: '09:00' }))
        .statusCode,
    ).toBe(400)
    expect(
      (await api('POST', '/guests', { ...base, doorIds: [], validFrom: now(), validTo: inMinutes(5) })).statusCode,
    ).toBe(400)
  })

  it('operators manage only passes for the doors they may open', async () => {
    const zone = (await api('POST', '/zones', { name: 'Office' })).json() as { id: number }
    const created = await api('POST', '/operators', {
      username: 'luca',
      displayName: 'Luca',
      role: 'operator',
      password: 'Operator-Pw-1',
      zoneIds: [zone.id],
    })
    expect(created.statusCode, created.body).toBe(200)
    ctx.db.run("UPDATE operators SET must_change_password = 0 WHERE username = 'luca'")
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'luca', password: 'Operator-Pw-1' },
    })
    const luca = `uhd_session=${login.cookies.find((c) => c.name === 'uhd_session')!.value}`
    // the gate is in no zone: an operator limited to a zone may not open it, so no pass for it
    const r = await api(
      'POST',
      '/guests',
      { name: 'Y', doorIds: [doorId(1)], validFrom: now(), validTo: inMinutes(60) },
      luca,
    )
    expect(r.json().code).toBe('doorForbidden')
    expect((await api('GET', '/guests', undefined, luca)).json()).toEqual([])
    const { pass } = await createPass()
    expect((await api('POST', `/guests/${pass.id}/revoke`, {}, luca)).statusCode).toBe(404)
  })
})

describe('the guest link', () => {
  it('shows the pass and opens its doors without login, publishing guest.opened', async () => {
    const { pass, token } = await createPass({ doorIds: [doorId(1), doorId(2)], maxOpens: 5 })
    const p = phone()
    const view = (await p.view(token)).json() as GuestViewDto
    expect(view).toMatchObject({
      name: 'Mario',
      status: 'active',
      pinRequired: false,
      otherDevice: false,
      opensLeft: 5,
    })
    expect(view.doors.map((d) => d.id)).toEqual([doorId(1), doorId(2)])

    const before = opens()
    published.length = 0
    const r = await p.open(token, doorId(2))
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(opens()).toBe(before + 1)
    expect(published.map((e) => e.type)).toEqual(['guest.opened'])
    expect(published[0]!.door?.id).toBe(doorId(2))
    expect(published[0]!.data).toMatchObject({ guestName: 'Mario', outcome: 'ok' })
    expect(ctx.guests.get(pass.id)).toMatchObject({ opens: 1 })
    expect((await api('GET', `/guests/${pass.id}/opens`)).json()[0]).toMatchObject({ outcome: 'ok', doorId: doorId(2) })
    const audit = ctx.audit.query({ limit: 1, offset: 0, action: 'guest-open-door' }).rows[0]!
    expect(audit).toMatchObject({ operatorName: 'guest:Mario', outcome: 'ok' })
  })

  it('refuses doors that are not in the pass and unknown links', async () => {
    const { token } = await createPass()
    const p = phone('10.0.0.2')
    expect((await p.open(token, doorId(3))).statusCode).toBe(404)
    expect((await p.view('A'.repeat(22))).json().code).toBe('guestNotFound')
  })

  it('binds to the first phone that opens a door; unbind lets another phone take it', async () => {
    const { pass, token } = await createPass({ bindDevice: true })
    const first = phone('10.0.1.1')
    const second = phone('10.0.1.2')
    // just looking does not bind
    await second.view(token)
    expect((await first.open(token, doorId(1))).statusCode).toBe(200)
    expect(ctx.guests.get(pass.id)!.boundAt).not.toBeNull()
    expect((await second.view(token)).json()).toMatchObject({ otherDevice: true })
    published.length = 0
    const refused = await second.open(token, doorId(1))
    expect(refused.json().code).toBe('guestOtherDevice')
    expect(published.map((e) => [e.type, e.data.outcome])).toEqual([['guest.refused', 'otherDevice']])
    expect((await first.open(token, doorId(1))).statusCode).toBe(200)

    await api('POST', `/guests/${pass.id}/unbind`, {})
    expect((await second.open(token, doorId(1))).statusCode).toBe(200)
    expect((await first.open(token, doorId(1))).json().code).toBe('guestOtherDevice')
  })

  it('a new link replaces the old one and frees the binding', async () => {
    const { pass, token } = await createPass({ bindDevice: true })
    const p = phone('10.0.2.1')
    expect((await p.open(token, doorId(1))).statusCode).toBe(200)
    const renewed = (await api('POST', `/guests/${pass.id}/link`, {})).json() as GuestLinkDto
    expect(renewed.token).not.toBe(token)
    expect(renewed.pass.boundAt).toBeNull()
    expect((await p.view(token)).statusCode).toBe(404)
    expect((await phone('10.0.2.2').open(renewed.token, doorId(1))).statusCode).toBe(200)
  })
})

describe('PIN', () => {
  it('is asked until the phone is bound, then no more', async () => {
    const { token } = await createPass({ bindDevice: true, pin: '4821' })
    const p = phone('10.0.3.1')
    expect((await p.view(token)).json()).toMatchObject({ pinRequired: true })
    expect((await p.open(token, doorId(1))).json().code).toBe('guestPinRequired')
    const wrong = await p.open(token, doorId(1), '0000')
    expect(wrong.json()).toMatchObject({ code: 'guestWrongPin', params: { left: 4 } })
    expect((await p.open(token, doorId(1), '4821')).statusCode).toBe(200)
    expect((await p.view(token)).json()).toMatchObject({ pinRequired: false })
    expect((await p.open(token, doorId(1))).statusCode).toBe(200)
  })

  it('without binding it is asked at every opening', async () => {
    const { token } = await createPass({ pin: '123456' })
    const p = phone('10.0.3.2')
    expect((await p.open(token, doorId(1), '123456')).statusCode).toBe(200)
    expect((await p.open(token, doorId(1))).json().code).toBe('guestPinRequired')
  })

  it('locks the pass after 5 wrong PINs; a new PIN or unbind unlocks it', async () => {
    const { pass, token } = await createPass({ pin: '4821' })
    for (let i = 1; i <= 4; i++)
      expect((await phone(`10.0.4.${i}`).open(token, doorId(1), '1111')).statusCode).toBe(403)
    published.length = 0
    expect((await phone('10.0.4.5').open(token, doorId(1), '1111')).json().code).toBe('guestStatus.locked')
    expect(published.map((e) => e.data.outcome)).toEqual(['locked'])
    // even the right PIN does not work any more
    expect((await phone('10.0.4.6').open(token, doorId(1), '4821')).json().code).toBe('guestStatus.locked')
    expect(ctx.guests.get(pass.id)).toMatchObject({ locked: true, status: 'locked' })

    await api('POST', `/guests/${pass.id}/unbind`, {})
    expect((await phone('10.0.4.7').open(token, doorId(1), '4821')).statusCode).toBe(200)
  })
})

describe('validity', () => {
  it('not yet valid, expired, outside the days/hours, used up and revoked passes do not open', async () => {
    const before = opens()
    const p = phone('10.0.5.1')
    const notYet = await createPass({ validFrom: inMinutes(60), validTo: inMinutes(120) })
    expect((await p.view(notYet.token)).json()).toMatchObject({ status: 'notYet' })
    expect((await p.open(notYet.token, doorId(1))).json().code).toBe('guestStatus.notYet')

    const expired = await createPass({ validFrom: inMinutes(-120), validTo: inMinutes(-1) })
    expect((await p.open(expired.token, doorId(1))).json().code).toBe('guestStatus.expired')

    const today = (new Date().getDay() + 6) % 7
    const otherDays = [0, 1, 2, 3, 4, 5, 6].map((d) => d !== today)
    const wrongDay = await createPass({ weekdays: otherDays, validTo: `${addDays(localDate(), 30)} 00:00` })
    expect((await p.open(wrongDay.token, doorId(1))).json().code).toBe('guestStatus.outsideHours')

    const revoked = await createPass()
    await api('POST', `/guests/${revoked.pass.id}/revoke`, {})
    expect((await p.open(revoked.token, doorId(1))).json().code).toBe('guestStatus.revoked')
    expect(opens()).toBe(before)

    const once = await createPass({ maxOpens: 1 })
    expect((await p.open(once.token, doorId(1))).statusCode).toBe(200)
    expect((await p.view(once.token)).json()).toMatchObject({ status: 'used', opensLeft: 0 })
    expect((await p.open(once.token, doorId(1))).json().code).toBe('guestStatus.used')
    expect(opens()).toBe(before + 1)
  })
})

describe('rate limiting', () => {
  it('blocks an address after 10 failed attempts, not the others', async () => {
    const { token } = await createPass()
    const attacker = phone('10.9.9.9')
    for (let i = 0; i < 10; i++) expect((await attacker.view(`${'B'.repeat(21)}${i}`)).statusCode).toBe(404)
    expect((await attacker.view(token)).statusCode).toBe(429)
    expect((await phone('10.9.9.10').view(token)).statusCode).toBe(200)
  })
})
