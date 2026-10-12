import { createHmac, randomUUID } from 'node:crypto'
import type { Logger } from '@uhppote-desk/protocol'
import type { WebhookDeliveryDto, WebhookPayload } from '@uhppote-desk/shared'
import type { WebhookRepo } from '../db/webhooks.js'
import { matchesDoors, type IntegrationEvent, type IntegrationEvents } from './integrationEvents.js'

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
  private readonly sleeping = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>()
  private readonly onEvent = (ev: IntegrationEvent) => this.dispatch(ev)
  private stopped = false

  constructor(
    private readonly repo: WebhookRepo,
    private readonly events: IntegrationEvents,
    private readonly opts: { version: string; logger?: Logger | undefined; timeoutMs?: number; retryDelaysMs?: number[] },
  ) {}

  start(): void {
    this.stopped = false
    this.events.on('event', this.onEvent)
    this.events.start()
  }

  /** Stops listening and abandons the pending retries. */
  stop(): void {
    this.stopped = true
    this.events.off('event', this.onEvent)
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

  private dispatch(ev: IntegrationEvent): void {
    try {
      const hooks = this.repo.subscribed(ev.type)
      const c = ev.controller
      for (const hook of hooks) {
        if (!matchesDoors(hook.doorIds, ev, () => this.events.controllerDoorIds(c.id))) continue
        this.enqueue(hook.id, {
          id: randomUUID(),
          type: ev.type,
          occurredAt: new Date().toISOString(),
          controller: { id: c.id, serial: c.serial, name: c.name },
          door: ev.door ? { id: ev.door.id, number: ev.door.door, name: ev.door.name } : null,
          data: ev.data,
        })
      }
    } catch (err) {
      this.opts.logger?.error?.(`webhooks: ${(err as Error).message}`)
    }
  }

  // --- delivery ---------------------------------------------------------------

  /** Queues a `rule.triggered` request for one webhook (automation rules); false if it does not exist or is disabled. */
  sendRule(webhookId: number, payload: Omit<WebhookPayload, 'id' | 'type' | 'occurredAt'>): boolean {
    if (!this.repo.get(webhookId)?.enabled) return false
    this.enqueue(webhookId, { id: randomUUID(), type: 'rule.triggered', occurredAt: new Date().toISOString(), ...payload })
    return true
  }

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
