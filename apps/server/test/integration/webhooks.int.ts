/**
 * Outgoing webhooks: API, signature, filters, retries and delivery log,
 * with the FakeController as event source and a local HTTP endpoint as receiver.
 */
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeController } from '@uhppote-desk/protocol/testing'
import type { WebhookDeliveryDto, WebhookDto, WebhookPayload } from '@uhppote-desk/shared'
import { buildApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'
import { APP_VERSION } from '../../src/routes/system.js'
import { WebhookService } from '../../src/services/webhooks.js'

const LISTEN_PORT = 60033
const SERIAL = 423187759
const PASSWORD = 'Webhook-Test-1'

interface Received {
  path: string
  headers: http.IncomingHttpHeaders
  body: string
  payload: WebhookPayload
}

let fake: FakeController
let ctx: AppContext
let app: FastifyInstance
let receiver: http.Server
let receiverUrl = ''
let cookie = ''
let controllerId = 0
let dataDir = ''
const received: Received[] = []
/** Status codes to answer with, in order (then 200). */
let replies: number[] = []

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

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within the timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const doorId = (n: number) => ctx.controllers.doorByNumber(controllerId, n)!.id
const at = (p: string) => received.filter((r) => r.path === p)

async function createHook(body: Record<string, unknown>): Promise<WebhookDto> {
  const r = await api('POST', '/webhooks', { name: 'Test', enabled: true, headers: {}, doorIds: [], ...body })
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}

beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body, payload: JSON.parse(body) as WebhookPayload })
      const status = replies.shift() ?? 200
      res.writeHead(status, { 'Content-Type': 'text/plain' }).end(status === 200 ? 'ok' : 'nope')
    })
  })
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-webhooks-'))
  fake = new FakeController({ id: SERIAL })
  await fake.start()
  ctx = createContext(config(dataDir), quiet, ':memory:')
  // short retry delays for the tests
  ctx.webhookService = new WebhookService(ctx.webhooks, ctx.integrationEvents, {
    version: APP_VERSION,
    logger: quiet,
    retryDelaysMs: [50, 50],
    timeoutMs: 2000,
  })
  await ctx.auth.ensureAdmin(PASSWORD)
  await ctx.eventService.startListener()
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
  await ctx.health.check(controllerId)
  ctx.webhookService.start()
})

afterAll(async () => {
  ctx.webhookService.stop()
  await ctx.eventService.stopListener()
  await app.close()
  ctx.db.close()
  await fake.stop()
  await new Promise<void>((r) => receiver.close(() => r()))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  // isolate the tests: wait for pending deliveries, then remove every webhook
  await ctx.webhookService.idle()
  for (const w of ctx.webhooks.list()) ctx.webhooks.delete(w.id)
  received.length = 0
  replies = []
})

describe('webhook API', () => {
  it('creates a webhook with a generated secret and validates the input', async () => {
    const w = await createHook({ url: `${receiverUrl}/a`, events: ['access.granted'] })
    expect(w.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(w).toMatchObject({ enabled: true, events: ['access.granted'], lastDelivery: null })

    expect((await api('POST', '/webhooks', { name: 'x', url: 'ftp://host/x', events: ['alarm'] })).statusCode).toBe(400)
    expect((await api('POST', '/webhooks', { name: 'x', url: `${receiverUrl}/x`, events: [] })).statusCode).toBe(400)
    expect((await api('POST', '/webhooks', { name: 'x', url: `${receiverUrl}/x`, events: ['nope'] })).statusCode).toBe(
      400,
    )

    const regenerated = (await api('POST', `/webhooks/${w.id}/secret`)).json() as WebhookDto
    expect(regenerated.secret).not.toBe(w.secret)
  })

  it('is reserved to administrators', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/webhooks' })
    expect(r.statusCode).toBe(401)
  })

  it('does not write header values to the audit log', async () => {
    await createHook({ url: `${receiverUrl}/h`, events: ['alarm'], headers: { Authorization: 'Bearer very-secret' } })
    const row = ctx.db.get<{ details: string }>(
      "SELECT details FROM audit_log WHERE action = 'create-webhook' ORDER BY id DESC LIMIT 1",
    )!
    expect(row.details).toContain('Authorization')
    expect(row.details).not.toContain('very-secret')
  })
})

