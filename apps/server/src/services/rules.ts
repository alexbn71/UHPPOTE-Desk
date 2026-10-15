import type { Logger } from '@uhppote-desk/protocol'
import { DOOR_OPEN_FOR, translator, type DoorDto, type Language, type RuleDto } from '@uhppote-desk/shared'
import type { ControllerRecord, ControllerRepo } from '../db/repos.js'
import type { RuleRepo } from '../db/rules.js'
import type { ControllerGateway } from '../gateway/gateway.js'
import { localDateTime, parseLocal } from '../util/time.js'
import { inWindow, minuteOfDay } from './anomalies.js'
import type { IntegrationEvent, IntegrationEvents } from './integrationEvents.js'
import { eventMessage, type NotifyMessage } from './notify/messages.js'
import type { NotificationService } from './notify/notifications.js'
import type { WebhookService } from './webhooks.js'

/** Door events within this time after a rule opened the door are not evaluated (no rule loops). */
const LOOP_GUARD_MS = 10_000

const SEVERITY: Record<RuleDto['severity'], Pick<NotifyMessage, 'emoji' | 'priority' | 'tags'>> = {
  info: { emoji: 'ℹ️', priority: 3, tags: ['information_source'] },
  warning: { emoji: '⚠️', priority: 4, tags: ['warning'] },
  alarm: { emoji: '🚨', priority: 5, tags: ['rotating_light'] },
}

/** What a rule fired on: an integration event, or a door left open (`seconds`). */
export interface RuleContext {
  event: IntegrationEvent | null
  controller: ControllerRecord
  door: DoorDto | null
  timestamp: string
  seconds: number | null
}

