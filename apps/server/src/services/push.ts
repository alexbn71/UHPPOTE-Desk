import webpush from 'web-push'
import type { Logger } from '@uhppote-desk/protocol'
import {
  translator,
  type Language,
  type PushPayload,
  type PushPreferencesDto,
  type WebhookEvent,
  type WsMessage,
} from '@uhppote-desk/shared'
import type { AuthService } from '../auth/auth.js'
import { canOperateController } from '../auth/zones.js'
import type { Db } from '../db/database.js'
import { fromBool, toBool } from '../db/database.js'
import type { ControllerRepo, TreeRepo } from '../db/repos.js'
import type { LiveHub } from '../gateway/gateway.js'
import { localDateTime } from '../util/time.js'
import { matchesDoors, type IntegrationEvent, type IntegrationEvents } from './integrationEvents.js'
import type { MobileService } from './mobile.js'
import { eventMessage, type NotifyMessage } from './notify/messages.js'

interface SubscriptionRow {
  id: number
  device_id: number
  operator_id: number
  endpoint: string
  p256dh: string
  auth: string
  events: string
  door_ids: string
  rules: number
  language: Language
  last_sent_at: string | null
  last_error: string | null
}

const SEVERITY_EMOJI = { info: 'ℹ️', warning: '⚠️', alarm: '🚨' } as const

/**
 * Push notifications to the mobile app (Web Push with this installation's VAPID keys): events chosen
 * on each device, and the firings of automation rules. Messages about a door carry an "open"
 * action when the user may open it.
 */
export class PushService {
  private readonly onEvent = (ev: IntegrationEvent) => this.dispatch(ev)
  private readonly onHub = (m: WsMessage) => m.type === 'rule' && this.dispatchRule(m)
  private readonly pending = new Set<Promise<void>>()

  constructor(
    private readonly db: Db,
    private readonly bus: IntegrationEvents,
    private readonly hub: LiveHub,
    private readonly deps: {
      mobile: MobileService
      auth: AuthService
      controllers: ControllerRepo
      zones: TreeRepo
      publicUrl: string | null
    },
    private readonly logger?: Logger,
  ) {}

  start(): void {
    this.bus.on('event', this.onEvent)
    this.bus.start()
    this.hub.on('message', this.onHub)
  }

  stop(): void {
    this.bus.off('event', this.onEvent)
    this.hub.off('message', this.onHub)
  }

  /** Waits for the messages being sent (tests). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending])
  }

  // --- subscriptions --------------------------------------------------------------------------------

  private subscriptions(): SubscriptionRow[] {
    return this.db.all<SubscriptionRow>(
      `SELECT p.*, d.operator_id FROM push_subscriptions p
       JOIN devices d ON d.id = p.device_id JOIN operators o ON o.id = d.operator_id WHERE o.active = 1`,
    )
  }

  preferences(deviceId: number): PushPreferencesDto | null {
    const r = this.db.get<SubscriptionRow>('SELECT * FROM push_subscriptions WHERE device_id = ?', [deviceId])
    if (!r) return null
    return {
      events: JSON.parse(r.events) as WebhookEvent[],
      doorIds: JSON.parse(r.door_ids) as number[],
      rules: toBool(r.rules),
      language: r.language,
      lastSentAt: r.last_sent_at,
      lastError: r.last_error,
    }
  }

  subscribe(
    deviceId: number,
    s: {
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } }
      events: WebhookEvent[]
      doorIds: number[]
      rules: boolean
      language: Language
    },
  ): void {
    this.db.run(
      `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, events, door_ids, rules, language) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh, auth = excluded.auth, events = excluded.events,
         door_ids = excluded.door_ids, rules = excluded.rules, language = excluded.language, last_error = NULL`,
      [
        deviceId,
        s.subscription.endpoint,
        s.subscription.keys.p256dh,
        s.subscription.keys.auth,
        JSON.stringify(s.events),
        JSON.stringify(s.doorIds),
        fromBool(s.rules),
        s.language,
      ],
    )
  }

  unsubscribe(deviceId: number): void {
    this.db.run('DELETE FROM push_subscriptions WHERE device_id = ?', [deviceId])
  }

  /** Sends a test message to a device; returns the error, if any. */
  async test(deviceId: number): Promise<string | null> {
    const sub = this.subscriptions().find((s) => s.device_id === deviceId)
    if (!sub) return 'no subscription'
    const t = translator(sub.language)
    return this.send(
      sub,
      {
        emoji: '🔔',
        title: t.t('notify.testTitle'),
        lines: [t.t('notify.testBody')],
        priority: 3,
        tags: [],
        door: null,
      },
      'test',
    )
  }

