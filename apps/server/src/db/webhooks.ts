import { randomBytes } from 'node:crypto'
import type { WebhookDeliveryDto, WebhookDto, WebhookEvent } from '@uhppote-desk/shared'
import { fromBool, toBool, type Db } from './database.js'

/** Deliveries kept per webhook. */
const KEEP_DELIVERIES = 100

export type WebhookInput = Pick<WebhookDto, 'name' | 'url' | 'enabled' | 'events' | 'doorIds' | 'headers'>

interface WebhookRow {
  id: number
  name: string
  url: string
  secret: string
  enabled: number
  events: string
  door_ids: string
  headers: string
  created_at: string
  last_at: string | null
  last_ok: number | null
  last_status: number | null
  last_error: string | null
}

interface DeliveryRow {
  id: number
  webhook_id: number
  delivery_id: string
  event: string
  at: string
  ok: number
  status_code: number | null
  error: string | null
  duration_ms: number
  attempts: number
  payload: string
}

const SELECT = `
  SELECT w.*, d.at AS last_at, d.ok AS last_ok, d.status_code AS last_status, d.error AS last_error
  FROM webhooks w
  LEFT JOIN webhook_deliveries d ON d.id = (SELECT MAX(id) FROM webhook_deliveries WHERE webhook_id = w.id)`

const mapWebhook = (r: WebhookRow): WebhookDto => ({
  id: r.id,
  name: r.name,
  url: r.url,
  enabled: toBool(r.enabled),
  events: JSON.parse(r.events) as WebhookEvent[],
  doorIds: JSON.parse(r.door_ids) as number[],
  headers: JSON.parse(r.headers) as Record<string, string>,
  secret: r.secret,
  createdAt: r.created_at,
  lastDelivery:
    r.last_at === null
      ? null
      : { at: r.last_at, ok: toBool(r.last_ok), statusCode: r.last_status, error: r.last_error },
})

const mapDelivery = (r: DeliveryRow): WebhookDeliveryDto => ({
  id: r.id,
  webhookId: r.webhook_id,
  deliveryId: r.delivery_id,
  event: r.event,
  at: r.at,
  ok: toBool(r.ok),
  statusCode: r.status_code,
  error: r.error,
  durationMs: r.duration_ms,
  attempts: r.attempts,
  payload: r.payload,
})

export const newWebhookSecret = (): string => randomBytes(32).toString('hex')

export class WebhookRepo {
  constructor(private readonly db: Db) {}

  list(): WebhookDto[] {
    return this.db.all<WebhookRow>(`${SELECT} ORDER BY w.name, w.id`).map(mapWebhook)
  }

  get(id: number): WebhookDto | undefined {
    const r = this.db.get<WebhookRow>(`${SELECT} WHERE w.id = ?`, [id])
    return r && mapWebhook(r)
  }

  /** Enabled webhooks subscribed to an event type. */
  subscribed(event: WebhookEvent): WebhookDto[] {
    return this.list().filter((w) => w.enabled && w.events.includes(event))
  }

  create(w: WebhookInput): number {
    return this.db.run(
      'INSERT INTO webhooks (name, url, secret, enabled, events, door_ids, headers) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        w.name,
        w.url,
        newWebhookSecret(),
        fromBool(w.enabled),
        JSON.stringify(w.events),
        JSON.stringify(w.doorIds),
        JSON.stringify(w.headers),
      ],
    ).lastInsertRowid
  }

  update(id: number, w: WebhookInput): boolean {
    return (
      this.db.run(
        'UPDATE webhooks SET name = ?, url = ?, enabled = ?, events = ?, door_ids = ?, headers = ? WHERE id = ?',
        [
          w.name,
          w.url,
          fromBool(w.enabled),
          JSON.stringify(w.events),
          JSON.stringify(w.doorIds),
          JSON.stringify(w.headers),
          id,
        ],
      ).changes > 0
    )
  }

  setSecret(id: number, secret: string): boolean {
    return this.db.run('UPDATE webhooks SET secret = ? WHERE id = ?', [secret, id]).changes > 0
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM webhooks WHERE id = ?', [id]).changes > 0
  }

  /** Records the outcome of a delivery and keeps only the most recent ones. */
  addDelivery(d: Omit<WebhookDeliveryDto, 'id' | 'at'>): void {
    this.db.tx(() => {
      // the webhook may have been deleted while the request was in flight
      if (!this.db.get('SELECT 1 FROM webhooks WHERE id = ?', [d.webhookId])) return
      this.db.run(
        'INSERT INTO webhook_deliveries (webhook_id, delivery_id, event, ok, status_code, error, duration_ms, attempts, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          d.webhookId,
          d.deliveryId,
          d.event,
          fromBool(d.ok),
          d.statusCode,
          d.error,
          d.durationMs,
          d.attempts,
          d.payload,
        ],
      )
      this.db.run(
        `DELETE FROM webhook_deliveries WHERE webhook_id = ? AND id <= (
           SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        [d.webhookId, d.webhookId, KEEP_DELIVERIES],
      )
    })
  }

  deliveries(webhookId: number, limit = KEEP_DELIVERIES): WebhookDeliveryDto[] {
    return this.db
      .all<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?', [
        webhookId,
        limit,
      ])
      .map(mapDelivery)
  }
}
