/**
 * Mobile app: remembered devices (expiry, logout, password change), door opening confirmed with
 * fingerprint/Face ID (a software WebAuthn authenticator), and Web Push notifications decrypted
 * like a browser would.
 */
import { createECDH, createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeController } from '@uhppote-desk/protocol/testing'
import type { MobileConfigDto, MobileDoorDto, PushPayload } from '@uhppote-desk/shared'
import { buildApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'
import { addDays, localDateTime } from '../../src/util/time.js'

const ece = createRequire(import.meta.url)('http_ece') as { decrypt: (b: Buffer, p: object) => Buffer }

const LISTEN_PORT = 60036
const SERIAL = 423187764
const PASSWORD = 'Mobile-Test-1'
const PUBLIC_URL = 'https://doors.example.com'
const OPEN_DOOR = 0x40

let fake: FakeController
let ctx: AppContext
let app: FastifyInstance
let adminCookie = ''
let controllerId = 0
let dataDir = ''
let pushServer: http.Server
let pushBase = ''
const pushes: { path: string; body: Buffer }[] = []
let pushStatus = 201

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
    publicUrl: PUBLIC_URL,
  }
}

async function api(method: string, url: string, cookie: string, body?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({ method: method as 'GET', url: `/api${url}`, headers: { cookie }, ...(body !== undefined ? { payload: body as object } : {}) })
}

/** Logs in; with `remember` the device cookie is returned instead of the session cookie. */
async function login(username: string, password: string, remember = false): Promise<{ cookie: string; names: string[]; user: Record<string, unknown> }> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password, remember, deviceName: 'Pixel 9' } })
  expect(r.statusCode, r.body).toBe(200)
  const set = r.cookies.filter((c) => c.value !== '')
  return { cookie: set.map((c) => `${c.name}=${c.value}`).join('; '), names: set.map((c) => c.name), user: r.json().user }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within the timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const doorId = (n: number) => ctx.controllers.doorByNumber(controllerId, n)!.id
const opens = () => fake.requestCount.get(OPEN_DOOR) ?? 0
const setMode = (openConfirmation: 'press' | 'biometric', sessionDays = 90) => ctx.mobile.saveSettings({ openConfirmation, sessionDays })

// --- software WebAuthn authenticator (platform authenticator with user verification) --------------

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url')

/** Minimal CBOR encoder: maps, byte strings, text strings, small integers. */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255])
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)])
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])])
  throw new Error('unsupported')
}

class SoftAuthenticator {
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject }
  readonly credentialId = randomBytes(16)
  private counter = 0

  constructor(private readonly rpID: string, private readonly origin: string) {
    this.key = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  }

  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }))
  }

  private authData(flags: number, extra = Buffer.alloc(0)) {
    const count = Buffer.alloc(4)
    count.writeUInt32BE(this.counter++)
    return Buffer.concat([createHash('sha256').update(this.rpID).digest(), Buffer.from([flags]), count, extra])
  }

  register(options: { challenge: string }) {
    const jwk = this.key.publicKey.export({ format: 'jwk' })
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]))
    const idLen = Buffer.alloc(2)
    idLen.writeUInt16BE(this.credentialId.length)
    const authData = this.authData(0x45, Buffer.concat([Buffer.alloc(16), idLen, this.credentialId, cose])) // UP + UV + AT
    const attestation = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge)), attestationObject: b64u(attestation), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }

  authenticate(options: { challenge: string }, userVerified = true) {
    const authData = this.authData(userVerified ? 0x05 : 0x01)
    const clientData = this.clientData('webauthn.get', options.challenge)
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), this.key.privateKey)
    return {
      id: b64u(this.credentialId),
      rawId: b64u(this.credentialId),
      type: 'public-key',
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }
}

