import { EventEmitter } from 'node:events'
import type { Logger } from '@uhppote-desk/protocol'
import { ALARM_REASONS, translator, type ControllerLiveState, type DoorDto, type EventDto, type WebhookEvent, type WsMessage } from '@uhppote-desk/shared'
import type { ControllerRecord, ControllerRepo } from '../db/repos.js'
import type { LiveHub } from '../gateway/gateway.js'
import { isRecentEvent } from './events.js'

const en = translator('en')

/** Something that happened, as seen by the integrations (webhooks, notifications). */
export interface IntegrationEvent {
  type: WebhookEvent
  controller: ControllerRecord
  door: DoorDto | null
  /** Type-specific details (also the `data` of the webhook payload). */
  data: Record<string, unknown>
  /** The stored event, for access events, door events and alarms. */
  event: EventDto | null
  /** Live state, for door sensor changes and controller online/offline. */
  state: ControllerLiveState | null
}

/**
 * Turns the live hub messages into integration events: access granted/denied, door events,
 * alarms (recent events only), door sensor changes and controllers going online/offline.
 */
export class IntegrationEvents extends EventEmitter<{ event: [IntegrationEvent] }> {
  private readonly states = new Map<number, ControllerLiveState>()
  private readonly onHub = (m: WsMessage) => this.onHubMessage(m)
  private started = false

  constructor(
    private readonly controllers: ControllerRepo,
    private readonly hub: LiveHub,
    private readonly logger?: Logger,
  ) {
    super()
    this.setMaxListeners(0)
  }

  /** Idempotent: every consumer calls it in its own start(). */
  start(): void {
    if (this.started) return
    this.started = true
    this.hub.on('message', this.onHub)
  }

  stop(): void {
    this.started = false
    this.hub.off('message', this.onHub)
  }

  /** Doors of a controller (for door filters on controller-level events). */
  controllerDoorIds(controllerId: number): number[] {
    return this.controllers.doors(controllerId).map((d) => d.id)
  }

  private onHubMessage(m: WsMessage): void {
    try {
      if (m.type === 'status') this.onStatus(m.state)
      else if (m.type === 'event') this.onEvent(m.event)
    } catch (err) {
      this.logger?.error?.(`integration events: ${(err as Error).message}`)
    }
  }

  private onStatus(s: ControllerLiveState): void {
    const prev = this.states.get(s.controllerId)
    this.states.set(s.controllerId, s)
    if (!prev) return // first state after start: nothing changed yet
    const c = this.controllers.get(s.controllerId)
    if (!c?.enabled) return
    if (prev.online !== s.online) {
      this.publish(s.online ? 'controller.online' : 'controller.offline', c, null, { lastSeenAt: s.lastSeenAt, error: s.online ? null : s.lastError }, null, s)
    }
    if (!prev.online || !s.online) return
    for (const d of s.doors) {
      const before = prev.doors.find((x) => x.door === d.door)
      if (before && before.open !== d.open) this.publish(d.open ? 'door.opened' : 'door.closed', c, d.door, { open: d.open, unlocked: d.unlocked }, null, s)
    }
  }

  private onEvent(e: EventDto): void {
    if (!isRecentEvent(e)) return
    // alarms are recognised by their reason (door open too long, forced, fire, …); other
    // controller events (power on, reset) are not forwarded
    const type: WebhookEvent | null = ALARM_REASONS.has(e.reason)
      ? 'alarm'
      : e.type === 1
        ? e.granted
          ? 'access.granted'
          : 'access.denied'
        : e.type === 2
          ? 'door.event'
          : null
    const c = type && this.controllers.get(e.controllerId)
    if (!type || !c?.enabled) return
    this.publish(
      type,
      c,
      e.door >= 1 && e.door <= 4 ? e.door : null,
      {
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
      },
      e,
      null,
    )
  }

  private publish(
    type: WebhookEvent,
    controller: ControllerRecord,
    doorNumber: number | null,
    data: Record<string, unknown>,
    event: EventDto | null,
    state: ControllerLiveState | null,
  ): void {
    const door = doorNumber === null ? null : (this.controllers.doorByNumber(controller.id, doorNumber) ?? null)
    this.emit('event', { type, controller, door, data, event, state })
  }
}

/**
 * Door filter shared by webhooks and notifications: with doors selected, door events pass for those
 * doors and controller events for the controllers that have one of them.
 */
export function matchesDoors(doorIds: number[], ev: IntegrationEvent, controllerDoorIds: () => number[]): boolean {
  if (doorIds.length === 0) return true
  if (ev.door) return doorIds.includes(ev.door.id)
  return controllerDoorIds().some((id) => doorIds.includes(id))
}
