/**
 * MQTT bridge: Home Assistant discovery, states, events and door commands,
 * against an in-process broker (aedes) and the FakeController.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Aedes } from 'aedes'
import mqtt, { type MqttClient } from 'mqtt'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeController } from '@uhppote-desk/protocol/testing'
import type { AppConfig } from '../../src/config.js'
import { createContext, type AppContext } from '../../src/context.js'

const LISTEN_PORT = 60032
const SERIAL = 423187758
const OPEN_DOOR = 0x40

let broker: Aedes
let brokerServer: net.Server
let brokerUrl = ''
let fake: FakeController
let ctx: AppContext
let ha: MqttClient
let controllerId = 0
let dataDir = ''
/** Last payload per topic seen by the "Home Assistant" client ('' = deleted). */
const seen = new Map<string, string>()
const received: { topic: string; payload: string }[] = []

const quiet = { info: () => undefined, warn: () => undefined, error: (m: string) => console.error(m), debug: () => undefined }

function config(dir: string): AppConfig {
  return {
    httpPort: 0,
    httpHost: '127.0.0.1',
    dataDir: dir,
    secureCookies: false,
    sessionHours: 1,
    adminPassword: 'Password-123',
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
    mqtt: {
      url: brokerUrl,
      username: null,
      password: null,
      baseTopic: 'uhd',
      discoveryPrefix: 'homeassistant',
      doorControl: true,
      language: 'it',
    },
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within the timeout')
    await new Promise((r) => setTimeout(r, 25))
  }
}

const json = (topic: string) => JSON.parse(seen.get(topic)!) as Record<string, any>
const configTopic = (component: string, objectId: string) => `homeassistant/${component}/uhppote_desk/uhppote_desk_${SERIAL}_${objectId}/config`

beforeAll(async () => {
  broker = await Aedes.createBroker()
  brokerServer = net.createServer(broker.handle)
  await new Promise<void>((r) => brokerServer.listen(0, '127.0.0.1', r))
  brokerUrl = `mqtt://127.0.0.1:${(brokerServer.address() as net.AddressInfo).port}`

  // a stale config left by a previous run (door that no longer exists): must be removed
  const stale = await mqtt.connectAsync(brokerUrl)
  await stale.publishAsync(configTopic('button', 'door9_open_door'), '{"name":"old"}', { retain: true, qos: 1 })
  await stale.endAsync()

  ha = await mqtt.connectAsync(brokerUrl)
  ha.on('message', (topic, payload) => {
    seen.set(topic, payload.toString())
    received.push({ topic, payload: payload.toString() })
  })
  await ha.subscribeAsync(['homeassistant/#', 'uhd/#'], { qos: 1 })

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhd-mqtt-'))
  fake = new FakeController({ id: SERIAL })
  await fake.start()
  ctx = createContext(config(dataDir), quiet, ':memory:')
  await ctx.eventService.startListener()
  controllerId = ctx.controllers.create({ serial: SERIAL, name: 'Ingresso', host: fake.endpoint.host, port: fake.endpoint.port, transport: 'udp', zoneId: null, enabled: true })
  await ctx.health.check(controllerId)
  ctx.mqtt!.start()
})

