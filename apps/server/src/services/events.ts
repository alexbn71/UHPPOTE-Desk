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
import { localDateTime } from '../util/time.js'

export interface CollectResult {
  controllerId: number
  collected: number
  skipped: number
  from: number
  to: number
}

/**
 * Raccolta eventi: push (listener UDP) + pull (lettura per indice).
 * Il push dà la notifica immediata; il pull garantisce che nessun evento vada perso.
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

  /** Gestisce uno status/evento ricevuto (dal listener o dal polling). */
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
      // indice già raccolto: se non lo conosciamo il controller ha ricominciato la numerazione
      if (!this.events.exists(c.id, c.eventEpoch, ev.index)) pull()
      return
    }
    this.store(c.id, c.eventEpoch, ev)
    if (last > 0 && ev.index === last + 1) this.controllers.setCollectedIndex(c.id, ev.index)
    else pull() // primo contatto (backfill) o buco negli indici
  }

  /** Salva l'evento; true se era nuovo. */
  private store(controllerId: number, epoch: number, ev: ControllerEvent): boolean {
    const inserted = this.events.insert({ controllerId, epoch, ...ev })
    if (inserted) this.gateway.hub.publishEvent(inserted)
    return inserted !== null
  }

  /**
   * Scarica dal controller tutti gli eventi successivi all'ultimo raccolto.
   * Una sola raccolta alla volta per controller.
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
          // il controller ha ricominciato la numerazione (restore default / sostituzione): nuova epoca
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
