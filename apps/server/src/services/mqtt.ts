import mqtt, { type MqttClient } from 'mqtt'
import type { Logger } from '@uhppote-desk/protocol'
import { ALARM_REASONS, translator, type ControllerLiveState, type EventDto, type WsMessage } from '@uhppote-desk/shared'
import type { MqttConfig } from '../config.js'
import type { ControllerRecord, ControllerRepo } from '../db/repos.js'
import type { ControllerGateway } from '../gateway/gateway.js'
import { isRecentEvent } from './events.js'

/** Node id in the discovery topics: lets us find (and remove) our own retained configs. */
const NODE_ID = 'uhppote_desk'
/** Event types (protocol) → Home Assistant event types. */
const HA_EVENT_TYPES = ['granted', 'denied', 'door', 'alarm'] as const

export interface MqttStatus {
  enabled: boolean
  connected: boolean
  broker: string | null
  baseTopic: string | null
  doorControl: boolean
}

/**
 * MQTT bridge with Home Assistant discovery.
 *
 * Topics (under the base topic, default `uhppote-desk`):
 * - `status`                         online/offline of the app (retained, last will)
 * - `<serial>/availability`          online/offline of the controller (retained)
 * - `<serial>/state`                 controller and door state, JSON (retained)
 * - `<serial>/event`                 every collected event, JSON (EventDto)
 * - `<serial>/door/<n>/event`        recent events of a door, for the HA `event` entity
 * - `<serial>/door/<n>/last_access`  last card swipe of a door, JSON (retained)
 * - `<serial>/door/<n>/open`         command: any payload opens the door
 *
 * Home Assistant gets one device per controller and one per door (linked to its controller).
 */
export class MqttService {
  private client: MqttClient | null = null
  /** Our discovery config topics currently retained on the broker. */
  private readonly retainedConfigs = new Set<string>()
  private refreshTimer: NodeJS.Timeout | null = null
  private readonly onHub = (m: WsMessage) => this.onHubMessage(m)
  private readonly online = new Map<number, boolean>()
  private readonly t: ReturnType<typeof translator>

  constructor(
    private readonly config: MqttConfig,
    private readonly controllers: ControllerRepo,
    private readonly gateway: ControllerGateway,
    private readonly opts: { version: string; logger?: Logger | undefined },
  ) {
    this.t = translator(config.language)
  }

  get connected(): boolean {
    return this.client?.connected ?? false
  }

  status(): MqttStatus {
    return {
      enabled: true,
      connected: this.connected,
      broker: redactUrl(this.config.url),
      baseTopic: this.config.baseTopic,
      doorControl: this.config.doorControl,
    }
  }

  start(): void {
    if (this.client) return
    const base = this.config.baseTopic
    this.client = mqtt.connect(this.config.url, {
      clientId: `uhppote-desk-${Math.random().toString(16).slice(2, 10)}`,
      ...(this.config.username ? { username: this.config.username } : {}),
      ...(this.config.password ? { password: this.config.password } : {}),
      reconnectPeriod: 5000,
      will: { topic: `${base}/status`, payload: Buffer.from('offline'), retain: true, qos: 1 },
    })
    this.client.on('connect', () => void this.onConnect())
    this.client.on('message', (topic, payload) => this.onMessage(topic, payload))
    this.client.on('error', (err) => this.opts.logger?.warn?.(`MQTT: ${err.message}`))
    this.client.on('offline', () => this.opts.logger?.warn?.(`MQTT: broker ${redactUrl(this.config.url)} unreachable, retrying`))
    this.gateway.hub.on('message', this.onHub)
  }

  async stop(): Promise<void> {
    this.gateway.hub.off('message', this.onHub)
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    const client = this.client
    this.client = null
    if (!client) return
    if (client.connected) await client.publishAsync(`${this.config.baseTopic}/status`, 'offline', { retain: true, qos: 1 }).catch(() => undefined)
    await client.endAsync().catch(() => undefined)
  }

