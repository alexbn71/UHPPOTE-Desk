import {
  EventListener,
  EventOverwrittenError,
  NotFoundError,
  Reason,
  type ControllerEvent,
  type ControllerStatus,
  type Logger,
} from '@uhppote-desk/protocol'
import type { ControllerRepo, EventRepo } from '../db/repos.js'
import type { ControllerGateway } from '../gateway/gateway.js'
import {
  EVENT_TYPE_INPUT,
  INPUT_CLOSED_REASON,
  INPUT_OPENED_REASON,
  SERVER_EVENT_EPOCH,
  type ControllerLiveState,
  type EventDto,
} from '@uhppote-desk/shared'
import { localDateTime, parseLocal } from '../util/time.js'

/**
 * Events older than this (backfill, offline swipes collected later) are stored
 * but do not trigger integrations (MQTT event entities, webhooks).
 */
export const RECENT_EVENT_MS = 10 * 60_000

/**
 * Status polling interval while a fire alarm is active (its end sends no event) or, with an expansion board,
 * while its outputs may be switching after an event; also the polling interval of the board status, since its
 * inputs A1-A3 send no event.
 */
export const ALARM_POLL_MS = 2000

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
  /** Controllers whose status is polled quickly because of a fire alarm or of the expansion board outputs. */
  private readonly watching = new Map<number, NodeJS.Timeout>()
  /** Polling of the expansion board status (inputs A1-A3, outputs), while the listener runs. */
  private boardPoll: NodeJS.Timeout | null = null

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
    this.listener.on('invalid', (_pkt, from) =>
      this.opts.logger?.warn?.(`unrecognised packet from ${from.address}:${from.port}`),
    )
    const address = await this.listener.start()
    this.pollBoards()
    return address
  }

  /** Reads the status of every expansion board every ALARM_POLL_MS: its inputs A1-A3 send no event. */
  private pollBoards(): void {
    this.boardPoll = setTimeout(async () => {
      const ids = this.controllers
        .list()
        .filter((c) => c.enabled && this.hasBoard(c.id) && this.gateway.hub.state(c.id).online)
        .map((c) => c.id)
      await Promise.all(ids.map((id) => this.refreshExpansion(id).catch(() => false)))
      if (this.boardPoll) this.pollBoards()
    }, ALARM_POLL_MS).unref()
  }

  async stopListener(): Promise<void> {
    await this.listener?.stop()
    this.listener = null
    if (this.boardPoll) clearTimeout(this.boardPoll)
    this.boardPoll = null
    for (const timer of this.watching.values()) clearTimeout(timer)
    this.watching.clear()
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
    // the packet of a fire event (fire input of the controller or of the expansion board) is sent before the
    // controller sets its fire bit: the event itself says that the alarm is on. Only pushed packets: a polled
    // status keeps reporting the last event long after the alarm is over.
    const pushedFire = fromAddress !== undefined && s.event?.reason === Reason.Fire
    this.gateway.hub.updateFromStatus(c.id, pushedFire ? { ...s, fireAlarm: true } : s, now)
    // with an expansion board, any pushed event may switch an output: follow them until they are off
    const boardEvent = fromAddress !== undefined && s.event !== null && this.hasBoard(c.id)
    if (pushedFire || s.fireAlarm || boardEvent) this.watch(c.id)
    if (!s.event) return
    const ev = s.event
    const last = c.lastCollectedIndex
    const pull = () =>
      void this.collect(c.id).catch((err) =>
        this.opts.logger?.warn?.(`event recovery ${c.serial}: ${(err as Error).message}`),
      )

    if (last > 0 && ev.index <= last) {
      // index already collected: if we do not know it, the controller restarted its numbering
      if (!this.events.exists(c.id, c.eventEpoch, ev.index)) pull()
      return
    }
    this.store(c.id, c.eventEpoch, ev)
    if (last > 0 && ev.index === last + 1) this.controllers.setCollectedIndex(c.id, ev.index)
    else pull() // first contact (backfill) or gap in the indexes
  }

  /** Whether the controller is configured with the UT0311-01A expansion board. */
  private hasBoard(controllerId: number): boolean {
    return this.controllers.settings(controllerId).expansionBoard.installed
  }

  /**
   * Reads the outputs and the inputs of the expansion board (vendor status, long packet) into the live state;
   * null when the controller has no board. Returns whether an output or the fire input is on.
   */
  async refreshExpansion(controllerId: number): Promise<boolean> {
    if (!this.hasBoard(controllerId)) {
      if (this.gateway.hub.state(controllerId).expansion) this.gateway.hub.patch(controllerId, { expansion: null })
      return false
    }
    const ls = await this.gateway.run(null, controllerId, 'health', null, (client, t) => client.readLongStatus(t), {
      audit: false,
    })
    this.recordInputChanges(controllerId, this.gateway.hub.state(controllerId).expansion, ls.expansionInputs)
    this.gateway.hub.patch(controllerId, {
      expansion: { outputs: ls.expansionOutputs, fireInput: ls.expansionFireInput, inputs: ls.expansionInputs },
    })
    const active = ls.expansionFireInput || ls.expansionOutputs.some(Boolean)
    if (active) this.watch(controllerId)
    return active
  }

  /**
   * Records an event for every input A1-A3 in use that changed since the previous reading (the controller sends
   * none). The first reading only sets the starting state.
   */
  private recordInputChanges(
    controllerId: number,
    before: ControllerLiveState['expansion'],
    inputs: [boolean, boolean, boolean],
  ): void {
    if (!before) return
    const inUse = this.controllers.settings(controllerId).expansionBoard.inputEvents
    inputs.forEach((open, i) => {
      if (!inUse[i] || before.inputs[i] === open) return
      this.store(controllerId, SERVER_EVENT_EPOCH, {
        index: this.events.nextIndex(controllerId, SERVER_EVENT_EPOCH),
        type: EVENT_TYPE_INPUT,
        granted: false,
        door: 0,
        direction: 0,
        card: 0,
        timestamp: localDateTime() as ControllerEvent['timestamp'],
        reason: (open ? INPUT_OPENED_REASON : INPUT_CLOSED_REASON) + i + 1,
      })
    })
  }

  /**
   * While a fire alarm or an output of the expansion board is on, polls the status every ALARM_POLL_MS so that
   * the end (which sends no event) is seen at once instead of at the next health check; stops after two polls
   * with nothing active.
   */
  private watch(controllerId: number): void {
    if (this.watching.has(controllerId)) return
    let quiet = 0
    const poll = async () => {
      try {
        const s = await this.gateway.run(null, controllerId, 'health', null, (client, t) => client.getStatus(t), {
          audit: false,
        })
        this.onStatus(s)
        const board = await this.refreshExpansion(controllerId).catch(() => false)
        quiet = s.fireAlarm || board ? 0 : quiet + 1
      } catch {
        quiet = 2 // offline: the health check takes over
      }
      if (quiet >= 2 || !this.watching.has(controllerId)) {
        this.watching.delete(controllerId)
        return
      }
      this.watching.set(controllerId, setTimeout(() => void poll(), ALARM_POLL_MS).unref())
    }
    this.watching.set(controllerId, setTimeout(() => void poll(), ALARM_POLL_MS).unref())
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
          this.opts.logger?.warn?.(
            `controller ${c.serial}: event index ${last} < last collected ${c.lastCollectedIndex}, starting a new epoch`,
          )
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
