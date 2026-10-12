import { createHmac, randomUUID } from 'node:crypto'
import type { Logger } from '@uhppote-desk/protocol'
import {
  translator,
  type ControllerLiveState,
  type EventDto,
  type WebhookDeliveryDto,
  type WebhookEvent,
  type WebhookPayload,
  type WsMessage,
} from '@uhppote-desk/shared'
import type { ControllerRecord, ControllerRepo } from '../db/repos.js'
import type { WebhookRepo } from '../db/webhooks.js'
import type { LiveHub } from '../gateway/gateway.js'
import { isRecentEvent } from './events.js'

const en = translator('en')

/** Requests waiting per webhook beyond which new ones are dropped (endpoint down for a long time). */
const MAX_QUEUE = 500

export type DeliveryResult = Omit<WebhookDeliveryDto, 'id' | 'at'>

interface Attempt {
  ok: boolean
  statusCode: number | null
  error: string | null
  durationMs: number
}

/**
 * Outgoing webhooks: POSTs a signed JSON payload to the configured URLs on
 * access events, door state changes and controller online/offline.
 *
 * Signature: `X-UHPPOTE-Signature: sha256=<hex HMAC-SHA256(secret, "<X-UHPPOTE-Timestamp>.<body>")>`.
 * Each webhook has its own queue, so its requests arrive in order; failed requests
 * (network error, 5xx, 429) are retried with backoff.
 */
export class WebhookService {
  private readonly queues = new Map<number, { tail: Promise<void>; pending: number }>()
  private readonly states = new Map<number, ControllerLiveState>()
  private readonly sleeping = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>()
  private readonly onHub = (m: WsMessage) => this.onHubMessage(m)
  private stopped = false

  constructor(
    private readonly repo: WebhookRepo,
    private readonly controllers: ControllerRepo,
    private readonly hub: LiveHub,
    private readonly opts: { version: string; logger?: Logger | undefined; timeoutMs?: number; retryDelaysMs?: number[] },
  ) {}

  start(): void {
    this.stopped = false
    this.hub.on('message', this.onHub)
  }

  /** Stops listening and abandons the pending retries. */
  stop(): void {
    this.stopped = true
    this.hub.off('message', this.onHub)
    for (const s of this.sleeping) {
      clearTimeout(s.timer)
      s.resolve()
    }
    this.sleeping.clear()
  }

  /** Waits until every queued request has been delivered (tests). */
  async idle(): Promise<void> {
    while ([...this.queues.values()].some((q) => q.pending > 0)) {
      await Promise.all([...this.queues.values()].map((q) => q.tail))
    }
  }

  /** Sends a `webhook.test` request right away (even if the webhook is disabled), without retries. */
  async test(webhookId: number): Promise<DeliveryResult | null> {
    const payload: WebhookPayload = {
      id: randomUUID(),
      type: 'webhook.test',
      occurredAt: new Date().toISOString(),
      controller: null,
      door: null,
      data: { message: 'Test request from UHPPOTE Desk' },
    }
    return this.deliver(webhookId, payload, { retries: false, evenIfDisabled: true })
  }

  // --- triggers ---------------------------------------------------------------

  private onHubMessage(m: WsMessage): void {
    try {
      if (m.type === 'status') this.onStatus(m.state)
      else if (m.type === 'event') this.onEvent(m.event)
    } catch (err) {
      this.opts.logger?.error?.(`webhooks: ${(err as Error).message}`)
    }
  }

  private onStatus(s: ControllerLiveState): void {
    const prev = this.states.get(s.controllerId)
    this.states.set(s.controllerId, s)
    if (!prev) return // first state after start: nothing changed yet
    const c = this.controllers.get(s.controllerId)
    if (!c?.enabled) return
    if (prev.online !== s.online) {
      this.emit(s.online ? 'controller.online' : 'controller.offline', c, null, { lastSeenAt: s.lastSeenAt, error: s.online ? null : s.lastError })
    }
    if (!prev.online || !s.online) return
    for (const d of s.doors) {
      const before = prev.doors.find((x) => x.door === d.door)
      if (before && before.open !== d.open) this.emit(d.open ? 'door.opened' : 'door.closed', c, d.door, { open: d.open, unlocked: d.unlocked })
    }
  }

  private onEvent(e: EventDto): void {
    if (!isRecentEvent(e)) return
    const type: WebhookEvent | null = e.type === 1 ? (e.granted ? 'access.granted' : 'access.denied') : e.type === 2 ? 'door.event' : e.type === 3 ? 'alarm' : null
    const c = type && this.controllers.get(e.controllerId)
    if (!type || !c?.enabled) return
    this.emit(type, c, e.door >= 1 && e.door <= 4 ? e.door : null, {
      index: e.index,
      eventType: e.type,
      card: e.card || null,
      personId: e.personId,
      personName: e.personName,
      granted: e.granted,
      direction: e.direction === 1 ? 'in' : e.direction === 2 ? 'out' : null,
      reasonCode: e.reason,
      reason: en.reason(e.reason),
      timestamp: e.timestamp,
    })
  }