afterAll(async () => {
  await ctx.mqtt?.stop()
  await ctx.eventService.stopListener()
  ctx.db.close()
  await fake.stop()
  await ha.endAsync()
  await new Promise<void>((r) => broker.close(() => r()))
  await new Promise<void>((r) => brokerServer.close(() => r()))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('Home Assistant discovery', () => {
  it('publishes the controller and door devices', async () => {
    await waitFor(() => seen.has(configTopic('button', 'door4_open_door')))
    expect(ctx.mqtt!.connected).toBe(true)
    expect(seen.get('uhd/status')).toBe('online')

    const connectivity = json(configTopic('binary_sensor', 'connectivity'))
    expect(connectivity).toMatchObject({
      device_class: 'connectivity',
      state_topic: `uhd/${SERIAL}/availability`,
      device: { identifiers: [`uhppote_desk_${SERIAL}`], name: 'Ingresso', manufacturer: 'UHPPOTE', sw_version: 'v8.92' },
    })

    const open = json(configTopic('button', 'door1_open_door'))
    expect(open).toMatchObject({
      name: 'Apri', // MQTT_LANGUAGE=it
      command_topic: `uhd/${SERIAL}/door/1/open`,
      device: { identifiers: [`uhppote_desk_${SERIAL}_door1`], name: 'Ingresso - Door 1', via_device: `uhppote_desk_${SERIAL}` },
      availability_mode: 'all',
    })
    expect(json(configTopic('binary_sensor', 'door2_open'))).toMatchObject({ device_class: 'door', state_topic: `uhd/${SERIAL}/state` })
    expect(json(configTopic('event', 'door3_access'))).toMatchObject({ event_types: ['granted', 'denied', 'door', 'alarm'] })
  })

  it('removes stale configs left on the broker', async () => {
    await waitFor(() => seen.get(configTopic('button', 'door9_open_door')) === '')
  })

  it('publishes availability and state', async () => {
    await waitFor(() => seen.get(`uhd/${SERIAL}/availability`) === 'online')
    expect(json(`uhd/${SERIAL}/state`)).toMatchObject({ online: true, fireAlarm: false, doors: { '1': { open: false, unlocked: false } } })
  })

  it('removes the entities of a deactivated door', async () => {
    const door = ctx.controllers.doorByNumber(controllerId, 3)!
    ctx.controllers.updateDoor(door.id, { ...door, active: false })
    ctx.mqtt!.refresh(0)
    await waitFor(() => seen.get(configTopic('button', 'door3_open_door')) === '' && seen.get(configTopic('event', 'door3_access')) === '')
    expect(json(configTopic('button', 'door2_open_door')).name).toBe('Apri')
  })
})

describe('events and commands', () => {
  it('forwards a denied swipe to the door event entity', async () => {
    fake.swipe(10058400, 1)
    await waitFor(() => received.some((m) => m.topic === `uhd/${SERIAL}/door/1/event`))
    const ev = JSON.parse(received.find((m) => m.topic === `uhd/${SERIAL}/door/1/event`)!.payload)
    expect(ev).toMatchObject({ event_type: 'denied', card: 10058400, granted: false, direction: 'in' })
    expect(json(`uhd/${SERIAL}/door/1/last_access`)).toMatchObject({ card: 10058400, granted: false })
    expect(received.some((m) => m.topic === `uhd/${SERIAL}/event`)).toBe(true)
  })

  it('opens a door from the Home Assistant button, with an audit entry', async () => {
    const before = fake.requestCount.get(OPEN_DOOR) ?? 0
    await ha.publishAsync(`uhd/${SERIAL}/door/2/open`, 'OPEN')
    await waitFor(() => (fake.requestCount.get(OPEN_DOOR) ?? 0) === before + 1)
    await waitFor(() => received.some((m) => m.topic === `uhd/${SERIAL}/door/2/event` && JSON.parse(m.payload).event_type === 'door'))
    const audit = ctx.db.get<{ details: string }>("SELECT details FROM audit_log WHERE action = 'open-door' ORDER BY id DESC LIMIT 1")
    expect(JSON.parse(audit!.details)).toMatchObject({ door: 2, source: 'mqtt' })
  })

  it('ignores commands for a deactivated door', async () => {
    const before = fake.requestCount.get(OPEN_DOOR) ?? 0
    await ha.publishAsync(`uhd/${SERIAL}/door/3/open`, 'OPEN')
    await new Promise((r) => setTimeout(r, 300))
    expect(fake.requestCount.get(OPEN_DOOR) ?? 0).toBe(before)
  })

  it('marks the controller unavailable when it goes offline', async () => {
    fake.offline = true
    await ctx.health.check(controllerId)
    await waitFor(() => seen.get(`uhd/${SERIAL}/availability`) === 'offline')
    fake.offline = false
  })

  it('reports itself offline when it stops', async () => {
    await ctx.mqtt!.stop()
    await waitFor(() => seen.get('uhd/status') === 'offline')
  })
})