beforeAll(async () => {
  pushServer = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      pushes.push({ path: req.url ?? '', body: Buffer.concat(chunks) })
      res.writeHead(pushStatus).end()
    })
  })
  await new Promise<void>((r) => pushServer.listen(0, '127.0.0.1', r))
  pushBase = `http://127.0.0.1:${(pushServer.address() as AddressInfo).port}`

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-mobile-'))
  fake = new FakeController({ id: SERIAL })
  await fake.start()
  ctx = createContext(config(dataDir), quiet, ':memory:')
  await ctx.auth.ensureAdmin(PASSWORD)
  await ctx.eventService.startListener()
  app = await buildApp(ctx)
  adminCookie = (await login('admin', PASSWORD)).cookie
  controllerId = ctx.controllers.create({ serial: SERIAL, name: 'Villa', host: fake.endpoint.host, port: fake.endpoint.port, transport: 'udp', zoneId: null, enabled: true })
  await ctx.health.check(controllerId)
  // an operator, and a second one restricted to a zone without controllers
  await api('POST', '/operators', adminCookie, { username: 'mario', displayName: 'Mario', role: 'operator', password: 'Mario-pass-1' })
  const zone = (await api('POST', '/zones', adminCookie, { name: 'Elsewhere', parentId: null })).json().id as number
  await api('POST', '/operators', adminCookie, { username: 'luca', displayName: 'Luca', role: 'operator', password: 'Luca-pass-11', zoneIds: [zone] })
  for (const u of ['mario', 'luca']) ctx.db.run('UPDATE operators SET must_change_password = 0 WHERE username = ?', [u])
  ctx.push.start()
})

afterAll(async () => {
  ctx.push.stop()
  await ctx.eventService.stopListener()
  await app.close()
  ctx.db.close()
  await fake.stop()
  await new Promise<void>((r) => pushServer.close(() => r()))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  setMode('press')
  pushes.length = 0
  pushStatus = 201
})

describe('remembered devices', () => {
  it('"remember" logs in with a device cookie only', async () => {
    const s = await login('mario', 'Mario-pass-1', true)
    expect(s.names).toEqual(['uhd_device'])
    expect(s.user).toMatchObject({ username: 'mario', deviceId: expect.any(Number) })
    const config = (await api('GET', '/mobile/config', s.cookie)).json() as MobileConfigDto
    expect(config).toMatchObject({ openConfirmation: 'press', sessionDays: 90, device: { name: 'Pixel 9', biometric: false, push: null } })
    expect(config.vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{87}$/)
    const devices = (await api('GET', '/mobile/devices', adminCookie)).json()
    expect(devices).toEqual([expect.objectContaining({ operatorName: 'mario', name: 'Pixel 9', biometric: false })])
    expect((await api('GET', '/mobile/devices', s.cookie)).statusCode).toBe(403)
  })

  it('expires after the configured days, unless fingerprint/Face ID is registered', async () => {
    const s = await login('mario', 'Mario-pass-1', true)
    const deviceId = s.user.deviceId as number
    ctx.db.run('UPDATE devices SET created_at = ? WHERE id = ?', [`${addDays(localDateTime().slice(0, 10), -100)} 10:00:00`, deviceId])
    setMode('press', 90)
    expect((await api('GET', '/auth/me', s.cookie)).statusCode).toBe(401)
    setMode('press', 120)
    expect((await api('GET', '/auth/me', s.cookie)).statusCode).toBe(200)
    expect((await api('PUT', '/mobile/settings', adminCookie, { openConfirmation: 'press', sessionDays: 45 })).statusCode).toBe(400)

    // with a registered credential the device never expires
    ctx.db.run('UPDATE devices SET created_at = ? WHERE id = ?', [`${addDays(localDateTime().slice(0, 10), -400)} 10:00:00`, deviceId])
    expect((await api('GET', '/auth/me', s.cookie)).statusCode).toBe(401)
    ctx.db.run("INSERT INTO webauthn_credentials (id, device_id, public_key) VALUES ('x', ?, x'00')", [deviceId])
    expect((await api('GET', '/auth/me', s.cookie)).statusCode).toBe(200)
  })

  it('logout forgets the device; a password change logs out the other devices', async () => {
    const a = await login('mario', 'Mario-pass-1', true)
    await api('POST', '/auth/logout', a.cookie)
    expect((await api('GET', '/auth/me', a.cookie)).statusCode).toBe(401)

    const phone = await login('mario', 'Mario-pass-1', true)
    const tablet = await login('mario', 'Mario-pass-1', true)
    expect((await api('POST', '/auth/password', phone.cookie, { currentPassword: 'Mario-pass-1', newPassword: 'Mario-pass-2' })).statusCode).toBe(200)
    expect((await api('GET', '/auth/me', phone.cookie)).statusCode).toBe(200)
    expect((await api('GET', '/auth/me', tablet.cookie)).statusCode).toBe(401)
    await api('POST', '/auth/password', phone.cookie, { currentPassword: 'Mario-pass-2', newPassword: 'Mario-pass-1' })
  })

  it('an administrator can revoke a device', async () => {
    const s = await login('mario', 'Mario-pass-1', true)
    expect((await api('DELETE', `/mobile/devices/${s.user.deviceId}`, adminCookie)).statusCode).toBe(200)
    expect((await api('GET', '/auth/me', s.cookie)).statusCode).toBe(401)
  })
})