  private emit(type: WebhookEvent, c: ControllerRecord, doorNumber: number | null, data: Record<string, unknown>): void {
    const hooks = this.repo.subscribed(type)
    if (hooks.length === 0) return
    const door = doorNumber === null ? undefined : this.controllers.doorByNumber(c.id, doorNumber)
    const controllerDoorIds = this.controllers.doors(c.id).map((d) => d.id)
    for (const hook of hooks) {
      if (hook.doorIds.length > 0) {
        // door filter: door events of those doors, controller events of their controllers
        const match = door ? hook.doorIds.includes(door.id) : controllerDoorIds.some((id) => hook.doorIds.includes(id))
        if (!match) continue
      }
      this.enqueue(hook.id, {
        id: randomUUID(),
        type,
        occurredAt: new Date().toISOString(),
        controller: { id: c.id, serial: c.serial, name: c.name },
        door: door ? { id: door.id, number: door.door, name: door.name } : null,
        data,
      })
    }
  }

  // --- delivery ---------------------------------------------------------------

  private enqueue(webhookId: number, payload: WebhookPayload): void {
    let q = this.queues.get(webhookId)
    if (!q) {
      q = { tail: Promise.resolve(), pending: 0 }
      this.queues.set(webhookId, q)
    }
    if (q.pending >= MAX_QUEUE) {
      this.opts.logger?.warn?.(`webhook ${webhookId}: ${q.pending} requests waiting, ${payload.type} dropped`)
      return
    }
    const queue = q
    queue.pending++
    queue.tail = queue.tail
      .then(() => this.deliver(webhookId, payload, { retries: true }))
      .then(
        () => undefined,
        (err: Error) => this.opts.logger?.error?.(`webhook ${webhookId}: ${err.message}`),
      )
      .finally(() => queue.pending--)
  }

  private async deliver(webhookId: number, payload: WebhookPayload, opts: { retries: boolean; evenIfDisabled?: boolean }): Promise<DeliveryResult | null> {
    const body = JSON.stringify(payload)
    const delays = opts.retries ? (this.opts.retryDelaysMs ?? [2000, 10_000, 60_000]) : []
    let attempts = 0
    let last: Attempt | null = null
    for (;;) {
      // read at every attempt: the webhook may have been changed, disabled or deleted meanwhile
      const hook = this.repo.get(webhookId)
      if (!hook || (!hook.enabled && !opts.evenIfDisabled)) break
      attempts++
      last = await this.send(hook.url, hook.secret, hook.headers, payload, body)
      if (last.ok || !retryable(last) || attempts > delays.length || this.stopped) break
      await this.sleep(delays[attempts - 1]!)
      if (this.stopped) break
    }
    if (!last) return null
    const result: DeliveryResult = { webhookId, deliveryId: payload.id, event: payload.type, ...last, attempts, payload: body }
    this.repo.addDelivery(result)
    if (!last.ok) this.opts.logger?.warn?.(`webhook ${webhookId}: ${payload.type} not delivered after ${attempts} attempt(s): ${last.error}`)
    return result
  }

  private async send(url: string, secret: string, extra: Record<string, string>, payload: WebhookPayload, body: string): Promise<Attempt> {
    const timestamp = String(Math.floor(Date.now() / 1000))
    const headers = new Headers(extra)
    headers.set('Content-Type', 'application/json')
    headers.set('User-Agent', `UHPPOTE-Desk/${this.opts.version}`)
    headers.set('X-UHPPOTE-Event', payload.type)
    headers.set('X-UHPPOTE-Delivery', payload.id)
    headers.set('X-UHPPOTE-Timestamp', timestamp)
    headers.set('X-UHPPOTE-Signature', `sha256=${sign(secret, timestamp, body)}`)
    const started = Date.now()
    try {
      const res = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000) })
      const text = await res.text().catch(() => '')
      const ok = res.status >= 200 && res.status < 300
      return {
        ok,
        statusCode: res.status,
        error: ok ? null : `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
        durationMs: Date.now() - started,
      }
    } catch (err) {
      const e = err as Error & { cause?: { message?: string; code?: string } }
      const error = e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.cause?.message ?? e.message)
      return { ok: false, statusCode: null, error, durationMs: Date.now() - started }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const entry = {
        timer: setTimeout(() => {
          this.sleeping.delete(entry)
          resolve()
        }, ms),
        resolve,
      }
      this.sleeping.add(entry)
    })
  }
}

/** Hex HMAC-SHA256 of "<timestamp>.<body>". */
export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

/** Network errors, server errors and rate limiting are worth another attempt; other 4xx are not. */
function retryable(a: Attempt): boolean {
  return a.statusCode === null || a.statusCode >= 500 || a.statusCode === 429
}
