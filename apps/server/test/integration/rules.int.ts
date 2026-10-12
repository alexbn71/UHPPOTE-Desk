/**
 * Automation rules end to end: conditions on card and time, notification + webhook actions,
 * "door open for" timers, door-opening actions with the loop guard, cooldown, history and the
 * live message to the web app.
 */
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeController } from '@uhppote-desk/protocol/testing'
import type { RuleDto, RuleRunDto, WsMessage } from '@uhppote-desk/shared'
import { buildApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'
import { formatMinute, minuteOfDay } from '../../src/services/anomalies.js'
import { localDateTime } from '../../src/util/time.js'

const LISTEN_PORT = 60035
const SERIAL = 423187763
const PASSWORD = 'Rules-Test-1'
const OPEN_DOOR = 0x40
const CARD = 10058400
const OTHER_CARD = 10058401

let fake: FakeController
let ctx: AppContext
let app: FastifyInstance
let cookie = ''
let controllerId = 0
let dataDir = ''
let receiver: http.Server
let base = ''
let channelId = 0
let webhookId = 0
const hits: { path: string; body: Record<string, any> }[] = []
const live: WsMessage[] = []

const quiet = { info: () => undefined, warn: () => undefined, error: (m: string) => console.error(m), debug: () => undefined }

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
      listen: `127.0.0.1:${LISTEN_PORT}`,
      listenerPublic: `127.0.0.1:${LISTEN_PORT}`,
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
  }
}

async function api(method: string, url: string, body?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie }, ...(body !== undefined ? { payload: body as object } : {}) })
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within the timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const doorId = (n: number) => ctx.controllers.doorByNumber(controllerId, n)!.id
const gotify = () => hits.filter((h) => h.path === '/gotify/message')
const hooks = () => hits.filter((h) => h.path === '/hook')
const opens = () => fake.requestCount.get(OPEN_DOOR) ?? 0
const runs = (id: number) => ctx.rules.runs(id)

/** A window of ±1 hour around now, as HH:mm. */
function windowAroundNow(offsetHours = 0): { timeFrom: string; timeTo: string } {
  const now = minuteOfDay(localDateTime())
  const shift = (m: number) => formatMinute((((now + m + offsetHours * 60) % 1440) + 1440) % 1440)
  return { timeFrom: shift(-60), timeTo: shift(60) }
}

async function createRule(body: Record<string, unknown>): Promise<RuleDto> {
  const r = await api('POST', '/rules', { language: 'it', ...body })
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      hits.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : {} })
      res.writeHead(200).end('{}')
    })
  })
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-rules-'))
  fake = new FakeController({ id: SERIAL })
  await fake.start()
  ctx = createContext(config(dataDir), quiet, ':memory:')
  await ctx.auth.ensureAdmin(PASSWORD)
  await ctx.eventService.startListener()
  app = await buildApp(ctx)
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PASSWORD } })
  cookie = `uhd_session=${login.cookies.find((c) => c.name === 'uhd_session')!.value}`
  controllerId = ctx.controllers.create({ serial: SERIAL, name: 'Villa', host: fake.endpoint.host, port: fake.endpoint.port, transport: 'udp', zoneId: null, enabled: true })
  ctx.controllers.updateDoor(doorId(1), { ...ctx.controllers.door(doorId(1))!, name: 'Cancello' })
  await ctx.health.check(controllerId)

  channelId = ctx.notifications.create({
    name: 'Gotify',
    enabled: true,
    events: [],
    doorIds: [],
    language: 'it',
    dailyReport: true,
    reportHour: 3,
    config: { type: 'gotify', serverUrl: `${base}/gotify`, appToken: 'x' },
  })
  webhookId = ctx.webhooks.create({ name: 'Hook', url: `${base}/hook`, enabled: true, events: ['alarm'], doorIds: [], headers: {} })
  ctx.hub.on('message', (m) => m.type === 'rule' && live.push(m))
  ctx.ruleEngine.start()
})

afterAll(async () => {
  ctx.ruleEngine.stop()
  await ctx.eventService.stopListener()
  await app.close()
  ctx.db.close()
  await fake.stop()
  await new Promise<void>((r) => receiver.close(() => r()))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await ctx.notificationService.idle()
  await ctx.webhookService.idle()
  for (const r of ctx.rules.list()) ctx.rules.delete(r.id)
  hits.length = 0
  live.length = 0
})

describe('rule management', () => {
  it('creates, validates and lists rules', async () => {
    const r = await createRule({ name: 'Night badge', trigger: { type: 'access.granted' }, conditions: { cards: [CARD], ...windowAroundNow() } })
    expect(r).toMatchObject({ enabled: true, severity: 'warning', fireCount: 0, lastFiredAt: null, conditions: { cards: [CARD], personIds: [] } })
    expect((await api('POST', '/rules', { name: 'x', trigger: { type: 'nope' } })).statusCode).toBe(400)
    expect((await api('POST', '/rules', { name: 'x', trigger: { type: 'alarm' }, conditions: { timeFrom: '22:00' } })).statusCode).toBe(400)
    expect((await api('GET', '/rules')).json()).toHaveLength(1)
    expect((await app.inject({ method: 'GET', url: '/api/rules' })).statusCode).toBe(401)
  })
})