  // --- dispatch -------------------------------------------------------------------------------------

  private dispatch(ev: IntegrationEvent): void {
    try {
      for (const sub of this.subscriptions()) {
        if (!(JSON.parse(sub.events) as string[]).includes(ev.type)) continue
        if (!matchesDoors(JSON.parse(sub.door_ids) as number[], ev, () => this.bus.controllerDoorIds(ev.controller.id)))
          continue
        this.track(this.send(sub, eventMessage(ev, sub.language), ev.type))
      }
    } catch (err) {
      this.logger?.error?.(`push: ${(err as Error).message}`)
    }
  }

  private dispatchRule(m: Extract<WsMessage, { type: 'rule' }>): void {
    try {
      for (const sub of this.subscriptions().filter((s) => toBool(s.rules))) {
        const message: NotifyMessage = {
          emoji: SEVERITY_EMOJI[m.severity],
          title: m.name,
          lines: m.text.split('\n'),
          priority: m.severity === 'alarm' ? 5 : m.severity === 'warning' ? 4 : 3,
          tags: [],
          door: null,
        }
        this.track(this.send(sub, message, `rule-${m.ruleId}`))
      }
    } catch (err) {
      this.logger?.error?.(`push: ${(err as Error).message}`)
    }
  }

  private track(p: Promise<unknown>): void {
    const done = p.then(() => undefined).finally(() => this.pending.delete(done))
    this.pending.add(done)
  }

  /** May the subscription's user open the door from the notification? */
  private canOpen(sub: SubscriptionRow, doorId: number): boolean {
    const user = this.deps.auth.deviceUser(sub.operator_id, sub.device_id)
    const door = this.deps.controllers.door(doorId)
    const controller = door && this.deps.controllers.get(door.controllerId)
    if (!user?.canOpenDoors || !door?.active || !controller?.enabled) return false
    if (user.doorIds.length > 0 && !user.doorIds.includes(door.id)) return false
    return canOperateController(this.deps.zones.list(), user, controller)
  }

  private async send(sub: SubscriptionRow, m: NotifyMessage, tag: string): Promise<string | null> {
    const t = translator(sub.language)
    const confirmation = this.deps.mobile.settings().openConfirmation
    const door = m.door
    const payload: PushPayload = {
      title: `${m.emoji} ${m.title}`,
      body: m.lines.map((l) => (typeof l === 'string' ? l : l.heading)).join('\n'),
      tag,
      url: door ? `/m?door=${door.id}` : '/m',
      door,
      canOpen: !!door && this.canOpen(sub, door.id),
      confirmation,
      texts: {
        open: t.t('notify.openButton', { door: door?.name ?? '' }),
        opened: t.t('notify.openDone', { door: door?.name ?? '' }),
        failed: t.t('notify.openFailed', { door: door?.name ?? '' }),
      },
    }
    const keys = this.deps.mobile.vapidKeys()
    // RFC 8292: a contact URL or address of the sender; the public HTTPS address when known
    const subject = this.deps.publicUrl?.startsWith('https://')
      ? this.deps.publicUrl
      : 'mailto:uhppote-desk@example.com'
    let status: number | null = null
    let error: string | null = null
    try {
      // web-push encrypts the payload and signs the request (VAPID); fetch sends it
      const details = webpush.generateRequestDetails(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 600,
          urgency: m.priority >= 4 ? 'high' : 'normal',
        },
      )
      const res = await fetch(details.endpoint, {
        method: 'POST',
        headers: details.headers as Record<string, string>,
        body: details.body,
        signal: AbortSignal.timeout(10_000),
      })
      status = res.status
      if (!res.ok) error = `HTTP ${res.status}`
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } }
      error = e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.message)
    }
    // 404/410: the browser dropped the subscription (app uninstalled, permission revoked)
    if (status === 404 || status === 410) {
      this.db.run('DELETE FROM push_subscriptions WHERE id = ?', [sub.id])
      this.logger?.info?.(`push: the browser dropped the subscription of device ${sub.device_id} (HTTP ${status}), removed`)
      return `HTTP ${status}: subscription removed`
    }
    this.db.run('UPDATE push_subscriptions SET last_sent_at = ?, last_error = ? WHERE id = ?', [
      localDateTime(),
      error,
      sub.id,
    ])
    if (error) this.logger?.warn?.(`push to device ${sub.device_id}: ${error}`)
    return error
  }
}
