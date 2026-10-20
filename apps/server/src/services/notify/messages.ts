import {
  ALARM_REASONS,
  translateError,
  translator,
  type DeniedBurstDto,
  type EventDto,
  type Language,
  type UnusualAccessDto,
  type WebhookEvent,
} from '@uhppote-desk/shared'
import { localDateTime } from '../../util/time.js'
import type { IntegrationEvent } from '../integrationEvents.js'

/** A line of a message: plain text, or a section heading. */
export type Line = string | { heading: string }

/** Channel-independent message; each channel renders it in its own format. */
export interface NotifyMessage {
  emoji: string
  title: string
  lines: Line[]
  /** 1 (min) … 5 (urgent), as in ntfy. */
  priority: 1 | 2 | 3 | 4 | 5
  /** ntfy tags (emoji short codes). */
  tags: string[]
  /** Door that a Telegram "open" button may open. */
  door: { id: number; name: string } | null
}

const STYLE: Record<WebhookEvent, { emoji: string; priority: NotifyMessage['priority']; tag: string }> = {
  'access.granted': { emoji: '✅', priority: 2, tag: 'white_check_mark' },
  'access.denied': { emoji: '🚫', priority: 4, tag: 'no_entry' },
  'door.event': { emoji: '🚪', priority: 3, tag: 'door' },
  alarm: { emoji: '🚨', priority: 5, tag: 'rotating_light' },
  'door.opened': { emoji: '🔓', priority: 3, tag: 'unlock' },
  'door.closed': { emoji: '🔒', priority: 2, tag: 'lock' },
  'controller.offline': { emoji: '🔴', priority: 4, tag: 'red_circle' },
  'controller.online': { emoji: '🟢', priority: 3, tag: 'green_circle' },
  'anomaly.unusual_time': { emoji: '🕒', priority: 4, tag: 'clock3' },
  'anomaly.repeated_denied': { emoji: '⛔', priority: 4, tag: 'no_entry_sign' },
  'guest.opened': { emoji: '🎫', priority: 3, tag: 'ticket' },
  'guest.refused': { emoji: '⚠️', priority: 4, tag: 'warning' },
}

/** Explanation of an unusual access: the usual window, a non-working day, or a night access. */
function unusualText(
  t: ReturnType<typeof translator>,
  u: Pick<UnusualAccessDto, 'kind' | 'usualFrom' | 'usualTo'>,
): string {
  if (u.kind === 'hour') return t.t('notify.anomaly.usualHours', { from: u.usualFrom ?? '?', to: u.usualTo ?? '?' })
  if (u.kind === 'day') return t.t('notify.anomaly.nonWorkingDay')
  return t.t('notify.anomaly.night')
}

/** 'HH:mm:ss', with the date when it is not today. */
function when(timestamp: string | null): string {
  const ts = timestamp ?? localDateTime()
  const today = localDateTime().slice(0, 10)
  return ts.startsWith(today) ? ts.slice(11, 19) : ts.slice(0, 16)
}

function who(t: ReturnType<typeof translator>, e: Pick<EventDto, 'personName' | 'card'>): string | null {
  if (e.personName) return e.card ? `${e.personName} (${t.t('notify.card', { card: e.card })})` : e.personName
  return e.card ? t.t('notify.unknownCard', { card: e.card }) : null
}

export function eventMessage(ev: IntegrationEvent, lang: Language): NotifyMessage {
  const t = translator(lang)
  const style = STYLE[ev.type]
  const place = ev.door?.name ?? ev.controller.name
  const lines: Line[] = []
  const e = ev.event
  if (e) {
    const person = who(t, e)
    if (person) lines.push(person)
    lines.push(`${when(e.timestamp)} · ${t.reason(e.reason)}`)
    if (ev.type === 'anomaly.unusual_time') lines.push(unusualText(t, ev.data as unknown as UnusualAccessDto))
    if (ev.type === 'anomaly.repeated_denied')
      lines.push(t.t('notify.anomaly.repeated', { n: Number(ev.data.count), minutes: Number(ev.data.windowMinutes) }))
  } else if (ev.type === 'guest.opened' || ev.type === 'guest.refused') {
    lines.push(t.t('notify.guest', { name: String(ev.data.guestName) }))
    const outcome = `${when(String(ev.data.timestamp))} · ${t.t(`codes.guestOutcome.${String(ev.data.outcome)}`)}`
    lines.push(outcome)
  } else if (ev.type === 'controller.offline') {
    if (ev.state?.lastSeenAt) lines.push(t.t('notify.lastSeen', { time: when(ev.state.lastSeenAt) }))
    if (ev.state?.lastError) lines.push(translateError(lang, ev.state.lastErrorInfo ?? ev.state.lastError))
  } else {
    lines.push(when(null))
  }
  return {
    emoji: style.emoji,
    title: `${t.t(`notify.title.${ev.type.replace('.', '_')}`)} — ${place}`,
    lines,
    priority: style.priority,
    tags: [style.tag],
    door: ev.door ? { id: ev.door.id, name: ev.door.name } : null,
  }
}