describe('doors and opening', () => {
  it('lists the doors with the ones the user may open', async () => {
    const mario = await login('mario', 'Mario-pass-1', true)
    const luca = await login('luca', 'Luca-pass-11', true)
    const doors = (await api('GET', '/mobile/doors', mario.cookie)).json() as MobileDoorDto[]
    expect(doors).toHaveLength(4)
    expect(doors.every((d) => d.canOpen)).toBe(true)
    expect(((await api('GET', '/mobile/doors', luca.cookie)).json() as MobileDoorDto[]).some((d) => d.canOpen)).toBe(false)
  })

  it('press mode: a remembered device opens with a simple request', async () => {
    const s = await login('mario', 'Mario-pass-1', true)
    const before = opens()
    expect((await api('POST', `/doors/${doorId(1)}/open`, s.cookie, {})).statusCode).toBe(200)
    expect(opens()).toBe(before + 1)
  })

  it('biometric mode: fingerprint/Face ID required on remembered devices, verified, not replayable', async () => {
    setMode('biometric')
    const s = await login('mario', 'Mario-pass-1', true)
    const before = opens()
    const open = (door: number, body: object = {}) => api('POST', `/doors/${doorId(door)}/open`, s.cookie, body)

    expect((await open(1)).json().code).toBe('biometricNotRegistered')

    const auth = new SoftAuthenticator('doors.example.com', PUBLIC_URL)
    const regOptions = (await api('POST', '/mobile/biometric/options', s.cookie)).json()
    expect(regOptions).toMatchObject({ rp: { id: 'doors.example.com' }, authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' } })
    const reg = await api('POST', '/mobile/biometric', s.cookie, { response: auth.register(regOptions) })
    expect(reg.statusCode, reg.body).toBe(200)
    expect(((await api('GET', '/mobile/config', s.cookie)).json() as MobileConfigDto).device).toMatchObject({ biometric: true, expiresAt: null })

    expect((await open(1)).json().code).toBe('biometricRequired')

    const challenge = (await api('POST', `/mobile/doors/${doorId(1)}/challenge`, s.cookie)).json()
    const assertion = auth.authenticate(challenge)
    const ok = await open(1, { webauthn: assertion })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(opens()).toBe(before + 1)
    // the challenge is consumed: the same assertion cannot open again
    expect((await open(1, { webauthn: assertion })).json().code).toBe('biometricFailed')
    // a confirmation for door 1 does not open door 2
    const c1 = (await api('POST', `/mobile/doors/${doorId(1)}/challenge`, s.cookie)).json()
    expect((await open(2, { webauthn: auth.authenticate(c1) })).json().code).toBe('biometricFailed')
    // without user verification (presence only) it is refused
    const c2 = (await api('POST', `/mobile/doors/${doorId(2)}/challenge`, s.cookie)).json()
    expect((await open(2, { webauthn: auth.authenticate(c2, false) })).json().code).toBe('biometricFailed')
    // another authenticator (another phone) is refused
    const other = new SoftAuthenticator('doors.example.com', PUBLIC_URL)
    const c3 = (await api('POST', `/mobile/doors/${doorId(2)}/challenge`, s.cookie)).json()
    expect((await open(2, { webauthn: other.authenticate(c3) })).json().code).toBe('biometricFailed')
    expect(opens()).toBe(before + 1)

    // a normal password session (desk) is not affected
    const desk = await login('mario', 'Mario-pass-1')
    expect((await api('POST', `/doors/${doorId(3)}/open`, desk.cookie, {})).statusCode).toBe(200)
  })

  it('push and fingerprint/Face ID need a remembered device', async () => {
    const desk = await login('mario', 'Mario-pass-1')
    expect((await api('POST', '/mobile/biometric/options', desk.cookie)).json().code).toBe('deviceRequired')
    expect((await api('POST', '/mobile/push/test', desk.cookie)).json().code).toBe('deviceRequired')
  })
})

describe('push notifications', () => {
  async function subscribe(cookie: string, path: string, body: object = {}) {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    const auth = randomBytes(16)
    const r = await api('PUT', '/mobile/push', cookie, {
      subscription: { endpoint: `${pushBase}${path}`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } },
      language: 'it',
      ...body,
    })
    expect(r.statusCode, r.body).toBe(200)
    return (b: Buffer) => JSON.parse(ece.decrypt(b, { version: 'aes128gcm', privateKey: ecdh, authSecret: b64u(auth) }).toString()) as PushPayload
  }

  it('sends the chosen events, encrypted, with the open action', async () => {
    const s = await login('mario', 'Mario-pass-1', true)
    const decrypt = await subscribe(s.cookie, '/mario', { events: ['access.denied'] })
    expect(((await api('GET', '/mobile/config', s.cookie)).json() as MobileConfigDto).device?.push).toMatchObject({ events: ['access.denied'], rules: true })

    fake.swipe(10058400, 1)
    await waitFor(() => pushes.some((p) => p.path === '/mario'))
    const payload = decrypt(pushes.find((p) => p.path === '/mario')!.body)
    expect(payload).toMatchObject({
      title: '🚫 Accesso negato — Villa - Door 1',
      url: `/m?door=${doorId(1)}`,
      door: { id: doorId(1), name: 'Villa - Door 1' },
      canOpen: true,
      confirmation: 'press',
      texts: { open: '🔓 Apri Villa - Door 1', opened: 'Villa - Door 1 aperta' },
    })
    expect(payload.body).toContain('tessera sconosciuta 10058400')
  })

  it('no open action for users who may not open the door; rule firings; test message', async () => {
    const luca = await login('luca', 'Luca-pass-11', true)
    const decrypt = await subscribe(luca.cookie, '/luca', { events: ['access.denied'], rules: true })
    fake.swipe(10058400, 2)
    await waitFor(() => pushes.some((p) => p.path === '/luca'))
    expect(decrypt(pushes.find((p) => p.path === '/luca')!.body)).toMatchObject({ canOpen: false })

    pushes.length = 0
    ctx.hub.publishRule({ ruleId: 1, name: 'Porta aperta', severity: 'alarm', text: 'Cancello aperto da 2 min', at: localDateTime() })
    // every subscription with rules receives it (also the one of the previous test)
    await waitFor(() => pushes.some((p) => p.path === '/luca'))
    expect(decrypt(pushes.find((p) => p.path === '/luca')!.body)).toMatchObject({ title: '🚨 Porta aperta', body: 'Cancello aperto da 2 min', door: null })

    expect((await api('POST', '/mobile/push/test', luca.cookie)).json()).toEqual({ ok: true, error: null })
  })

  it('removes subscriptions the browser dropped (410)', async () => {
    const s = await login('mario', 'Mario-pass-1', true)
    await subscribe(s.cookie, '/gone')
    pushStatus = 410
    expect((await api('POST', '/mobile/push/test', s.cookie)).json()).toMatchObject({ ok: false })
    expect(((await api('GET', '/mobile/config', s.cookie)).json() as MobileConfigDto).device?.push).toBeNull()
  })
})