  /** Republishes the discovery configs (after controllers or doors changed). Debounced. */
  refresh(delayMs = 500): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.publishAll()
    }, delayMs)
  }

  private async onConnect(): Promise<void> {
    const client = this.client
    if (!client) return
    this.opts.logger?.info?.(`MQTT: connected to ${redactUrl(this.config.url)}`)
    const base = this.config.baseTopic
    const prefix = this.config.discoveryPrefix
    try {
      await client.subscribeAsync([`${prefix}/+/${NODE_ID}/+/config`, `${prefix}/status`, `${base}/+/door/+/open`], { qos: 1 })
    } catch (err) {
      this.opts.logger?.warn?.(`MQTT: subscribe failed: ${(err as Error).message}`)
    }
    // the broker sends the retained configs right after the subscription: wait for them before cleaning up
    this.refresh(1500)
  }

  private onMessage(topic: string, payload: Buffer): void {
    const prefix = this.config.discoveryPrefix
    if (topic.startsWith(`${prefix}/`) && topic.endsWith('/config')) {
      if (payload.length > 0) this.retainedConfigs.add(topic)
      else this.retainedConfigs.delete(topic)
      return
    }
    if (topic === `${prefix}/status`) {
      // Home Assistant restarted: it expects the configs (and states) again
      if (payload.toString() === 'online') this.refresh(Math.floor(Math.random() * 1000) + 500)
      return
    }
    const m = new RegExp(`^${escapeRegExp(this.config.baseTopic)}/(\\d+)/door/([1-4])/open$`).exec(topic)
    if (m) void this.openDoor(Number(m[1]), Number(m[2]))
  }

  private async openDoor(serial: number, doorNumber: number): Promise<void> {
    const log = this.opts.logger
    if (!this.config.doorControl) {
      log?.warn?.(`MQTT: door ${serial}/${doorNumber} open request ignored (MQTT_DOOR_CONTROL=false)`)
      return
    }
    const c = this.controllers.getBySerial(serial)
    const door = c && this.controllers.doorByNumber(c.id, doorNumber)
    if (!c || !c.enabled || !door || !door.active) {
      log?.warn?.(`MQTT: open request for unknown or disabled door ${serial}/${doorNumber}`)
      return
    }
    try {
      await this.gateway.run(null, c.id, 'open-door', { door: door.door, name: door.name, source: 'mqtt' }, (client, t) => client.openDoor(t, door.door))
      log?.info?.(`MQTT: door "${door.name}" opened`)
    } catch (err) {
      log?.warn?.(`MQTT: opening door "${door.name}" failed: ${(err as Error).message}`)
    }
  }

  // --- publishing ------------------------------------------------------------

  private publish(topic: string, payload: string | object, retain = false): void {
    const client = this.client
    if (!client?.connected) return
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
    client.publish(topic, body, { retain, qos: retain ? 1 : 0 }, (err) => {
      if (err) this.opts.logger?.warn?.(`MQTT: publish ${topic} failed: ${err.message}`)
    })
  }

  /** Discovery configs, stale config removal, availability and current states. */
  private publishAll(): void {
    if (!this.client?.connected) return
    const base = this.config.baseTopic
    this.publish(`${base}/status`, 'online', true)
    const desired = new Map<string, object>()
    const controllers = this.controllers.list().filter((c) => c.enabled)
    for (const c of controllers) {
      for (const [topic, config] of this.discovery(c)) desired.set(topic, config)
    }
    for (const topic of this.retainedConfigs) {
      if (!desired.has(topic)) this.publish(topic, '', true)
    }
    for (const [topic, config] of desired) this.publish(topic, config, true)
    for (const c of controllers) this.publishState(c.serial, this.gateway.hub.state(c.id))
  }

  private publishState(serial: number, s: ControllerLiveState): void {
    const base = `${this.config.baseTopic}/${serial}`
    this.publish(`${base}/availability`, s.online ? 'online' : 'offline', true)
    this.publish(
      `${base}/state`,
      {
        online: s.online,
        lastSeenAt: s.lastSeenAt,
        controllerTime: s.controllerTime,
        driftSeconds: s.driftSeconds,
        forceLock: s.forceLock,
        fireAlarm: s.fireAlarm,
        systemError: s.systemError,
        doors: Object.fromEntries(s.doors.map((d) => [String(d.door), { open: d.open, unlocked: d.unlocked, button: d.button }])),
      },
      true,
    )
  }

  private onHubMessage(m: WsMessage): void {
    if (m.type === 'status') {
      const c = this.controllers.get(m.state.controllerId)
      if (!c?.enabled) return
      this.publishState(c.serial, m.state)
      // back online: the firmware version (device info) may have changed
      if (m.state.online && this.online.get(c.id) === false) this.refresh()
      this.online.set(c.id, m.state.online)
    } else if (m.type === 'event') {
      this.publishEvent(m.event)
    }
  }

  private publishEvent(e: EventDto): void {
    const c = this.controllers.get(e.controllerId)
    if (!c?.enabled) return
    const base = `${this.config.baseTopic}/${c.serial}`
    this.publish(`${base}/event`, e)

    const door = e.door >= 1 && e.door <= 4 ? this.controllers.doorByNumber(c.id, e.door) : undefined
    const type = haEventType(e)
    if (!door?.active || !type) return
    if (!isRecentEvent(e)) return
    const details = {
      person: e.personName,
      personId: e.personId,
      card: e.card || null,
      granted: e.granted,
      direction: e.direction === 1 ? 'in' : e.direction === 2 ? 'out' : null,
      reason: this.t.reason(e.reason),
      reasonCode: e.reason,
      timestamp: e.timestamp,
    }
    this.publish(`${base}/door/${e.door}/event`, { event_type: type, ...details })
    if (e.type === 1) this.publish(`${base}/door/${e.door}/last_access`, details, true)
  }

  // --- Home Assistant discovery ---------------------------------------------

  /** Discovery configs of a controller and its active doors: [topic, config]. */
  private discovery(c: ControllerRecord): [string, object][] {
    const t = this.t.t
    const base = `${this.config.baseTopic}/${c.serial}`
    const prefix = this.config.discoveryPrefix
    const id = `${NODE_ID}_${c.serial}`
    const origin = { name: 'UHPPOTE Desk', sw_version: this.opts.version, support_url: 'https://github.com/alexbn71/UHPPOTE-Desk' }
    const bridge = { topic: `${this.config.baseTopic}/status` }
    const availability = { availability: [bridge, { topic: `${base}/availability` }], availability_mode: 'all' }
    const controllerDevice = {
      identifiers: [id],
      name: c.name,
      manufacturer: 'UHPPOTE',
      model: 'UT0311-L0x',
      serial_number: String(c.serial),
      ...(c.firmware ? { sw_version: c.firmware } : {}),
    }
    const out: [string, object][] = []
    const add = (component: string, objectId: string, config: object) =>
      out.push([`${prefix}/${component}/${NODE_ID}/${objectId}/config`, { unique_id: objectId, origin, ...config }])
    const state = `${base}/state`

    add('binary_sensor', `${id}_connectivity`, {
      name: null,
      device_class: 'connectivity',
      entity_category: 'diagnostic',
      availability: [bridge],
      state_topic: `${base}/availability`,
      payload_on: 'online',
      payload_off: 'offline',
      device: controllerDevice,
    })
    add('binary_sensor', `${id}_fire_alarm`, {
      name: t('mqtt.fireAlarm'),
      device_class: 'safety',
      ...availability,
      state_topic: state,
      value_template: "{{ 'ON' if value_json.fireAlarm else 'OFF' }}",
      device: controllerDevice,
    })
    add('binary_sensor', `${id}_force_lock`, {
      name: t('mqtt.forceLock'),
      icon: 'mdi:lock-alert',
      ...availability,
      state_topic: state,
      value_template: "{{ 'ON' if value_json.forceLock else 'OFF' }}",
      device: controllerDevice,
    })
    add('binary_sensor', `${id}_problem`, {
      name: null,
      device_class: 'problem',
      entity_category: 'diagnostic',
      ...availability,
      state_topic: state,
      value_template: "{{ 'ON' if value_json.systemError else 'OFF' }}",
      json_attributes_topic: state,
      json_attributes_template: '{{ {"systemError": value_json.systemError} | tojson }}',
      device: controllerDevice,
    })
    add('sensor', `${id}_clock_drift`, {
      name: t('mqtt.clockDrift'),
      device_class: 'duration',
      unit_of_measurement: 's',
      entity_category: 'diagnostic',
      enabled_by_default: false,
      ...availability,
      state_topic: state,
      value_template: '{{ value_json.driftSeconds if value_json.driftSeconds is not none else None }}',
      device: controllerDevice,
    })

    for (const door of this.controllers.doors(c.id).filter((d) => d.active)) {
      const n = door.door
      const did = `${id}_door${n}`
      const doorTopic = `${base}/door/${n}`
      const device = { identifiers: [did], name: door.name, manufacturer: 'UHPPOTE', model: 'UT0311-L0x door', via_device: id }
      const doorState = (field: string) => `{{ 'ON' if value_json.doors['${n}'].${field} else 'OFF' }}`

      add('binary_sensor', `${did}_open`, {
        name: null,
        device_class: 'door',
        ...availability,
        state_topic: state,
        value_template: doorState('open'),
        device,
      })
      // device class lock: ON = unlocked
      add('binary_sensor', `${did}_lock`, {
        name: null,
        device_class: 'lock',
        ...availability,
        state_topic: state,
        value_template: doorState('unlocked'),
        device,
      })
      add('binary_sensor', `${did}_exit_button`, {
        name: t('mqtt.exitButton'),
        icon: 'mdi:gesture-tap-button',
        enabled_by_default: false,
        ...availability,
        state_topic: state,
        value_template: doorState('button'),
        device,
      })
      if (this.config.doorControl) {
        add('button', `${did}_open_door`, {
          name: t('mqtt.open'),
          icon: 'mdi:door-open',
          ...availability,
          command_topic: `${doorTopic}/open`,
          payload_press: 'OPEN',
          device,
        })
      }
      add('event', `${did}_access`, {
        name: t('mqtt.access'),
        icon: 'mdi:card-account-details',
        ...availability,
        state_topic: `${doorTopic}/event`,
        event_types: HA_EVENT_TYPES,
        device,
      })
      add('sensor', `${did}_last_access`, {
        name: t('mqtt.lastAccess'),
        icon: 'mdi:account-clock',
        ...availability,
        state_topic: `${doorTopic}/last_access`,
        value_template: '{{ value_json.person or value_json.card }}',
        json_attributes_topic: `${doorTopic}/last_access`,
        device,
      })
    }
    // the open buttons are left out when door control is disabled: their stale configs get removed
    return out
  }
}

/** Home Assistant event type of an event, null for types that are not forwarded. */
function haEventType(e: EventDto): (typeof HA_EVENT_TYPES)[number] | null {
  // same rule as webhooks and notifications: alarms by reason, power-on/reset not forwarded
  if (ALARM_REASONS.has(e.reason)) return 'alarm'
  if (e.type === 1) return e.granted ? 'granted' : 'denied'
  if (e.type === 2) return 'door'
  return null
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    return u.toString().replace(/\/$/, '')
  } catch {
    return url
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
