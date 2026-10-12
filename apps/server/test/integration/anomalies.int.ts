/**
 * Anomaly detection on the history (API), card revocation, settings, and the real-time
 * anomaly events published on the integration bus.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DeniedBurstDto, InactiveCardDto, UnusualAccessDto } from '@uhppote-desk/shared'
import { buildApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'
import type { IntegrationEvent } from '../../src/services/integrationEvents.js'
import { formatMinute, minuteOfDay } from '../../src/services/anomalies.js'
import { addDays, localDate, localDateTime } from '../../src/util/time.js'

const PASSWORD = 'Anomaly-Test-1'

let ctx: AppContext
let app: FastifyInstance
let cookie = ''
let controllerId = 0
let dataDir = ''
let index = 1
let mario = 0
let anna = 0
const busEvents: IntegrationEvent[] = []

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
      timeoutMs: 200,
      retries: 0,
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

async function api(method: string, url: string, body?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method: method as 'GET',
    url: `/api${url}`,
    headers: { cookie },
    ...(body !== undefined ? { payload: body as object } : {}),
  })
}

function person(code: string, lastName: string, card: number): number {
  const id = ctx.people.create({
    code,
    firstName: '',
    lastName,
    departmentId: null,
    email: '',
    phone: '',
    notes: '',
    pin: 0,
    validFrom: '2020-01-01',
    validTo: '2035-12-31',
    active: true,
    shiftId: null,
  })
  ctx.people.createCard(card, id, 'active')
  return id
}

/** Stores an event (and optionally publishes it like the event service does). */
function event(card: number, granted: boolean, timestamp: string, publish = false) {
  const e = ctx.events.insert({
    controllerId,
    epoch: 0,
    index: index++,
    type: 1,
    granted,
    door: 1,
    direction: 1,
    card,
    timestamp,
    reason: granted ? 1 : 6,
  })!
  if (publish) ctx.hub.publishEvent(e)
  return e
}

const today = localDate()
const period = `from=${addDays(today, -1)}&to=${today}`

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-anomalies-'))
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
    serial: 423187762,
    name: 'Office',
    host: '127.0.0.1',
    port: 1,
    transport: 'udp',
    zoneId: null,
    enabled: true,
  })

  // Mario: comes every day (weekends too) around 08:00–08:30 for 30 days
  mario = person('M1', 'Rossi', 10000001)
  for (let d = 30; d >= 2; d--) event(10000001, true, `${addDays(today, -d)} 08:${String(d % 30).padStart(2, '0')}:00`)
  // Anna: almost no history
  anna = person('A1', 'Bianchi', 10000002)
  event(10000002, true, `${addDays(today, -5)} 09:00:00`)

  ctx.integrationEvents.on('event', (e) => busEvents.push(e))
  ctx.integrationEvents.start()
})

