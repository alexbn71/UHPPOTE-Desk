import {
  EventListener,
  EventOverwrittenError,
  NotFoundError,
  type ControllerEvent,
  type ControllerStatus,
  type Logger,
} from '@uhppote-desk/protocol'
import type { ControllerRepo, EventRepo } from '../db/repos.js'
import type { ControllerGateway } from '../gateway/gateway.js'
import type { EventDto } from '@uhppote-desk/shared'
import { localDateTime, parseLocal } from '../util/time.js'

/**
 * Events older than this (backfill, offline swipes collected later) are stored
 * but do not trigger integrations (MQTT event entities, webhooks).
 */
export const RECENT_EVENT_MS = 10 * 60_000

export function isRecentEvent(e: Pick<EventDto, 'timestamp'>, now = Date.now()): boolean {
  return !e.timestamp || now - parseLocal(e.timestamp).getTime() <= RECENT_EVENT_MS
}

export interface CollectResult {
  controllerId: number
  collected: number
  skipped: number
  from: number
  to: number
}

/**
 * Event collection: push (UDP listener) + pull (read by index).
 * Push gives immediate notification; pull guarantees that no event is lost.
 */
export class EventService {
  private listener: EventListener | null = null
  private readonly running = new Map<number, Promise<CollectResult>>()

  constructor(
    private readonly gateway: ControllerGateway,
    private readonly controllers: ControllerRepo,
    private readonly events: EventRepo,
    private readonly opts: { listen: string; initialBackfill: number; logger?: Logger | undefined },
  ) {}

  async startListener(): Promise<{ address: string; port: number }> {
    this.listener = new EventListener(this.opts.listen, this.opts.logger)
    this.listener.on('status', (s, from) => this.onStatus(s, from.address))
    this.listener.on('error', (err) => this.opts.logger?.error?.(`event listener: ${err.message}`))
    this.listener.on('invalid', (_pkt, from) => this.opts.logger?.warn?.(`unrecognised packet from ${from.address}:${from.port}`))
    return this.listener.start()
  }

  async stopListener(): Promise<void> {
    await this.listener?.stop()
    this.listener = null
  }

  /** Handles a received status/event (from the listener or from polling). */
  onStatus(s: ControllerStatus, fromAddress?: string): void {
    const c = this.controllers.getBySerial(s.controller)
    if (!c) {
      this.opts.logger?.warn?.(`event from unknown controller ${s.controller} (${fromAddress ?? '?'})`)
      return
    }
    const now = localDateTime()
    this.controllers.markSeen(c.id, now)
    this.gateway.hub.updateFromStatus(c.id, s, now)
    if (!s.event) return
    const ev = s.event
    const last = c.lastCollectedIndex
    const pull = () =>
      void this.collect(c.id).catch((err) => this.opts.logger?.warn?.(`event recovery ${c.serial}: ${(err as Error).message}`))

    if (last > 0 && ev.index <= last) {
      // index already collected: if we do not know it, the controller restarted its numbering
      if (!this.events.exists(c.id, c.eventEpoch, ev.index)) pull()
      return
    }
    this.store(c.id, c.eventEpoch, ev)
    if (last > 0 && ev.index === last + 1) this.controllers.setCollectedIndex(c.id, ev.index)
    else pull() // first contact (backfill) or gap in the indexes
  }

  /** Saves the event; true if it was new. */
  private store(controllerId: number, epoch: number, ev: ControllerEvent): boolean {
    const inserted = this.events.insert({ controllerId, epoch, ...ev })
    if (inserted) this.gateway.hub.publishEvent(inserted)
    return inserted !== null
  }

  /**
   * Downloads from the controller all the events after the last one collected.
   * Only one collection at a time per controller.
   */
  collect(controllerId: number): Promise<CollectResult> {
    const existing = this.running.get(controllerId)
    if (existing) return existing
    const job = this.doCollect(controllerId).finally(() => this.running.delete(controllerId))
    this.running.set(controllerId, job)
    return job
  }

  private async doCollect(controllerId: number): Promise<CollectResult> {
    return this.gateway.run(
      null,
      controllerId,
      'collect-events',
      null,
      async (client, target, c) => {
        const last = await client.getLastEventIndex(target)
        let epoch = c.eventEpoch
        let start = c.lastCollectedIndex + 1
        if (last < c.lastCollectedIndex) {
          // the controller restarted its numbering (factory reset / replacement): new epoch
          this.opts.logger?.warn?.(`controller ${c.serial}: event index ${last} < last collected ${c.lastCollectedIndex}, starting a new epoch`)
          epoch = this.controllers.startNewEventEpoch(c.id)
          start = 1
        } else if (c.lastCollectedIndex === 0) {
          start = Math.max(1, last - this.opts.initialBackfill + 1)
        }

        let collected = 0
        let skipped = 0
        for (let i = start; i <= last; i++) {
          if (this.events.exists(c.id, epoch, i)) {
            this.controllers.setCollectedIndex(c.id, i)
            continue
          }
          try {
            const ev = await client.getEvent(target, i)
            this.store(c.id, epoch, ev)
            collected++
          } catch (err) {
            if (err instanceof EventOverwrittenError) {
              skipped++
            } else if (err instanceof NotFoundError) {
              break
            } else {
              throw err
            }
          }
          this.controllers.setCollectedIndex(c.id, i)
        }
        return { controllerId, collected, skipped, from: start, to: last }
      },
      { audit: false },
    )
  }
}