export function testMessage(lang: Language): NotifyMessage {
  const t = translator(lang)
  return {
    emoji: '🔔',
    title: t.t('notify.testTitle'),
    lines: [t.t('notify.testBody')],
    priority: 3,
    tags: ['bell'],
    door: null,
  }
}

// --- daily report -----------------------------------------------------------

export interface ReportInput {
  from: string
  to: string
  /** Events of the period (already limited to the channel doors), newest first. */
  events: EventDto[]
  /** Names of the controllers offline now. */
  offline: string[]
  unusual: UnusualAccessDto[]
  bursts: DeniedBurstDto[]
}

const MAX_ITEMS = 25

function limited(t: ReturnType<typeof translator>, items: string[]): string[] {
  if (items.length <= MAX_ITEMS) return items
  return [...items.slice(0, MAX_ITEMS), t.t('notify.report.more', { n: items.length - MAX_ITEMS })]
}

export function reportMessage(r: ReportInput, lang: Language): NotifyMessage {
  const t = translator(lang)
  const chronological = [...r.events].reverse()
  const time = (e: EventDto) => (e.timestamp ?? '').slice(11, 16)
  const place = (e: EventDto) => e.doorName ?? e.controllerName

  // who came in: granted swipes, grouped by person (or by card when unassigned)
  const people = new Map<string, { name: string; first: string; last: string; doors: Set<string> }>()
  for (const e of chronological.filter((x) => x.type === 1 && x.granted)) {
    const key = e.personId ? `p${e.personId}` : `c${e.card}`
    const name = e.personName ?? t.t('notify.unknownCard', { card: e.card })
    const p = people.get(key) ?? { name, first: time(e), last: time(e), doors: new Set<string>() }
    p.last = time(e)
    p.doors.add(place(e))
    people.set(key, p)
  }
  const denied = chronological.filter((x) => x.type === 1 && !x.granted)
  const alarms = chronological.filter((x) => ALARM_REASONS.has(x.reason))

  const lines: Line[] = [t.t('notify.report.period', { from: r.from.slice(0, 16), to: r.to.slice(0, 16) })]
  lines.push({ heading: t.t('notify.report.entries', { n: people.size }) })
  if (people.size === 0) lines.push(t.t('notify.report.noEntries'))
  else {
    const items = [...people.values()]
      .sort((a, b) => a.first.localeCompare(b.first))
      .map((p) => `• ${p.name} ${p.first === p.last ? p.first : `${p.first}–${p.last}`} (${[...p.doors].join(', ')})`)
    lines.push(...limited(t, items))
  }
  if (denied.length > 0) {
    lines.push({ heading: t.t('notify.report.denied', { n: denied.length }) })
    lines.push(
      ...limited(
        t,
        denied.map((e) => `• ${time(e)} ${place(e)} — ${who(t, e) ?? '?'}: ${t.reason(e.reason)}`),
      ),
    )
  }
  if (alarms.length > 0) {
    lines.push({ heading: t.t('notify.report.alarms', { n: alarms.length }) })
    lines.push(
      ...limited(
        t,
        alarms.map((e) => `• ${time(e)} ${place(e)} — ${t.reason(e.reason)}`),
      ),
    )
  }
  if (r.unusual.length > 0) {
    lines.push({ heading: t.t('notify.report.unusual', { n: r.unusual.length }) })
    lines.push(
      ...limited(
        t,
        r.unusual.map(
          (u) =>
            `• ${u.timestamp.slice(11, 16)} ${u.doorName ?? u.controllerName} — ${u.personName ?? '?'}: ${unusualText(t, u)}`,
        ),
      ),
    )
  }
  if (r.bursts.length > 0) {
    lines.push({ heading: t.t('notify.report.bursts', { n: r.bursts.length }) })
    lines.push(
      ...limited(
        t,
        r.bursts.map((b) => {
          const holder = b.personName
            ? `${b.personName} (${t.t('notify.card', { card: b.card ?? '?' })})`
            : b.card
              ? t.t('notify.unknownCard', { card: b.card })
              : '?'
          return `• ${b.first.slice(11, 16)}–${b.last.slice(11, 16)} ${b.doors.join(', ')} — ${holder}: ${t.t('notify.anomaly.attempts', { n: b.count })}`
        }),
      ),
    )
  }
  if (r.offline.length > 0) {
    lines.push({ heading: t.t('notify.report.offline', { n: r.offline.length }) })
    lines.push(...r.offline.map((name) => `• ${name}`))
  }
  const anomalies = denied.length + alarms.length + r.offline.length + r.unusual.length + r.bursts.length
  if (anomalies === 0) {
    lines.push({ heading: t.t('notify.report.anomalies') })
    lines.push(t.t('notify.report.noAnomalies'))
  }
  return {
    emoji: '📋',
    title: t.t('notify.report.title', { date: r.to.slice(0, 10) }),
    lines,
    priority: anomalies > 0 ? 3 : 2,
    tags: ['clipboard'],
    door: null,
  }
}

/** Plain-text rendering (email, ntfy, Gotify). */
export function plainText(m: NotifyMessage): string {
  return m.lines.map((l, i) => (typeof l === 'string' ? l : `${i > 0 ? '\n' : ''}${l.heading}`)).join('\n')
}