describe('delivery', () => {
  it('sends a signed request on a card swipe, with the custom headers', async () => {
    const w = await createHook({
      url: `${receiverUrl}/swipe`,
      events: ['access.denied'],
      headers: { Authorization: 'Bearer abc' },
    })
    fake.swipe(10058400, 1)
    await waitFor(() => at('/swipe').length === 1)
    const r = at('/swipe')[0]!
    expect(r.payload).toMatchObject({
      type: 'access.denied',
      controller: { id: controllerId, serial: SERIAL, name: 'Gate' },
      door: { number: 1, name: 'Gate - Door 1' },
      data: { card: 10058400, granted: false, direction: 'in' },
    })
    expect(r.headers['content-type']).toBe('application/json')
    expect(r.headers['authorization']).toBe('Bearer abc')
    expect(r.headers['x-uhppote-event']).toBe('access.denied')
    expect(r.headers['x-uhppote-delivery']).toBe(r.payload.id)
    const timestamp = r.headers['x-uhppote-timestamp'] as string
    const expected = createHmac('sha256', w.secret).update(`${timestamp}.${r.body}`).digest('hex')
    expect(r.headers['x-uhppote-signature']).toBe(`sha256=${expected}`)

    await ctx.webhookService.idle()
    const deliveries = (await api('GET', `/webhooks/${w.id}/deliveries`)).json() as WebhookDeliveryDto[]
    expect(deliveries[0]).toMatchObject({
      event: 'access.denied',
      ok: true,
      statusCode: 200,
      attempts: 1,
      deliveryId: r.payload.id,
    })
    expect((await api('GET', '/webhooks')).json()[0].lastDelivery).toMatchObject({ ok: true, statusCode: 200 })
  })

  it('filters by event type, door and enabled flag', async () => {
    await createHook({ url: `${receiverUrl}/door2`, events: ['access.denied'], doorIds: [doorId(2)] })
    await createHook({ url: `${receiverUrl}/granted`, events: ['access.granted'] })
    await createHook({ url: `${receiverUrl}/disabled`, events: ['access.denied'], enabled: false })
    fake.swipe(10058400, 1)
    fake.swipe(10058400, 2)
    await waitFor(() => at('/door2').length === 1)
    await ctx.webhookService.idle()
    expect(at('/door2')[0]!.payload.door).toMatchObject({ number: 2 })
    expect(at('/granted')).toHaveLength(0)
    expect(at('/disabled')).toHaveLength(0)
  })

  it('retries server errors and records the attempts', async () => {
    const w = await createHook({ url: `${receiverUrl}/retry`, events: ['door.event'] })
    replies = [500, 503]
    await ctx.gateway.run(null, controllerId, 'open-door', null, (client, t) => client.openDoor(t, 3))
    await waitFor(() => at('/retry').length === 3)
    await ctx.webhookService.idle()
    // same delivery id at every attempt
    expect(new Set(at('/retry').map((r) => r.payload.id)).size).toBe(1)
    expect(at('/retry')[0]!.payload).toMatchObject({ type: 'door.event', door: { number: 3 } })
    expect(ctx.webhooks.deliveries(w.id)[0]).toMatchObject({ ok: true, attempts: 3, statusCode: 200 })
  })

  it('does not retry client errors and gives up after the last attempt', async () => {
    const bad = await createHook({ url: `${receiverUrl}/bad`, events: ['access.denied'] })
    const down = await createHook({ url: 'http://127.0.0.1:1/down', events: ['access.denied'] })
    replies = [404]
    fake.swipe(10058400, 1)
    await waitFor(() => at('/bad').length === 1)
    await ctx.webhookService.idle()
    expect(ctx.webhooks.deliveries(bad.id)[0]).toMatchObject({
      ok: false,
      statusCode: 404,
      attempts: 1,
      error: 'HTTP 404: nope',
    })
    expect(ctx.webhooks.deliveries(down.id)[0]).toMatchObject({ ok: false, statusCode: null, attempts: 3 })
  })

  it('reports controllers going offline and back online', async () => {
    await createHook({ url: `${receiverUrl}/health`, events: ['controller.offline', 'controller.online'] })
    fake.offline = true
    await ctx.health.check(controllerId)
    fake.offline = false
    await ctx.health.check(controllerId)
    await waitFor(() => at('/health').length === 2)
    expect(at('/health').map((r) => r.payload.type)).toEqual(['controller.offline', 'controller.online'])
    expect(at('/health')[0]!.payload).toMatchObject({ controller: { serial: SERIAL }, door: null })
  })

  it('reports door sensor changes', async () => {
    await createHook({ url: `${receiverUrl}/sensor`, events: ['door.opened', 'door.closed'] })
    fake.setDoorSensor(4, true)
    await waitFor(() => at('/sensor').length === 1)
    fake.setDoorSensor(4, false)
    await waitFor(() => at('/sensor').length === 2)
    expect(at('/sensor').map((r) => [r.payload.type, r.payload.door?.number])).toEqual([
      ['door.opened', 4],
      ['door.closed', 4],
    ])
  })

  it('sends a test request, also when the webhook is disabled', async () => {
    const w = await createHook({ url: `${receiverUrl}/test`, events: ['alarm'], enabled: false })
    const r = await api('POST', `/webhooks/${w.id}/test`)
    expect(r.json()).toMatchObject({ ok: true, statusCode: 200, event: 'webhook.test', attempts: 1 })
    expect(at('/test')[0]!.payload).toMatchObject({ type: 'webhook.test', controller: null })

    replies = [500]
    expect((await api('POST', `/webhooks/${w.id}/test`)).json()).toMatchObject({
      ok: false,
      statusCode: 500,
      attempts: 1,
    })
  })
})
