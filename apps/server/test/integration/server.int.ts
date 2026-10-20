/**
 * Server-side end-to-end integration: HTTP API → services → UDP protocol → FakeController,
 * and events coming back through listener → DB → API/WebSocket.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Reason } from '@uhppote-desk/protocol'
import { FakeController } from '@uhppote-desk/protocol/testing'
import type { WsMessage } from '@uhppote-desk/shared'
import { buildApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'
import { localDate } from '../../src/util/time.js'

const LISTEN_PORT = 60031
const SERIAL = 423187757

let fake: FakeController
let ctx: AppContext
let app: FastifyInstance
let adminCookie = ''
let generatedPassword = ''
let controllerId = 0
let dataDir = ''

function config(dir: string): AppConfig {
  return {
    httpPort: 0,
    httpHost: '127.0.0.1',
    dataDir: dir,
    secureCookies: false,
    sessionHours: 1,
    adminPassword: null,
    adminPasswordFromLegacyVariable: false,
    webDir: null,
    uhppote: {
      bindAddress: '127.0.0.1',
      broadcast: '127.0.0.1:1',
      listen: `127.0.0.1:${LISTEN_PORT}`,
      listenerPublic: `127.0.0.1:${LISTEN_PORT}`,
      timeoutMs: 400,
      retries: 1,
      debug: false,
    },
    healthIntervalSec: 3600,
    collectIntervalSec: 3600,
    timeSyncThresholdSec: 30,
    initialBackfill: 1000,
    backupHour: -1,
    backupKeep: 3,
    mqtt: null,
    publicUrl: null,
  }
}

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: (m: string) => console.error(m),
  debug: () => undefined,
}

async function api(method: string, url: string, body?: unknown, cookie = adminCookie): Promise<LightMyRequestResponse> {
  return app.inject({
    method: method as 'GET',
    url: `/api${url}`,
    headers: cookie ? { cookie } : {},
    ...(body !== undefined ? { payload: body as object } : {}),
  })
}

async function login(username: string, password: string): Promise<string> {
  const r = await api('POST', '/auth/login', { username, password }, '')
  expect(r.statusCode).toBe(200)
  const c = r.cookies.find((c) => c.name === 'uhd_session')!
  return `uhd_session=${c.value}`
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within the timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhppote-desk-test-'))
  fake = new FakeController({ id: SERIAL })
  await fake.start()
  ctx = createContext(config(dataDir), quiet, ':memory:')
  const admin = await ctx.auth.ensureAdmin(null)
  expect(admin.action).toBe('created-generated')
  generatedPassword = admin.password!
  await ctx.eventService.startListener()
  app = await buildApp(ctx)
})

afterAll(async () => {
  await ctx.eventService.stopListener()
  await app.close()
  ctx.db.close()
  await fake.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('authentication', () => {
  it('rejects unauthenticated requests and wrong credentials', async () => {
    expect((await api('GET', '/controllers', undefined, '')).statusCode).toBe(401)
    expect((await api('POST', '/auth/login', { username: 'admin', password: 'x' }, '')).statusCode).toBe(401)
  })

  it('forces a password change at first login', async () => {
    const cookie = await login('admin', generatedPassword)
    expect((await api('GET', '/controllers', undefined, cookie)).statusCode).toBe(403)
    expect(
      (
        await api(
          'POST',
          '/auth/password',
          { currentPassword: generatedPassword, newPassword: 'nuova-password-1' },
          cookie,
        )
      ).statusCode,
    ).toBe(200)
    adminCookie = await login('admin', 'nuova-password-1')
    expect((await api('GET', '/controllers')).statusCode).toBe(200)
  })
})

describe('controller', () => {
  it('registers the controller, brings it online and configures the listener', async () => {
    const r = await api('POST', '/controllers', {
      serial: SERIAL,
      name: 'Ingresso',
      host: fake.endpoint.host,
      port: fake.endpoint.port,
    })
    expect(r.statusCode).toBe(200)
    controllerId = r.json().id
    await ctx.health.check(controllerId)
    expect(ctx.hub.state(controllerId).online).toBe(true)
    expect(fake.listener).toMatchObject({ address: '127.0.0.1', port: LISTEN_PORT })
    const list = (await api('GET', '/controllers')).json()
    expect(list[0]).toMatchObject({ serial: SERIAL, online: true, firmware: 'v8.92' })
    expect(list[0].doors).toHaveLength(4)
  })

  it('full diagnostics', async () => {
    const r = await api('GET', `/controllers/${controllerId}/info`)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ device: { controller: SERIAL }, listener: { port: LISTEN_PORT } })
    expect(r.json().doors).toHaveLength(4)
  })

  it('time synchronisation', async () => {
    fake.clockOffsetMs = -3600_000
    const r = await api('POST', `/controllers/${controllerId}/time-sync`)
    expect(r.statusCode).toBe(200)
    expect(Math.abs(fake.clockOffsetMs)).toBeLessThan(5000)
  })

  it('door change sent to the controller', async () => {
    const door = (await api('GET', '/doors')).json().find((d: { door: number }) => d.door === 2)
    const r = await api('PUT', `/doors/${door.id}`, {
      name: 'Magazzino',
      active: true,
      attendance: false,
      mode: 2,
      delay: 7,
    })
    expect(r.json()).toMatchObject({ ok: true, pushError: null })
    expect(fake.doors[1]).toEqual({ mode: 2, delay: 7 })
    await api('PUT', `/doors/${door.id}`, { name: 'Magazzino', active: true, attendance: false, mode: 3, delay: 5 })
  })

  it('offline controller: error 504 and offline state', async () => {
    fake.offline = true
    try {
      const r = await api('GET', `/controllers/${controllerId}/info`)
      expect(r.statusCode).toBe(504)
      expect(r.json()).toMatchObject({ code: 'protocol.timeout', params: { controller: SERIAL } })
      await ctx.health.check(controllerId)
      expect(ctx.hub.state(controllerId).online).toBe(false)
      expect(ctx.hub.state(controllerId).lastErrorInfo).toMatchObject({ code: 'protocol.timeout' })
      // a failed door opening is recorded in the audit log, shown in the reader's language
      const door = (await api('GET', '/doors')).json()[0] as { id: number }
      expect((await api('POST', `/doors/${door.id}/open`)).statusCode).toBe(504)
      const audit = await app.inject({
        method: 'GET',
        url: '/api/audit?limit=1',
        headers: { cookie: adminCookie, 'accept-language': 'it-IT' },
      })
      expect(audit.json().rows[0]).toMatchObject({ action: 'open-door', outcome: 'error' })
      expect(audit.json().rows[0].error).toMatch(new RegExp(`^Nessuna risposta dal controller ${SERIAL} entro`))
    } finally {
      fake.offline = false
      await ctx.health.check(controllerId)
    }
    expect(ctx.hub.state(controllerId).online).toBe(true)
  })
})

let personId = 0
const CARD = 10058400

describe('people, cards and permissions', () => {
  it('time profile sent to all controllers', async () => {
    const r = await api('PUT', '/time-profiles/10', {
      name: 'Ufficio',
      validFrom: '2020-01-01',
      validTo: '2099-12-31',
      weekdays: [true, true, true, true, true, false, false],
      segments: [{ start: '08:00', end: '18:00' }],
      linkedTo: null,
    })
    expect(r.json()).toMatchObject({ ok: true, pushErrors: [] })
    expect(fake.profiles.get(10)).toMatchObject({ id: 10, segments: [{ start: '08:00', end: '18:00' }] })
  })

  it('person + card + permissions → card on the controller', async () => {
    const p = await api('POST', '/people', {
      code: 'E001',
      lastName: 'Rossi',
      firstName: 'Mario',
      validFrom: '2020-01-01',
      validTo: '2099-12-31',
      pin: 1234,
    })
    expect(p.statusCode).toBe(200)
    personId = p.json().id
    expect((await api('POST', '/cards', { number: CARD, personId })).statusCode).toBe(200)
    const doors = (await api('GET', '/doors')).json() as { id: number; door: number }[]
    const r = await api('PUT', `/people/${personId}/permissions`, {
      permissions: [
        { doorId: doors.find((d) => d.door === 1)!.id, profileId: null, firstCard: false },
        { doorId: doors.find((d) => d.door === 2)!.id, profileId: 10, firstCard: true },
      ],
    })
    expect(r.json()).toMatchObject({ ok: true, pushErrors: [] })
    expect(fake.cards).toEqual([
      {
        card: CARD,
        from: '2020-01-01',
        to: '2099-12-31',
        doors: [1, 10, 0, 0],
        pin: 1234,
        firstCard: [false, true, false, false],
      },
    ])
  })

  it('non Wiegand-26 card rejected', async () => {
    expect((await api('POST', '/cards', { number: 25665536, personId })).statusCode).toBe(400)
  })

  it('disabled person → card removed from the controller', async () => {
    const person = (await api('GET', `/people/${personId}`)).json()
    const body = { ...person, active: false }
    expect((await api('PUT', `/people/${personId}`, body)).json().pushErrors).toEqual([])
    expect(fake.cards).toHaveLength(0)
    await api('PUT', `/people/${personId}`, { ...person, active: true })
    expect(fake.cards).toHaveLength(1)
  })

  it('a controller that lost its memory is synchronised again when it comes back online', async () => {
    fake.offline = true
    await ctx.health.check(controllerId)
    expect(ctx.hub.state(controllerId).online).toBe(false)
    // factory reset / replacement / restarted simulator: no cards, no time profiles
    fake.cardSlots = []
    fake.profiles.clear()
    fake.offline = false
    await ctx.health.check(controllerId)
    expect(ctx.hub.state(controllerId).online).toBe(true)
    expect(fake.cards.map((c) => [c.card, c.doors])).toEqual([[CARD, [1, 10, 0, 0]]])
    expect(fake.profiles.get(10)).toBeDefined()
  })

  it('a different card count is only reported, nothing is deleted automatically', async () => {
    fake.offline = true
    await ctx.health.check(controllerId)
    fake.cardSlots.push({
      card: 10012345,
      from: '2020-01-01',
      to: '2099-12-31',
      doors: [1, 0, 0, 0],
      pin: 0,
      firstCard: [false, false, false, false],
    })
    fake.offline = false
    await ctx.health.check(controllerId)
    expect(fake.cards.map((c) => c.card).sort()).toEqual([10012345, CARD].sort())
    fake.cardSlots = fake.cardSlots.filter((c) => c?.card !== 10012345)
  })
})

describe('events', () => {
  it('swipe → listener → DB → API and WebSocket', async () => {
    const ws = await app.injectWS('/api/ws', { headers: { cookie: adminCookie } })
    const messages: WsMessage[] = []
    ws.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString()) as WsMessage))
    try {
      const ev = fake.swipe(CARD, 1)
      expect(ev.granted).toBe(true)
      await waitFor(() => messages.some((m) => m.type === 'event' && m.event.index === ev.index))
      const msg = messages.find((m) => m.type === 'event' && m.event.index === ev.index) as Extract<
        WsMessage,
        { type: 'event' }
      >
      expect(msg.event).toMatchObject({ card: CARD, personId, personName: 'Rossi Mario', granted: true, door: 1 })
      const list = (await api('GET', `/events?personId=${personId}`)).json()
      expect(list.rows.some((e: { index: number }) => e.index === ev.index)).toBe(true)
    } finally {
      ws.terminate()
    }
  })

  it('lost events (listener unreachable) recovered by the collector', async () => {
    const saved = { ...fake.listener }
    fake.listener = { address: '0.0.0.0', port: 0, interval: 0 }
    const missed = [fake.swipe(CARD, 1), fake.swipe(CARD, 3), fake.swipe(99999, 1)]
    fake.listener = saved
    // the next push reveals the gap in the indexes and triggers the recovery
    const next = fake.swipe(CARD, 1)
    await waitFor(async () => {
      const rows = (await api('GET', '/events?limit=50')).json().rows as { index: number }[]
      return [...missed, next].every((m) => rows.some((r) => r.index === m.index))
    })
    const denied = (await api('GET', '/events?granted=false')).json().rows as { index: number; reason: number }[]
    expect(denied.find((e) => e.index === missed[1]!.index)?.reason).toBe(Reason.NoAccessRights)
  })

  it('unknown card offered for registration', async () => {
    fake.swipe(10077777, 1)
    await waitFor(async () =>
      (await api('GET', '/cards/unknown')).json().some((c: { card: number }) => c.card === 10077777),
    )
  })

  it('export CSV in the requested language', async () => {
    const r = await api('GET', '/events/export.csv')
    expect(r.headers['content-type']).toContain('text/csv')
    expect(r.body).toContain('Rossi Mario')
    expect(r.body).toContain('Date/time;Controller;Door')
    const it = await api('GET', '/events/export.csv?lang=it')
    expect(it.body).toContain('Data/ora;Controller;Porta')
    expect(it.body).toContain('Nessun diritto di accesso')
  })

  it('API errors carry a translatable code and parameters', async () => {
    const r = await api('PUT', '/time-profiles/20', {
      name: 'x',
      validFrom: '2026-01-01',
      validTo: '2026-12-31',
      weekdays: [true, true, true, true, true, false, false],
      segments: [{ start: '10:00', end: '09:00' }],
      linkedTo: null,
    })
    expect(r.statusCode).toBe(400)
    expect(r.json()).toEqual({
      error: 'Invalid interval: 10:00-09:00',
      code: 'invalidSegment',
      params: { start: '10:00', end: '09:00' },
    })
    expect((await api('GET', '/people/999999')).json()).toMatchObject({ code: 'personNotFound' })
  })
})

describe('synchronisation', () => {
  it('detects and removes foreign cards on the controller', async () => {
    fake.cardSlots.push({
      card: 10011111,
      from: '2020-01-01',
      to: '2099-12-31',
      doors: [1, 1, 1, 1],
      pin: 0,
      firstCard: [false, false, false, false],
    })
    const diff = (await api('GET', `/controllers/${controllerId}/sync/diff`)).json()
    expect(diff).toMatchObject({ toAdd: [], toUpdate: [], toDelete: [10011111], unchanged: 1 })
    const r = await api('POST', `/controllers/${controllerId}/sync/cards`)
    expect(r.statusCode).toBe(200)
    expect(fake.cards.map((c) => c.card)).toEqual([CARD])
  })

  it('full synchronisation: settings and tasks', async () => {
    const settings = (await api('GET', `/controllers/${controllerId}/settings`)).json()
    const r1 = await api('PUT', `/controllers/${controllerId}/settings?push=false`, {
      ...settings,
      interlock: 3,
      antipassback: 2,
      keypads: [true, false, false, false],
    })
    expect(r1.statusCode).toBe(200)
    expect(
      (
        await api('POST', '/tasks', {
          controllerId,
          door: 1,
          task: 1,
          validFrom: '2026-01-01',
          validTo: '2026-12-31',
          weekdays: [true, true, true, true, true, false, false],
          startTime: '08:00',
        })
      ).json().pushError,
    ).toBeNull()
    const r = await api('POST', `/controllers/${controllerId}/sync/all`)
    expect(r.statusCode).toBe(200)
    expect(fake.interlock).toBe(3)
    expect(fake.antipassback).toBe(2)
    expect(fake.keypads).toEqual([true, false, false, false])
    expect(fake.tasksActive).toHaveLength(1)
    expect(fake.recordSpecialEvents).toBe(true)
  })

  it('expansion board: default not installed, never written to the controller', async () => {
    const settings = (await api('GET', `/controllers/${controllerId}/settings`)).json()
    expect(settings.expansionBoard).toMatchObject({ installed: false, doorOpenTooLong: 25, duressCode: null })
    expect(settings.expansionBoard.relays).toHaveLength(4)
    const before = fake.parameterWrites
    expect((await api('PUT', `/controllers/${controllerId}/settings`, settings)).statusCode).toBe(200)
    expect(fake.parameterWrites).toBe(before)
  })

  it('expansion board: saved, pushed with the settings and by the full synchronisation', async () => {
    const settings = (await api('GET', `/controllers/${controllerId}/settings`)).json()
    const relays = [
      { active: true, source: 0, mode: 1, events: 0x04, signals: 0, duration: 5 },
      { active: true, source: 0, mode: 3, events: 0x02, signals: 0, duration: 0 },
      { active: false, source: 2, mode: 1, events: 0x27, signals: 0, duration: 10 },
      { active: true, source: 1, mode: 4, events: 0, signals: 0x82, duration: 30 },
    ]
    const expansionBoard = { installed: true, relays, doorOpenTooLong: 12, duressCode: 889988 }
    const r = await api('PUT', `/controllers/${controllerId}/settings`, { ...settings, expansionBoard })
    expect(r.statusCode).toBe(200)
    expect((await api('GET', `/controllers/${controllerId}/settings`)).json().expansionBoard).toEqual(expansionBoard)
    const inactive = { active: false, source: 0, mode: 0, events: 0, signals: 0, duration: 0 }
    const expected = { relays: [relays[0], relays[1], inactive, relays[3]], doorOpenTooLong: 12, duressCode: 889988 }
    expect(fake.expansionBoard()).toEqual(expected)
    // the full synchronisation writes it again
    fake.parameters.fill(0)
    expect((await api('POST', `/controllers/${controllerId}/sync/all`)).statusCode).toBe(200)
    expect(fake.expansionBoard()).toEqual(expected)
    // uninstalled: kept in the database but no longer written
    const before = fake.parameterWrites
    await api('PUT', `/controllers/${controllerId}/settings`, {
      ...settings,
      expansionBoard: { ...expansionBoard, installed: false },
    })
    expect(fake.parameterWrites).toBe(before)
  })

  it('expansion board: the write is verified by reading the table back', async () => {
    const settings = (await api('GET', `/controllers/${controllerId}/settings`)).json()
    const expansionBoard = {
      installed: true,
      doorOpenTooLong: 20,
      duressCode: null,
      relays: [
        { active: true, source: 0, mode: 1, events: 0x14, signals: 0, duration: 8 },
        { active: false, source: 1, mode: 1, events: 0x27, signals: 0, duration: 10 },
        { active: false, source: 2, mode: 1, events: 0x27, signals: 0, duration: 10 },
        { active: false, source: 3, mode: 1, events: 0x27, signals: 0, duration: 10 },
      ],
    }
    const r = await api('PUT', `/controllers/${controllerId}/settings`, { ...settings, expansionBoard })
    expect(r.json().expansion).toEqual({ verified: true, mismatches: [] })
    // read from the controller: aligned
    const read = (await api('GET', `/controllers/${controllerId}/expansion-board`)).json()
    expect(read).toMatchObject({
      doorOpenTooLong: 20,
      recordAlarmEvents: true,
      alarmEvents: 0x14 | 0x08 | 0x20,
      mismatches: [],
    })
    expect(read.relays[0]).toEqual(expansionBoard.relays[0])
    expect(read.relays[1]).toEqual({ active: false, source: 0, mode: 0, events: 0, signals: 0, duration: 0 })
    // changed outside UHPPOTE Desk (e.g. by the vendor software): reported
    fake.parameters[138] = 0x01
    const changed = (await api('GET', `/controllers/${controllerId}/expansion-board`)).json()
    expect(changed.mismatches).toEqual([{ index: 138, expected: 0x14, actual: 0x01 }])
    // a firmware without the long-packet read: saved and sent, verification unavailable
    fake.longPackets = false
    try {
      const r2 = await api('PUT', `/controllers/${controllerId}/settings`, { ...settings, expansionBoard })
      expect(r2.statusCode).toBe(200)
      expect(r2.json().expansion).toMatchObject({ verified: null, mismatches: [] })
      expect((await api('GET', `/controllers/${controllerId}/expansion-board`)).statusCode).toBeGreaterThanOrEqual(500)
    } finally {
      fake.longPackets = true
    }
    // board not connected: read works, no comparison
    await api('PUT', `/controllers/${controllerId}/settings?push=false`, {
      ...settings,
      expansionBoard: { ...expansionBoard, installed: false },
    })
    expect((await api('GET', `/controllers/${controllerId}/expansion-board`)).json().mismatches).toBeNull()
  })

  it('expansion board: invalid values are rejected (400)', async () => {
    const settings = (await api('GET', `/controllers/${controllerId}/settings`)).json()
    const bad = (patch: object) =>
      api('PUT', `/controllers/${controllerId}/settings?push=false`, {
        ...settings,
        expansionBoard: { ...settings.expansionBoard, ...patch },
      })
    expect((await bad({ doorOpenTooLong: 0 })).statusCode).toBe(400)
    expect((await bad({ duressCode: 1_000_000 })).statusCode).toBe(400)
    expect((await bad({ relays: settings.expansionBoard.relays.slice(0, 3) })).statusCode).toBe(400)
    const relays = structuredClone(settings.expansionBoard.relays)
    relays[0].source = 5
    expect((await bad({ relays })).statusCode).toBe(400)
  })

  it('settings saved without expansionBoard (older clients) get the default', async () => {
    const { expansionBoard: _drop, ...settings } = (await api('GET', `/controllers/${controllerId}/settings`)).json()
    expect((await api('PUT', `/controllers/${controllerId}/settings?push=false`, settings)).statusCode).toBe(200)
    expect((await api('GET', `/controllers/${controllerId}/settings`)).json().expansionBoard.installed).toBe(false)
  })
})

describe('roles and audit', () => {
  it('a read-only user cannot open doors', async () => {
    const created = (
      await api('POST', '/operators', {
        username: 'lettore',
        displayName: 'Lettore',
        role: 'viewer',
        password: 'password-lettore',
      })
    ).json()
    expect(created.id).toBeGreaterThan(0)
    let cookie = await login('lettore', 'password-lettore')
    await api(
      'POST',
      '/auth/password',
      { currentPassword: 'password-lettore', newPassword: 'password-lettore-2' },
      cookie,
    )
    cookie = await login('lettore', 'password-lettore-2')
    const door = (await api('GET', '/doors', undefined, cookie)).json()[0]
    expect((await api('POST', `/doors/${door.id}/open`, undefined, cookie)).statusCode).toBe(403)
    expect((await api('GET', '/operators', undefined, cookie)).statusCode).toBe(403)
  })

  it('remote opening is performed and recorded in the audit log', async () => {
    const door = (await api('GET', '/doors')).json()[0]
    const before = fake.lastEventIndex
    expect((await api('POST', `/doors/${door.id}/open`)).statusCode).toBe(200)
    expect(fake.events.at(-1)).toMatchObject({ reason: Reason.RemoteOpenDoor, door: 1 })
    expect(fake.lastEventIndex).toBe(before + 1)
    const audit = (await api('GET', '/audit?action=open-door')).json()
    expect(audit.rows[0]).toMatchObject({ action: 'open-door', operatorName: 'admin', outcome: 'ok' })
  })
})

describe('lost card and person deletion', () => {
  it('replacement: old one removed, new one active', async () => {
    const card = (await api('GET', '/cards')).json().find((c: { number: number }) => c.number === CARD)
    const r = await api('POST', `/cards/${card.id}/replace`, { newNumber: 10058401 })
    expect(r.json().pushErrors).toEqual([])
    expect(fake.cards.map((c) => c.card)).toEqual([10058401])
    fake.swipe(CARD, 1)
    expect(fake.events.at(-1)).toMatchObject({ granted: false, reason: Reason.NoAccessRights })
  })

  it('person deletion: cards removed from the controller', async () => {
    expect((await api('DELETE', `/people/${personId}`)).json().pushErrors).toEqual([])
    expect(fake.cards).toHaveLength(0)
  })
})

describe('attendance', () => {
  it('report from punches on the attendance reader', async () => {
    const doors = (await api('GET', '/doors')).json() as { id: number; door: number; name: string }[]
    const d1 = doors.find((d) => d.door === 1)!
    await api('PUT', `/doors/${d1.id}`, { name: d1.name, active: true, attendance: true, mode: 3, delay: 5 })
    const p = (
      await api('POST', '/people', {
        code: 'E002',
        lastName: 'Verdi',
        firstName: 'Anna',
        validFrom: '2020-01-01',
        validTo: '2099-12-31',
      })
    ).json()
    await api('POST', '/cards', { number: 10058402, personId: p.id })
    await api('PUT', `/people/${p.id}/permissions`, {
      permissions: [{ doorId: d1.id, profileId: null, firstCard: false }],
    })
    const a = fake.swipe(10058402, 1, 1)
    const b = fake.swipe(10058402, 1, 2)
    await waitFor(async () => (await api('GET', `/events?personId=${p.id}`)).json().total >= 2)
    const today = localDate()
    const report = (await api('GET', `/attendance/report?from=${today}&to=${today}&personId=${p.id}`)).json()
    expect(report).toHaveLength(1)
    expect(report[0]).toMatchObject({
      personName: 'Verdi Anna',
      status: 'presente',
      firstIn: a.timestamp!.slice(11, 16),
      lastOut: b.timestamp!.slice(11, 16),
    })
  })
})
