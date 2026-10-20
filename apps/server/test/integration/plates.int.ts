/**
 * Licence plates: reader keys, readings from AgentDVR-like calls, permissions and time profiles of people,
 * guest plates, debounce, "record only" readers, photos from the camera, events and persons inside.
 */
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeController } from '@uhppote-desk/protocol/testing'
import type { GuestLinkDto, PlateReadDto, PlateReaderKeyDto, PresenceDto } from '@uhppote-desk/shared'
import { buildApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'
import type { IntegrationEvent } from '../../src/services/integrationEvents.js'
import { addDays, localDate, localDateTime } from '../../src/util/time.js'

const SERIAL = 423187762
const PASSWORD = 'Plate-Test-1'
const OPEN_DOOR = 0x40
/** A tiny JPEG-looking payload served as the camera snapshot. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9])

let fake: FakeController
let ctx: AppContext
let app: FastifyInstance
let cookie = ''
let controllerId = 0
let dataDir = ''
let camera: http.Server
let snapshotUrl = ''
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

async function api(method: string, url: string, body?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method: method as 'GET',
    url: `/api${url}`,
    headers: { cookie },
    ...(body !== undefined ? { payload: body as object } : {}),
  })
}

/** What AgentDVR's "Call URL" does: a GET without login. */
const read = (key: string, plate: string, ip = '10.0.0.1') =>
  app.inject({
    method: 'GET',
    url: `/api/plates/read?key=${key}&plate=${encodeURIComponent(plate)}`,
    remoteAddress: ip,
  })

const doorId = (n: number) => ctx.controllers.doorByNumber(controllerId, n)!.id
const opens = () => fake.requestCount.get(OPEN_DOOR) ?? 0
const lastRead = () => ctx.plates.reads({ limit: 1, offset: 0 }).rows[0]!

async function createReader(body: Record<string, unknown> = {}): Promise<PlateReaderKeyDto> {
  const r = await api('POST', '/plate-readers', { name: 'Gate camera', doorId: doorId(1), debounceSeconds: 0, ...body })
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}

let personSeq = 0
/** A person with a plate and, optionally, a permission on door 1 with a time profile. */
async function person(plate: string, opts: { permission?: boolean; profileId?: number | null; active?: boolean } = {}) {
  const r = await api('POST', '/people', {
    code: `P${++personSeq}`,
    lastName: `Rossi${personSeq}`,
    firstName: 'Mario',
    validFrom: addDays(localDate(), -1),
    validTo: addDays(localDate(), 30),
    active: opts.active ?? true,
  })
  expect(r.statusCode, r.body).toBe(200)
  const id = (r.json() as { id: number }).id
  if (opts.permission ?? true)
    ctx.people.setPermissions(id, [{ doorId: doorId(1), profileId: opts.profileId ?? null, firstCard: false }])
  const p = await api('POST', '/plates', { plate, personId: id })
  expect(p.statusCode, p.body).toBe(200)
  return id
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-plates-'))
  fake = new FakeController({ id: SERIAL })
  await fake.start()
  camera = http.createServer((req, res) => {
    if (req.url?.startsWith('/grab.jpg')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(JPEG)
    } else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => camera.listen(0, '127.0.0.1', resolve))
  snapshotUrl = `http://127.0.0.1:${(camera.address() as AddressInfo).port}/grab.jpg?oid=1&size=1920x1080`
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

beforeEach(() => {
  published.length = 0
})

afterAll(async () => {
  await app.close()
  ctx.db.close()
  await fake.stop()
  await new Promise((resolve) => camera.close(resolve))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('plate readers', () => {
  it('return the key once, store its hash and refuse wrong keys', async () => {
    const { key, reader } = await createReader()
    expect(key).toMatch(/^uhp_[A-Za-z0-9_-]{32}$/)
    expect(reader.keyPrefix).toBe(key.slice(0, 10))
    expect(JSON.stringify((await api('GET', '/plate-readers')).json())).not.toContain(key)
    expect(JSON.stringify(ctx.db.all('SELECT details FROM audit_log'))).not.toContain(key)
    expect((await read('uhp_wrong', 'AB123CD')).json().code).toBe('invalidReaderKey')
    await api('PUT', `/plate-readers/${reader.id}`, { name: 'Gate camera', doorId: doorId(1), enabled: false })
    expect((await read(key, 'AB123CD')).statusCode).toBe(403)
  })

  it('serve the known plates to AgentDVR', async () => {
    const { key } = await createReader()
    await person('CSV111AA')
    await person('CSV222BB', { active: false })
    const r = await app.inject({ method: 'GET', url: `/api/plates/agentdvr.csv?key=${key}` })
    expect(r.statusCode).toBe(200)
    expect(r.body.split(',')).toContain('CSV111AA')
    expect(r.body.split(',')).not.toContain('CSV222BB')
    expect((await app.inject({ method: 'GET', url: '/api/plates/agentdvr.csv?key=uhp_x' })).statusCode).toBe(403)
  })
})

describe('readings', () => {
  it('opens the door for a person with a permission, with the photo, and publishes plate.granted', async () => {
    const { key } = await createReader({ snapshotUrl })
    const personId = await person('AB123CD')
    const before = opens()
    // AgentDVR may send several readings and labels; B read as 8 still matches
    const r = await read(key, 'car, A8123CD ,xx')
    expect(r.json()).toMatchObject({ outcome: 'granted', opened: true, plate: 'AB123CD', ignored: false })
    expect(opens()).toBe(before + 1)
    const row = lastRead()
    expect(row).toMatchObject({ outcome: 'granted', opened: true, personId, plate: 'AB123CD', hasPhoto: true })
    const photo = await api('GET', `/plates/reads/${row.id}/photo`)
    expect(photo.headers['content-type']).toBe('image/jpeg')
    expect(photo.rawPayload.equals(JPEG)).toBe(true)
    expect(published.map((e) => e.type)).toEqual(['plate.granted'])
    expect(published[0]!.photo?.equals(JPEG)).toBe(true)
    expect(published[0]!.data).toMatchObject({ plate: 'AB123CD', personId, outcome: 'granted', opened: true })
    expect(ctx.audit.query({ limit: 1, offset: 0, action: 'plate-open-door' }).rows[0]).toMatchObject({
      operatorName: 'plate:Gate camera',
      outcome: 'ok',
    })
    // persons inside: the vehicle counts as an entry
    const presence = (await api('GET', '/presence')).json() as PresenceDto
    expect(presence.inside.find((p) => p.personId === personId)).toMatchObject({ plate: 'AB123CD', card: 0 })
  })

  it('ignores readings right after an opening (debounce)', async () => {
    const { key } = await createReader({ debounceSeconds: 30 })
    await person('DB456EF')
    const before = opens()
    expect((await read(key, 'DB456EF')).json()).toMatchObject({ opened: true })
    expect((await read(key, 'DB456EF')).json()).toMatchObject({ ignored: true, opened: false })
    expect(opens()).toBe(before + 1)
  })

  it('refuses unknown plates, people without permission or inactive, once per plate', async () => {
    const { key } = await createReader()
    await person('NP111AA', { permission: false })
    await person('IN222BB', { active: false })
    const before = opens()
    expect((await read(key, 'ZZ999ZZ')).json()).toMatchObject({ outcome: 'unknown', opened: false })
    expect(lastRead()).toMatchObject({ outcome: 'unknown', plate: 'ZZ999ZZ', ownerName: null })
    expect((await read(key, 'NP111AA')).json().outcome).toBe('noPermission')
    expect((await read(key, 'IN222BB')).json().outcome).toBe('personInactive')
    expect(published.map((e) => [e.type, e.data.outcome])).toEqual([
      ['plate.denied', 'unknown'],
      ['plate.denied', 'noPermission'],
      ['plate.denied', 'personInactive'],
    ])
    // the same refused plate again a moment later is not recorded twice
    expect((await read(key, 'NP111AA')).json()).toMatchObject({ ignored: true })
    expect(opens()).toBe(before)
  })

  it('follows the time profile of the permission', async () => {
    const { key } = await createReader()
    const now = localDateTime()
    const hour = Number(now.slice(11, 13))
    const other = `${String((hour + 2) % 24).padStart(2, '0')}:00`
    const otherEnd = `${String((hour + 2) % 24).padStart(2, '0')}:59`
    const base = {
      validFrom: addDays(localDate(), -1),
      validTo: addDays(localDate(), 1),
      weekdays: Array(7).fill(true),
    }
    ctx.schedule.saveProfile({
      id: 20,
      name: 'Other hours',
      ...base,
      segments: [{ start: other, end: otherEnd }],
      linkedTo: null,
    })
    ctx.schedule.saveProfile({
      id: 21,
      name: 'All day',
      ...base,
      segments: [{ start: '00:00', end: '23:59' }],
      linkedTo: null,
    })
    await person('TP111AA', { profileId: 20 })
    expect((await read(key, 'TP111AA')).json().outcome).toBe('outsideProfile')
    // a linked profile that allows now
    ctx.schedule.saveProfile({
      id: 20,
      name: 'Other hours',
      ...base,
      segments: [{ start: other, end: otherEnd }],
      linkedTo: 21,
    })
    await person('TP222BB', { profileId: 20 })
    expect((await read(key, 'TP222BB')).json().outcome).toBe('granted')
  })

  it('opens for the plate of an active guest pass and counts the opening', async () => {
    const { key } = await createReader()
    const created = await api('POST', '/guests', {
      name: 'Plumber',
      doorIds: [doorId(1)],
      validFrom: localDateTime().slice(0, 16),
      validTo: localDateTime(new Date(Date.now() + 3600_000)).slice(0, 16),
      maxOpens: 1,
      bindDevice: false,
      plates: ['gs 777-hh'],
    })
    expect(created.statusCode, created.body).toBe(200)
    const { pass } = created.json() as GuestLinkDto
    expect(pass.plates).toEqual(['GS777HH'])
    expect((await read(key, 'GS777HH')).json()).toMatchObject({ outcome: 'granted', opened: true })
    expect(lastRead()).toMatchObject({ guestPassId: pass.id, ownerName: 'Plumber' })
    expect(ctx.guests.get(pass.id)).toMatchObject({ opens: 1, status: 'used' })
    // used up: the next visit is refused with the pass status
    published.length = 0
    expect((await read(key, 'GS777HH', '10.0.0.2')).json().outcome).toBe('used')
    expect(published.map((e) => e.type)).toEqual(['plate.denied'])
  })

  it('records only, without opening, when the reader is in test mode', async () => {
    const { key } = await createReader({ openDoor: false })
    await person('RO333CC')
    const before = opens()
    expect((await read(key, 'RO333CC')).json()).toMatchObject({ outcome: 'granted', opened: false })
    expect(opens()).toBe(before)
    expect(lastRead()).toMatchObject({ outcome: 'granted', opened: false })
  })

  it('lists readings with filters', async () => {
    const all = (await api('GET', '/plates/reads?limit=500')).json() as { rows: PlateReadDto[]; total: number }
    expect(all.total).toBeGreaterThan(5)
    const denied = (await api('GET', '/plates/reads?outcome=denied&limit=500')).json() as { rows: PlateReadDto[] }
    expect(denied.rows.every((r) => r.outcome !== 'granted')).toBe(true)
    const search = (await api('GET', '/plates/reads?search=ab123')).json() as { rows: PlateReadDto[] }
    expect(search.rows.map((r) => r.plate)).toEqual(['AB123CD'])
  })

  it('deletes photos past the retention', () => {
    ctx.db.run("UPDATE plate_reads SET at = '2020-01-01 00:00:00' WHERE photo IS NOT NULL")
    expect(ctx.plates.purgePhotos()).toBeGreaterThan(0)
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM plate_reads WHERE photo IS NOT NULL')!.n).toBe(0)
  })
})
