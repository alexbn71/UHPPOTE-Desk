/**
 * Notifications: Telegram (messages, open-door button, /id), ntfy, Gotify, email (SMTP),
 * daily report, secrets masking — against local fake servers and the FakeController.
 */
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeController } from '@uhppote-desk/protocol/testing'
import { SECRET_MASK, type NotificationChannelDto } from '@uhppote-desk/shared'
import { buildApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'
import { NotificationService } from '../../src/services/notify/notifications.js'
import { localDateTime } from '../../src/util/time.js'

const LISTEN_PORT = 60034
const SERIAL = 423187761
const PASSWORD = 'Notify-Test-1'
const BOT = '123456:TEST-TOKEN'
const CHAT = '-1001234'
const ALLOWED_USER = 42
const OPEN_DOOR = 0x40

interface Hit {
  path: string
  headers: http.IncomingHttpHeaders
  body: Record<string, any>
}

let fake: FakeController
let ctx: AppContext
let app: FastifyInstance
let cookie = ''
let controllerId = 0
let dataDir = ''
let httpServer: http.Server
let base = ''
let smtp: SMTPServer
let smtpPort = 0
const hits: Hit[] = []
const mails: { from: string; to: string[]; raw: string }[] = []
/** Updates the fake Telegram API returns to getUpdates. */
const updates: object[] = []
let updateId = 1

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

const doorId = (n: number) => ctx.controllers.doorByNumber(controllerId, n)!.id
const sent = (method: string) => hits.filter((h) => h.path === `/bot${BOT}/${method}`)
const opens = () => fake.requestCount.get(OPEN_DOOR) ?? 0

async function createChannel(body: Record<string, unknown>): Promise<NotificationChannelDto> {
  const r = await api('POST', '/notifications', { name: 'Test', language: 'it', doorIds: [], ...body })
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}

const telegram = (extra: Record<string, unknown> = {}) => ({
  type: 'telegram',
  botToken: BOT,
  chatId: CHAT,
  openButton: true,
  allowedUserIds: [ALLOWED_USER],
  ...extra,
})

function pressButton(data: string, userId = ALLOWED_USER): void {
  updates.push({ update_id: updateId++, callback_query: { id: `cb${updateId}`, from: { id: userId, username: 'mario' }, data, message: { chat: { id: Number(CHAT) } } } })
}

beforeAll(async () => {
  // one fake HTTP server for the Telegram Bot API, ntfy and Gotify
  httpServer = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, any>) : {}
      const url = req.url ?? ''
      if (url.endsWith('/getUpdates')) {
        // like Telegram: updates are lost only when they reach a client still listening
        const reply = () => {
          if (req.socket.destroyed) return
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result: updates.splice(0) }))
        }
        return void (updates.length ? reply() : setTimeout(reply, 100))
      }
      hits.push({ path: url, headers: req.headers, body })
      if (url.startsWith('/fail')) return void res.writeHead(500).end('broken')
      if (url.startsWith('/bot')) return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, result: {} }))
      res.writeHead(200).end('{}')
    })
  })
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`

  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, session, cb) {
      let raw = ''
      stream.on('data', (c: Buffer) => (raw += c.toString()))
      stream.on('end', () => {
        mails.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), raw })
        cb()
      })
    },
  })
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r))
  smtpPort = (smtp.server.address() as AddressInfo).port

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-notify-'))
  fake = new FakeController({ id: SERIAL })
  await fake.start()
  ctx = createContext(config(dataDir), quiet, ':memory:')
  ctx.notificationService = new NotificationService(ctx.notifications, ctx.integrationEvents, { controllers: ctx.controllers, events: ctx.events, gateway: ctx.gateway }, {
    telegramApi: base,
    timeoutMs: 3000,
    retryDelayMs: 50,
    logger: quiet,
  })
  await ctx.auth.ensureAdmin(PASSWORD)
  await ctx.eventService.startListener()
  app = await buildApp(ctx)
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PASSWORD } })
  cookie = `uhd_session=${login.cookies.find((c) => c.name === 'uhd_session')!.value}`
  controllerId = ctx.controllers.create({ serial: SERIAL, name: 'Villa', host: fake.endpoint.host, port: fake.endpoint.port, transport: 'udp', zoneId: null, enabled: true })
  ctx.controllers.updateDoor(doorId(1), { ...ctx.controllers.door(doorId(1))!, name: 'Cancello' })
  await ctx.health.check(controllerId)
  ctx.notificationService.start()
})

afterAll(async () => {
  ctx.notificationService.stop()
  await ctx.eventService.stopListener()
  await app.close()
  ctx.db.close()
  await fake.stop()
  await new Promise<void>((r) => httpServer.close(() => r()))
  await new Promise<void>((r) => smtp.close(() => r()))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await ctx.notificationService.idle()
  for (const c of ctx.notifications.list()) ctx.notifications.delete(c.id)
  ctx.notificationService.refresh()
  hits.length = 0
  mails.length = 0
  updates.length = 0
})

describe('channel management', () => {
  it('masks the credentials and keeps them when the mask is sent back', async () => {
    const c = await createChannel({ events: ['alarm'], config: telegram() })
    expect(c.config).toMatchObject({ type: 'telegram', botToken: SECRET_MASK, chatId: CHAT })
    const r = await api('PUT', `/notifications/${c.id}`, { ...c, name: 'Renamed' })
    expect(r.statusCode, r.body).toBe(200)
    expect(ctx.notifications.get(c.id)!.config).toMatchObject({ botToken: BOT })
    expect(JSON.stringify((await api('GET', '/notifications')).json())).not.toContain(BOT)
    const audit = ctx.db.all<{ details: string }>("SELECT details FROM audit_log WHERE action LIKE '%-notification'")
    expect(JSON.stringify(audit)).not.toContain(BOT)
  })

  it('validates the input', async () => {
    const bad = (body: object) => api('POST', '/notifications', { name: 'x', language: 'it', ...body }).then((r) => r.statusCode)
    expect(await bad({ events: [], dailyReport: false, config: telegram() })).toBe(400)
    expect(await bad({ events: ['alarm'], config: telegram({ allowedUserIds: [] }) })).toBe(400)
    expect(await bad({ events: ['alarm'], config: { type: 'email', host: 'smtp', from: 'a@b.c', to: ['not-an-email'] } })).toBe(400)
    expect(await bad({ events: ['alarm'], config: { type: 'ntfy', topic: 'bad topic!' } })).toBe(400)
  })
})

describe('Telegram', () => {
  it('sends the event with an open button, and the button opens the door', async () => {
    await createChannel({ events: ['access.denied'], config: telegram() })
    fake.swipe(10058400, 1)
    await waitFor(() => sent('sendMessage').length === 1)
    const msg = sent('sendMessage')[0]!.body
    expect(msg.chat_id).toBe(CHAT)
    expect(msg.parse_mode).toBe('HTML')
    expect(msg.text).toContain('🚫 <b>Accesso negato — Cancello</b>')
    expect(msg.text).toContain('tessera sconosciuta 10058400')
    const button = msg.reply_markup.inline_keyboard[0][0]
    expect(button.text).toBe('🔓 Apri Cancello')
    expect(button.callback_data.length).toBeLessThanOrEqual(64)

    const before = opens()
    pressButton(button.callback_data)
    await waitFor(() => sent('answerCallbackQuery').length === 1)
    expect(opens()).toBe(before + 1)
    expect(sent('answerCallbackQuery')[0]!.body.text).toBe('Cancello aperta')
    await waitFor(() => sent('sendMessage').some((h) => /aperta da @mario/.test(h.body.text)))
    const audit = ctx.db.get<{ operator_name: string; details: string }>("SELECT operator_name, details FROM audit_log WHERE action = 'open-door' ORDER BY id DESC LIMIT 1")!
    expect(audit.operator_name).toBe('telegram:mario')
    expect(JSON.parse(audit.details)).toMatchObject({ source: 'telegram', telegramUserId: ALLOWED_USER })
  })

  it('refuses other users, forged and expired buttons', async () => {
    const c = await createChannel({ events: ['access.denied'], config: telegram() })
    const sign = (payload: string) => createHmac('sha256', BOT).update(payload).digest('base64url').slice(0, 16)
    const now = Math.floor(Date.now() / 1000)
    const valid = `${c.id}:${doorId(1)}:${now}`
    const before = opens()

    pressButton(`o:${valid}:${sign(valid)}`, 999) // user not allowed
    pressButton(`o:${c.id}:${doorId(2)}:${now}:${sign(valid)}`) // door changed, signature of another door
    const old = `${c.id}:${doorId(1)}:${now - 3600}`
    pressButton(`o:${old}:${sign(old)}`) // expired
    await waitFor(() => sent('answerCallbackQuery').length === 3)
    expect(opens()).toBe(before)
    expect(sent('answerCallbackQuery').map((h) => h.body.text)).toEqual([
      'Non sei autorizzato ad aprire questa porta da Telegram',
      'Non sei autorizzato ad aprire questa porta da Telegram',
      'Questo pulsante è scaduto: usa una notifica più recente',
    ])
  })

  it('answers /id with the chat and user ids', async () => {
    await createChannel({ events: ['alarm'], config: telegram() })
    updates.push({ update_id: updateId++, message: { chat: { id: 777 }, from: { id: 55 }, text: '/id' } })
    await waitFor(() => sent('sendMessage').length === 1)
    expect(sent('sendMessage')[0]!.body).toMatchObject({ chat_id: 777, text: expect.stringContaining('Chat ID: 777') })
    expect(sent('sendMessage')[0]!.body.text).toContain('Il tuo user ID: 55')
  })
})

describe('ntfy, Gotify and email', () => {
  it('ntfy: JSON publish with priority, tags and token', async () => {
    await createChannel({ events: ['access.denied'], language: 'en', config: { type: 'ntfy', serverUrl: `${base}/ntfy`, topic: 'doors', token: 'tk_abc' } })
    fake.swipe(10058400, 2)
    await waitFor(() => hits.some((h) => h.path === '/ntfy'))
    const h = hits.find((x) => x.path === '/ntfy')!
    expect(h.headers.authorization).toBe('Bearer tk_abc')
    expect(h.body).toMatchObject({ topic: 'doors', title: 'Access denied — Villa - Door 2', priority: 4, tags: ['no_entry'] })
    expect(h.body.message).toContain('unknown card 10058400')
  })

  it('Gotify: message with the application token', async () => {
    const c = await createChannel({ events: ['alarm'], language: 'en', config: { type: 'gotify', serverUrl: `${base}/gotify`, appToken: 'AppTok' } })
    expect((await api('POST', `/notifications/${c.id}/test`)).json()).toEqual({ ok: true, error: null })
    const h = hits.find((x) => x.path === '/gotify/message')!
    expect(h.headers['x-gotify-key']).toBe('AppTok')
    expect(h.body).toMatchObject({ title: '🔔 Test notification', priority: 6 })
  })

  it('email: SMTP delivery to every recipient', async () => {
    const c = await createChannel({
      events: ['alarm'],
      config: { type: 'email', host: '127.0.0.1', port: smtpPort, secure: false, from: 'uhppote@example.com', to: ['a@example.com', 'b@example.com'] },
    })
    expect((await api('POST', `/notifications/${c.id}/test`)).json()).toEqual({ ok: true, error: null })
    expect(mails).toHaveLength(1)
    expect(mails[0]!.to).toEqual(['a@example.com', 'b@example.com'])
    expect(mails[0]!.raw).toMatch(/Subject: =\?UTF-8\?/)
    expect(mails[0]!.raw).toContain('Le notifiche di UHPPOTE Desk funzionano su questo canale.')
  })

  it('records failures and retries once', async () => {
    const c = await createChannel({ events: ['access.denied'], config: { type: 'gotify', serverUrl: `${base}/fail`, appToken: 'x' } })
    fake.swipe(10058400, 1)
    await waitFor(() => hits.filter((h) => h.path === '/fail/message').length === 2)
    await ctx.notificationService.idle()
    expect(ctx.notifications.get(c.id)!.lastError).toBe('HTTP 500: broken')
    expect((await api('POST', `/notifications/${c.id}/test`)).json()).toEqual({ ok: false, error: 'HTTP 500: broken' })
  })
})

describe('daily report', () => {
  it('lists who came in and the anomalies, once a day at the chosen hour', async () => {
    const person = ctx.people.create({ code: 'R1', firstName: 'Mario', lastName: 'Rossi', departmentId: null, email: '', phone: '', notes: '', pin: 0, validFrom: '2026-01-01', validTo: '2030-12-31', active: true, shiftId: null })
    ctx.people.createCard(10001234, person, 'active')
    const now = new Date()
    const at = (minAgo: number) => localDateTime(new Date(now.getTime() - minAgo * 60_000))
    const epoch = ctx.controllers.get(controllerId)!.eventEpoch
    let idx = 9000
    const add = (e: { type: number; granted: boolean; card: number; reason: number; ts: string; door?: number }) =>
      ctx.events.insert({ controllerId, epoch, index: idx++, type: e.type, granted: e.granted, door: e.door ?? 1, direction: 1, card: e.card, timestamp: e.ts, reason: e.reason })
    add({ type: 1, granted: true, card: 10001234, reason: 1, ts: at(300) })
    add({ type: 1, granted: true, card: 10001234, reason: 1, ts: at(60) })
    add({ type: 1, granted: false, card: 10009999, reason: 6, ts: at(30) })
    add({ type: 3, granted: false, card: 0, reason: 41, ts: at(20) })
    add({ type: 1, granted: true, card: 10001234, reason: 1, ts: at(60 * 30) }) // older than 24 h: not in the report

    const c = await createChannel({ events: [], dailyReport: true, reportHour: now.getHours(), config: telegram({ openButton: false, allowedUserIds: [] }) })
    await ctx.notificationService.tickReports(now)
    await ctx.notificationService.tickReports(now) // same day: not sent again
    expect(sent('sendMessage')).toHaveLength(1)
    const text = sent('sendMessage')[0]!.body.text as string
    expect(text).toContain('📋 <b>Resoconto giornaliero')
    expect(text).toContain('<b>Chi è entrato (1)</b>')
    expect(text).toMatch(/• Rossi Mario \d\d:\d\d–\d\d:\d\d \(Cancello\)/)
    // the swipes of the previous tests are in the last 24 hours too
    expect(text).toMatch(/<b>Accessi negati \(\d+\)<\/b>/)
    expect(text).toContain('Cancello — tessera sconosciuta 10009999: Nessun diritto di accesso')
    // only real alarms: not the controller power-on events
    expect(text).toContain('<b>Allarmi (1)</b>')
    expect(text).toContain('Cancello — Antifurto')
    expect(sent('sendMessage')[0]!.body.reply_markup).toBeUndefined()
    expect(ctx.notifications.get(c.id)!.lastReportDate).toBe(localDateTime(now).slice(0, 10))

    // "send now" from the API
    expect((await api('POST', `/notifications/${c.id}/report`)).json()).toEqual({ ok: true, error: null })
    expect(sent('sendMessage')).toHaveLength(2)
  })
})
