import { EventEmitter } from 'node:events'
import { UhppoteClient, type ControllerTarget, type ControllerStatus, type Logger } from '@uhppote-desk/protocol'
import type { ControllerLiveState, EventDto, WsMessage } from '@uhppote-desk/shared'
import type { AuditLog } from '../db/audit.js'
import type { ControllerRecord, ControllerRepo } from '../db/repos.js'
import type { SessionUser } from '../auth/auth.js'
import { HttpError } from '../auth/auth.js'

export type Actor = Pick<SessionUser, 'id' | 'username'> | null

/** Internal bus of real-time updates (forwarded to the WebSocket clients). */
export class LiveHub extends EventEmitter<{ message: [WsMessage] }> {
  private readonly states = new Map<number, ControllerLiveState>()

  constructor() {
    super()
    this.setMaxListeners(0) // one listener per WebSocket client
  }

  state(controllerId: number): ControllerLiveState {
    return (
      this.states.get(controllerId) ?? {
        controllerId,
        online: false,
        lastSeenAt: null,
        controllerTime: null,
        driftSeconds: null,
        doors: [1, 2, 3, 4].map((door) => ({ door, open: false, button: false, unlocked: false })),
        forceLock: false,
        fireAlarm: false,
        systemError: 0,
        lastError: null,
      }
    )
  }

  allStates(): ControllerLiveState[] {
    return [...this.states.values()]
  }

  updateFromStatus(controllerId: number, s: ControllerStatus, at: string): ControllerLiveState {
    const prev = this.state(controllerId)
    const next: ControllerLiveState = {
      ...prev,
      online: true,
      lastSeenAt: at,
      controllerTime: s.systemDate && s.systemTime ? `${s.systemDate} ${s.systemTime}` : prev.controllerTime,
      doors: [0, 1, 2, 3].map((i) => ({
        door: i + 1,
        open: s.doorOpen[i]!,
        button: s.buttonPressed[i]!,
        unlocked: s.relayUnlocked[i]!,
      })),
      forceLock: s.forceLock,
      fireAlarm: s.fireAlarm,
      systemError: s.systemError,
      lastError: null,
    }
    this.set(next)
    return next
  }

  patch(controllerId: number, patch: Partial<ControllerLiveState>): ControllerLiveState {
    const next = { ...this.state(controllerId), ...patch }
    this.set(next)
    return next
  }

  private set(state: ControllerLiveState): void {
    const prev = this.states.get(state.controllerId)
    this.states.set(state.controllerId, state)
    if (JSON.stringify(prev) !== JSON.stringify(state)) this.emit('message', { type: 'status', state })
  }

  remove(controllerId: number): void {
    this.states.delete(controllerId)
  }

  publishEvent(event: EventDto): void {
    this.emit('message', { type: 'event', event })
  }

  /** An automation rule fired (shown in the web app). */
  publishRule(msg: Omit<Extract<WsMessage, { type: 'rule' }>, 'type'>): void {
    this.emit('message', { type: 'rule', ...msg })
  }

  /** Synchronisation progress; `code` is a key under `sync.progress.*` (or `errors.*` for errors). */
  publishSync(controllerId: number, status: 'running' | 'ok' | 'error', code: string, params: Record<string, string | number> = {}): void {
    this.emit('message', { type: 'sync', controllerId, status, code, params })
  }
}

/**
 * Single access point to the controllers: resolves addressing from the DB,
 * records operations in the audit log and updates the online/offline state.
 */
export class ControllerGateway {
  readonly client: UhppoteClient

  constructor(
    private readonly controllers: ControllerRepo,
    private readonly audit: AuditLog,
    readonly hub: LiveHub,
    opts: { bindAddress: string; broadcast: string; timeoutMs: number; retries: number; logger?: Logger | undefined },
  ) {
    this.client = new UhppoteClient({
      bindAddress: opts.bindAddress,
      broadcast: opts.broadcast,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      ...(opts.logger ? { logger: opts.logger } : {}),
    })
  }

  target(c: Pick<ControllerRecord, 'serial' | 'host' | 'port' | 'transport'>): ControllerTarget {
    return { id: c.serial, host: c.host, port: c.port, transport: c.transport }
  }

  controller(id: number): ControllerRecord {
    const c = this.controllers.get(id)
    if (!c) throw new HttpError(404, 'controllerNotFound')
    return c
  }

  /** Runs a command on a controller with auditing and state handling. */
  async run<T>(
    actor: Actor,
    controllerId: number,
    action: string,
    details: unknown,
    fn: (client: UhppoteClient, target: ControllerTarget, controller: ControllerRecord) => Promise<T>,
    opts: { audit?: boolean } = {},
  ): Promise<T> {
    const c = this.controller(controllerId)
    const exec = async () => {
      try {
        return await fn(this.client, this.target(c), c)
      } catch (err) {
        this.hub.patch(c.id, { lastError: (err as Error).message })
        throw err
      }
    }
    if (opts.audit === false) return exec()
    return this.audit.track(actor, action, `controller:${c.serial}`, details, exec)
  }
}