export const formatDuration = (seconds: number) => (seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`)

/** Does the context satisfy the rule conditions? `controllerDoorIds` is used for controller-level events. */
export function matchesConditions(
  rule: Pick<RuleDto, 'conditions'>,
  ctx: RuleContext,
  controllerDoorIds: () => number[],
): boolean {
  const c = rule.conditions
  if (c.doorIds.length > 0) {
    const ok = ctx.door ? c.doorIds.includes(ctx.door.id) : controllerDoorIds().some((id) => c.doorIds.includes(id))
    if (!ok) return false
  }
  if (c.personIds.length > 0 || c.cards.length > 0) {
    const e = ctx.event?.event
    const ok =
      !!e && ((e.personId !== null && c.personIds.includes(e.personId)) || (e.card > 0 && c.cards.includes(e.card)))
    if (!ok) return false
  }
  const date = parseLocal(ctx.timestamp)
  if (!c.weekdays[(date.getDay() + 6) % 7]) return false
  if (c.timeFrom && c.timeTo && !inWindow(minuteOfDay(ctx.timestamp), minuteOfDay(c.timeFrom), minuteOfDay(c.timeTo)))
    return false
  return true
}

/** Text of a firing: the rule message with its placeholders, or an automatic description. */
export function ruleText(rule: Pick<RuleDto, 'message' | 'trigger'>, ctx: RuleContext, lang: Language): string {
  const t = translator(lang)
  const e = ctx.event?.event ?? null
  const doorName = ctx.door?.name ?? ctx.controller.name
  const duration = ctx.seconds !== null ? formatDuration(ctx.seconds) : ''
  if (!rule.message.trim()) {
    if (rule.trigger.type === DOOR_OPEN_FOR) return t.t('notify.rule.openFor', { door: doorName, duration })
    if (!ctx.event) return doorName
    const m = eventMessage(ctx.event, lang)
    return [m.title, ...m.lines.map((l) => (typeof l === 'string' ? l : l.heading))].join('\n')
  }
  const values: Record<string, string> = {
    person: e?.personName ?? (e?.card ? t.t('notify.unknownCard', { card: e.card }) : '—'),
    card: e?.card ? String(e.card) : '—',
    door: doorName,
    controller: ctx.controller.name,
    time: ctx.timestamp.slice(11, 19),
    date: ctx.timestamp.slice(0, 10),
    reason: e ? t.reason(e.reason) : '—',
    duration: duration || '—',
  }
  return rule.message.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all)
}

/**
 * Automation rules: when an event (or a door left open) matches the conditions of a rule,
 * its actions run: notifications, webhooks, door opening; every firing is logged and shown in the app.
 */
export class RuleEngine {
  private readonly onEvent = (ev: IntegrationEvent) => void this.handle(ev)
  /** Pending "door open for" checks, by `${ruleId}:${doorId}`. */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly lastFired = new Map<number, number>()
  private readonly openedByRule = new Map<number, number>()

  constructor(
    private readonly repo: RuleRepo,
    private readonly bus: IntegrationEvents,
    /** Notification and webhook services are read at every firing (they may be replaced, e.g. in tests). */
    private readonly deps: {
      controllers: ControllerRepo
      gateway: ControllerGateway
      notifications: () => NotificationService
      webhooks: () => WebhookService
    },
    private readonly logger?: Logger,
  ) {}

  start(): void {
    this.bus.on('event', this.onEvent)
    this.bus.start()
  }

  stop(): void {
    this.bus.off('event', this.onEvent)
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** Doors with a pending "open for" check (tests, diagnostics). */
  pendingTimers(): string[] {
    return [...this.timers.keys()]
  }

  private clearTimers(doorIds: number[]): void {
    for (const [key, timer] of this.timers) {
      if (doorIds.includes(Number(key.split(':')[1]))) {
        clearTimeout(timer)
        this.timers.delete(key)
      }
    }
  }

  private async handle(ev: IntegrationEvent): Promise<void> {
    try {
      if (ev.type === 'door.closed' && ev.door) this.clearTimers([ev.door.id])
      if (ev.type === 'controller.offline') this.clearTimers(this.bus.controllerDoorIds(ev.controller.id))
      const guarded =
        (ev.type === 'door.event' || ev.type === 'door.opened') &&
        !!ev.door &&
        Date.now() - (this.openedByRule.get(ev.door.id) ?? 0) < LOOP_GUARD_MS
      const ctx: RuleContext = {
        event: ev,
        controller: ev.controller,
        door: ev.door,
        timestamp: ev.event?.timestamp ?? localDateTime(),
        seconds: null,
      }
      const matches = (rule: RuleDto) =>
        matchesConditions(rule, ctx, () => this.bus.controllerDoorIds(ev.controller.id))
      for (const rule of this.repo.list()) {
        if (!rule.enabled) continue
        if (rule.trigger.type === ev.type && !guarded && matches(rule)) await this.fire(rule, ctx)
        if (rule.trigger.type === DOOR_OPEN_FOR && ev.type === 'door.opened' && ev.door && matches(rule))
          this.watchDoor(rule, ev.controller, ev.door)
      }
    } catch (err) {
      this.logger?.error?.(`rules: ${(err as Error).message}`)
    }
  }

  /** Fires the rule if the door is still open after the rule's seconds. */
  private watchDoor(rule: RuleDto, controller: ControllerRecord, door: DoorDto): void {
    const key = `${rule.id}:${door.id}`
    if (this.timers.has(key)) return
    const seconds = rule.trigger.seconds
    const timer = setTimeout(() => {
      this.timers.delete(key)
      const current = this.repo.get(rule.id)
      const state = this.deps.gateway.hub.state(controller.id)
      const open = state.online && state.doors.find((d) => d.door === door.door)?.open
      if (!current?.enabled || current.trigger.type !== DOOR_OPEN_FOR || !open) return
      void this.fire(current, { event: null, controller, door, timestamp: localDateTime(), seconds }).catch(
        (err: Error) => this.logger?.error?.(`rules: ${err.message}`),
      )
    }, seconds * 1000)
    timer.unref()
    this.timers.set(key, timer)
  }

  async fire(rule: RuleDto, ctx: RuleContext): Promise<void> {
    const now = Date.now()
    // the stored last firing keeps the cooldown across restarts
    const last = Math.max(this.lastFired.get(rule.id) ?? 0, rule.lastFiredAt ? parseLocal(rule.lastFiredAt).getTime() : 0)
    if (rule.cooldownSeconds > 0 && now - last < rule.cooldownSeconds * 1000) return
    this.lastFired.set(rule.id, now)

    const text = ruleText(rule, ctx, rule.language)
    const errors: string[] = []
    const t = translator(rule.language)
    const message: NotifyMessage = {
      ...SEVERITY[rule.severity],
      title: rule.name,
      lines: text.split('\n'),
      door: ctx.door ? { id: ctx.door.id, name: ctx.door.name } : null,
    }
    for (const id of rule.actions.channelIds) {
      if (!this.deps.notifications().sendTo(id, message)) errors.push(t.t('notify.rule.channelMissing', { id }))
    }
    for (const id of rule.actions.webhookIds) {
      const sent = this.deps.webhooks().sendRule(id, {
        controller: { id: ctx.controller.id, serial: ctx.controller.serial, name: ctx.controller.name },
        door: ctx.door ? { id: ctx.door.id, number: ctx.door.door, name: ctx.door.name } : null,
        data: {
          ruleId: rule.id,
          rule: rule.name,
          severity: rule.severity,
          text,
          trigger: rule.trigger.type,
          seconds: ctx.seconds,
          event: ctx.event?.data ?? null,
        },
      })
      if (!sent) errors.push(t.t('notify.rule.webhookMissing', { id }))
    }
    for (const doorId of rule.actions.openDoorIds) {
      const door = this.deps.controllers.door(doorId)
      const controller = door && this.deps.controllers.get(door.controllerId)
      if (!door || !door.active || !controller?.enabled) {
        errors.push(t.t('notify.rule.doorMissing', { id: doorId }))
        continue
      }
      this.openedByRule.set(door.id, Date.now())
      try {
        await this.deps.gateway.run(
          { id: null, username: `rule:${rule.name}` },
          controller.id,
          'open-door',
          { door: door.door, name: door.name, source: 'rule', ruleId: rule.id },
          (client, target) => client.openDoor(target, door.door),
        )
      } catch (err) {
        errors.push(t.t('notify.rule.openFailed', { door: door.name, error: t.error(err) }))
      }
    }
    const at = localDateTime()
    this.repo.addRun(rule.id, at, text, errors)
    this.deps.gateway.hub.publishRule({ ruleId: rule.id, name: rule.name, severity: rule.severity, text, at })
    if (errors.length > 0) this.logger?.warn?.(`rule "${rule.name}": ${errors.join('; ')}`)
  }
}