describe('event rules', () => {
  it('"card X in the time window": notification, webhook, history and live message', async () => {
    const r = await createRule({
      name: 'Badge X di notte',
      trigger: { type: 'access.denied' },
      conditions: { cards: [CARD], ...windowAroundNow() },
      actions: { channelIds: [channelId], webhookIds: [webhookId] },
      message: '{person} al {door} alle {time}',
    })
    fake.swipe(OTHER_CARD, 1) // other card: no firing
    fake.swipe(CARD, 1)
    await waitFor(() => gotify().length === 1 && hooks().length === 1)
    expect(gotify()[0]!.body).toMatchObject({ title: '⚠️ Badge X di notte', priority: 8 })
    expect(gotify()[0]!.body.message).toMatch(/^tessera sconosciuta 10058400 al Cancello alle \d\d:\d\d:\d\d$/)
    expect(hooks()[0]!.body).toMatchObject({ type: 'rule.triggered', door: { number: 1 }, data: { ruleId: r.id, rule: 'Badge X di notte', trigger: 'access.denied', event: { card: CARD } } })
    expect(runs(r.id)).toHaveLength(1)
    expect(runs(r.id)[0]).toMatchObject({ errors: [] })
    expect(live).toEqual([expect.objectContaining({ type: 'rule', ruleId: r.id, severity: 'warning' })])
    const listed = (await api('GET', '/rules')).json() as RuleDto[]
    expect(listed[0]).toMatchObject({ fireCount: 1 })
    expect(((await api('GET', `/rules/${r.id}/runs`)).json() as RuleRunDto[])[0]!.text).toContain('Cancello')
  })

  it('does not fire outside the time window or on other days', async () => {
    const outside = await createRule({ name: 'Outside', trigger: { type: 'access.denied' }, conditions: windowAroundNow(6) })
    const noDay = await createRule({ name: 'No day', trigger: { type: 'access.denied' }, conditions: { weekdays: [false, false, false, false, false, false, false] } })
    fake.swipe(CARD, 1)
    await sleep(300)
    expect(runs(outside.id)).toHaveLength(0)
    expect(runs(noDay.id)).toHaveLength(0)
  })

  it('respects the cooldown', async () => {
    const r = await createRule({ name: 'Once', trigger: { type: 'access.denied' }, cooldownSeconds: 60 })
    fake.swipe(CARD, 1)
    fake.swipe(CARD, 2)
    await waitFor(() => runs(r.id).length === 1)
    await sleep(300)
    expect(runs(r.id)).toHaveLength(1)
  })

  it('reports actions that cannot run', async () => {
    const r = await createRule({ name: 'Broken', trigger: { type: 'access.denied' }, actions: { channelIds: [999], openDoorIds: [998] } })
    fake.swipe(CARD, 1)
    await waitFor(() => runs(r.id).length === 1)
    expect(runs(r.id)[0]!.errors).toEqual(['Canale di notifica 999 mancante o disattivato', 'Porta 998 mancante o disattivata'])
  })
})

describe('door open too long', () => {
  // the API requires at least 10 seconds: the repository is used directly for a 1 second rule
  const openFor = (name: string, door: number) =>
    ctx.rules.create({
      name,
      enabled: true,
      severity: 'alarm',
      language: 'it',
      trigger: { type: 'door.open_for', seconds: 1 },
      conditions: { doorIds: [doorId(door)], personIds: [], cards: [], timeFrom: null, timeTo: null, weekdays: [true, true, true, true, true, true, true] },
      actions: { channelIds: [channelId], webhookIds: [], openDoorIds: [] },
      message: '',
      cooldownSeconds: 0,
    })

  it('fires when the door is still open after the time', async () => {
    const id = openFor('Porta 2 aperta', 2)
    fake.setDoorSensor(2, true)
    await waitFor(() => gotify().length === 1, 4000)
    expect(gotify()[0]!.body).toMatchObject({ title: '🚨 Porta 2 aperta', priority: 10, message: 'Villa - Door 2 aperta da 1 s' })
    expect(runs(id)).toHaveLength(1)
    fake.setDoorSensor(2, false)
  })

  it('does not fire if the door closes in time, nor for other doors', async () => {
    const id = openFor('Porta 3 aperta', 3)
    fake.setDoorSensor(3, true)
    await waitFor(() => ctx.ruleEngine.pendingTimers().length === 1)
    fake.setDoorSensor(3, false)
    fake.setDoorSensor(4, true)
    await waitFor(() => ctx.ruleEngine.pendingTimers().length === 0)
    await sleep(1500)
    expect(runs(id)).toHaveLength(0)
    fake.setDoorSensor(4, false)
  })
})

describe('door opening action', () => {
  it('opens the door, is audited, and does not retrigger rules on that door', async () => {
    const opener = await createRule({ name: 'Apri cancello', trigger: { type: 'access.denied' }, conditions: { cards: [CARD] }, actions: { openDoorIds: [doorId(4)] } })
    const watcher = await createRule({ name: 'Porta 4 aperta da remoto', trigger: { type: 'door.event' }, conditions: { doorIds: [doorId(4)] } })
    const before = opens()
    fake.swipe(CARD, 1)
    await waitFor(() => opens() === before + 1)
    await waitFor(() => runs(opener.id).length === 1)
    await sleep(500) // the remote-open event of door 4 arrives meanwhile
    expect(runs(watcher.id)).toHaveLength(0)
    const audit = ctx.db.get<{ operator_name: string; details: string }>("SELECT operator_name, details FROM audit_log WHERE action = 'open-door' ORDER BY id DESC LIMIT 1")!
    expect(audit.operator_name).toBe('rule:Apri cancello')
    expect(JSON.parse(audit.details)).toMatchObject({ door: 4, source: 'rule', ruleId: opener.id })
  })
})