afterAll(async () => {
  ctx.integrationEvents.stop()
  await app.close()
  ctx.db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('unusual times', () => {
  it('flags accesses far from the person habits, and night accesses without history', async () => {
    event(10000001, true, `${today} 08:20:00`) // usual
    event(10000001, true, `${today} 03:10:00`) // unusual hour
    event(10000002, true, `${today} 23:30:00`) // Anna: night
    event(10000002, true, `${today} 14:00:00`) // Anna: daytime, not enough history -> nothing
    const list = (await api('GET', `/anomalies/unusual?${period}`)).json() as UnusualAccessDto[]
    expect(list.map((u) => [u.personId, u.timestamp.slice(11, 16), u.kind])).toEqual([
      [mario, '03:10', 'hour'],
      [anna, '23:30', 'night'],
    ])
    expect(list[0]).toMatchObject({
      personName: 'Rossi',
      usualFrom: '08:02',
      usualTo: '08:28',
      samples: 29,
      doorName: 'Office - Door 1',
    })
    expect(list[1]).toMatchObject({ usualFrom: null, samples: 1 })
  })

  it('follows the settings', async () => {
    const settings = (await api('GET', '/anomalies/settings')).json()
    expect(settings).toMatchObject({ toleranceMinutes: 90, deniedCount: 3, inactiveDays: 90 })
    expect((await api('PUT', '/anomalies/settings', { ...settings, nightStart: '23:45' })).statusCode).toBe(200)
    const list = (await api('GET', `/anomalies/unusual?${period}`)).json() as UnusualAccessDto[]
    expect(list.map((u) => u.personId)).toEqual([mario]) // 23:30 is no longer night
    expect((await api('PUT', '/anomalies/settings', { ...settings, deniedCount: 1 })).statusCode).toBe(400)
    await api('PUT', '/anomalies/settings', settings)
  })
})

describe('repeated denied attempts', () => {
  it('groups the attempts of a card within the window', async () => {
    event(10009999, false, `${today} 10:00:00`)
    event(10009999, false, `${today} 10:03:00`)
    event(10009999, false, `${today} 10:07:00`)
    event(10008888, false, `${today} 10:00:00`)
    event(10008888, false, `${today} 10:30:00`)
    const list = (await api('GET', `/anomalies/denied?${period}`)).json() as DeniedBurstDto[]
    expect(list).toEqual([
      {
        card: 10009999,
        personId: null,
        personName: null,
        doors: ['Office - Door 1'],
        doorRefs: [{ controllerId, door: 1 }],
        count: 3,
        first: `${today} 10:00:00`,
        last: `${today} 10:07:00`,
        reasons: [6],
      },
    ])
  })
})

describe('inactive cards', () => {
  it('lists active cards unused for months and disables them', async () => {
    // a card created long ago and never used, and one last used 120 days ago
    person('O1', 'Old', 10000003)
    ctx.db.run('UPDATE cards SET created_at = ? WHERE number = 10000003', [`${addDays(today, -200)} 10:00:00`])
    person('O2', 'Gone', 10000004)
    ctx.db.run('UPDATE cards SET created_at = ? WHERE number = 10000004', [`${addDays(today, -300)} 10:00:00`])
    event(10000004, true, `${addDays(today, -120)} 09:00:00`)

    const list = (await api('GET', '/anomalies/inactive-cards')).json() as InactiveCardDto[]
    expect(list.map((c) => [c.number, c.daysInactive, c.lastUsedAt?.slice(0, 10) ?? null])).toEqual([
      [10000003, 200, null],
      [10000004, 120, addDays(today, -120)],
    ])

    const r = await api('POST', '/anomalies/inactive-cards/disable', { cardIds: list.map((c) => c.cardId) })
    expect(r.json()).toMatchObject({ disabled: 2 })
    expect(ctx.people.card(list[0]!.cardId)!.status).toBe('disabled')
    expect((await api('GET', '/anomalies/inactive-cards')).json()).toEqual([])
    const audit = ctx.db.all("SELECT target FROM audit_log WHERE action = 'disable-inactive-card'")
    expect(audit).toHaveLength(2)
  })
})

describe('real time', () => {
  it('publishes an unusual-time event for a new access', () => {
    // habits 6 hours away from now, so that "now" is unusual whatever time the test runs
    const now = new Date()
    const usual = formatMinute((minuteOfDay(localDateTime(now)) + 360) % 1440)
    const p = person('R1', 'Verdi', 10000005)
    for (let d = 20; d >= 1; d--) event(10000005, true, `${addDays(today, -d)} ${usual}:00`)
    busEvents.length = 0
    event(10000005, true, localDateTime(now), true)
    expect(busEvents.map((e) => e.type)).toEqual(['access.granted', 'anomaly.unusual_time'])
    expect(busEvents[1]!.data).toMatchObject({
      personId: p,
      kind: 'hour',
      usualFrom: usual,
      usualTo: usual,
      samples: 20,
    })
    expect(busEvents[1]!.door?.name).toBe('Office - Door 1')
  })

  it('publishes one repeated-denied event when the threshold is reached', () => {
    busEvents.length = 0
    const now = Date.now()
    for (let i = 4; i >= 0; i--) event(10007777, false, localDateTime(new Date(now - i * 60_000)), true)
    expect(busEvents.map((e) => e.type)).toEqual([
      'access.denied',
      'access.denied',
      'access.denied',
      'anomaly.repeated_denied',
      'access.denied',
      'access.denied',
    ])
    expect(busEvents[3]!.data).toMatchObject({ card: 10007777, count: 3, windowMinutes: 10 })
  })
})
