import {
  anomalySettingsSchema,
  type AnomalySettings,
  type DeniedBurstDto,
  type EventDto,
  type InactiveCardDto,
  type UnusualAccessDto,
  type UnusualKind,
} from '@uhppote-desk/shared'
import type { Db } from '../db/database.js'
import { toBool } from '../db/database.js'
import type { EventRepo } from '../db/repos.js'
import { addDays, localDate, localDateTime, parseLocal } from '../util/time.js'

const SETTINGS_KEY = 'anomalies'
const DAY_MINUTES = 1440
/** Most events analysed by one query (a period with more is cut). */
const MAX_EVENTS = 20_000

// --- pure detection rules (unit tested) -----------------------------------------------------------

/** Minutes since midnight of 'YYYY-MM-DD HH:mm[:ss]' or 'HH:mm'. */
export function minuteOfDay(ts: string): number {
  const time = ts.length > 5 ? ts.slice(11, 16) : ts
  const [h, m] = time.split(':').map(Number)
  return (h! % 24) * 60 + m!
}

export const formatMinute = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** Distance between two times of day, across midnight. */
export function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % DAY_MINUTES
  return Math.min(d, DAY_MINUTES - d)
}

/** True if the minute is in the window [start, end), which may cross midnight. */
export function inWindow(m: number, start: number, end: number): boolean {
  return start <= end ? m >= start && m < end : m >= start || m < end
}

/** 5th–95th percentile of the times (people working across midnight get a wide window, which is only informative). */
export function usualWindow(minutes: number[]): [number, number] {
  const s = [...minutes].sort((a, b) => a - b)
  const at = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!
  return [at(0.05), at(0.95)]
}

export interface Baseline {
  /** Times of day of the person's past accesses. */
  minutes: number[]
  /** How many of them were on non-working days. */
  nonWorking: number
}

/** Why an access at `minute` is unusual for a person with this baseline, or null if it is not. */
export function classifyAccess(
  minute: number,
  nonWorkingDay: boolean,
  b: Baseline,
  s: AnomalySettings,
): UnusualKind | null {
  if (b.minutes.length >= s.minSamples) {
    if (nonWorkingDay && b.nonWorking === 0) return 'day'
    const nearest = Math.min(...b.minutes.map((x) => circularDistance(minute, x)))
    return nearest > s.toleranceMinutes ? 'hour' : null
  }
  return inWindow(minute, minuteOfDay(s.nightStart), minuteOfDay(s.nightEnd)) ? 'night' : null
}

/**
 * Bursts of denied attempts: at least `count` events of the same key within `windowMinutes`.
 * Events must be sorted by time; overlapping or close windows are merged into one burst.
 */
export function findBursts<T extends { timestamp: string | null }>(
  events: T[],
  key: (e: T) => string,
  count: number,
  windowMinutes: number,
): T[][] {
  const byKey = new Map<string, T[]>()
  for (const e of events) {
    if (!e.timestamp) continue
    const k = key(e)
    byKey.set(k, [...(byKey.get(k) ?? []), e])
  }
  const windowMs = windowMinutes * 60_000
  const bursts: T[][] = []
  for (const list of byKey.values()) {
    const t = list.map((e) => parseLocal(e.timestamp!).getTime())
    const marked = new Array<boolean>(list.length).fill(false)
    let j = 0
    for (let i = 0; i < list.length; i++) {
      if (j < i) j = i
      while (j + 1 < list.length && t[j + 1]! - t[i]! <= windowMs) j++
      if (j - i + 1 >= count) for (let k = i; k <= j; k++) marked[k] = true
    }
    let current: T[] = []
    let lastT = 0
    for (let i = 0; i < list.length; i++) {
      if (!marked[i]) continue
      if (current.length > 0 && t[i]! - lastT > windowMs) {
        bursts.push(current)
        current = []
      }
      current.push(list[i]!)
      lastT = t[i]!
    }
    if (current.length > 0) bursts.push(current)
  }
  return bursts.sort((a, b) => a[0]!.timestamp!.localeCompare(b[0]!.timestamp!))
}

const burstKey = (e: EventDto) => (e.card > 0 ? `c${e.card}` : `d${e.controllerId}:${e.door}`)
const isWeekend = (date: string) => [0, 6].includes(parseLocal(date).getDay())

// --- service --------------------------------------------------------------------------------------

/** Anomaly detection on the event history, and the checks run on every new event. */
export class AnomalyService {
  constructor(
    private readonly db: Db,
    private readonly events: EventRepo,
  ) {}

  settings(): AnomalySettings {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SETTINGS_KEY])
    const parsed = anomalySettingsSchema.safeParse(row ? JSON.parse(row.value) : {})
    return parsed.success ? parsed.data : anomalySettingsSchema.parse({})
  }

  saveSettings(s: AnomalySettings): void {
    this.db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [SETTINGS_KEY, JSON.stringify(s)],
    )
  }

  private nonWorkingDays(from: string, to: string): (date: string) => boolean {
    const holidays = new Set(
      this.db
        .all<{ date: string }>('SELECT date FROM holidays WHERE date BETWEEN ? AND ?', [
          from.slice(0, 10),
          to.slice(0, 10),
        ])
        .map((h) => h.date),
    )
    return (date) => isWeekend(date) || holidays.has(date)
  }

  /** Granted accesses of each person in [from, to): their habits. */
  private baselines(personIds: number[], from: string, to: string): Map<number, Baseline> {
    const out = new Map<number, Baseline>()
    if (personIds.length === 0) return out
    const rows = this.db.all<{ person_id: number; timestamp: string }>(
      `SELECT person_id, timestamp FROM events
       WHERE type = 1 AND granted = 1 AND person_id IN (${personIds.map(() => '?').join(',')}) AND timestamp >= ? AND timestamp < ?`,
      [...personIds, from, to],
    )
    const nonWorking = this.nonWorkingDays(from, to)
    for (const r of rows) {
      const b = out.get(r.person_id) ?? { minutes: [], nonWorking: 0 }
      b.minutes.push(minuteOfDay(r.timestamp))
      if (nonWorking(r.timestamp.slice(0, 10))) b.nonWorking++
      out.set(r.person_id, b)
    }
    return out
  }

  private unusual(e: EventDto, b: Baseline, nonWorkingDay: boolean, s: AnomalySettings): UnusualAccessDto | null {
    const kind = classifyAccess(minuteOfDay(e.timestamp!), nonWorkingDay, b, s)
    if (!kind) return null
    const known = b.minutes.length >= s.minSamples
    const [lo, hi] = known ? usualWindow(b.minutes) : [0, 0]
    return {
      eventId: e.id,
      personId: e.personId!,
      personName: e.personName,
      timestamp: e.timestamp!,
      controllerId: e.controllerId,
      controllerName: e.controllerName,
      doorName: e.doorName,
      door: e.door,
      kind,
      usualFrom: known ? formatMinute(lo) : null,
      usualTo: known ? formatMinute(hi) : null,
      samples: b.minutes.length,
    }
  }

  /** Granted accesses in the period at unusual times for the person (habits: the `baselineDays` before the period). */
  unusualAccesses(from: string, to: string): UnusualAccessDto[] {
    const s = this.settings()
    const accesses = this.events
      .query({ from, to, type: 1, granted: true, limit: MAX_EVENTS, offset: 0 })
      .rows.filter((e) => e.personId !== null && e.timestamp)
      .reverse()
    const start = from.length === 10 ? `${from} 00:00:00` : from
    const baselines = this.baselines(
      [...new Set(accesses.map((e) => e.personId!))],
      `${addDays(start.slice(0, 10), -s.baselineDays)} 00:00:00`,
      start,
    )
    const nonWorking = this.nonWorkingDays(start, to.length === 10 ? `${to} 23:59:59` : to)
    return accesses
      .map((e) =>
        this.unusual(
          e,
          baselines.get(e.personId!) ?? { minutes: [], nonWorking: 0 },
          nonWorking(e.timestamp!.slice(0, 10)),
          s,
        ),
      )
      .filter((x): x is UnusualAccessDto => x !== null)
  }

  /** Bursts of denied attempts in the period. */
  deniedBursts(from: string, to: string): DeniedBurstDto[] {
    const s = this.settings()
    const denied = this.events.query({ from, to, type: 1, granted: false, limit: MAX_EVENTS, offset: 0 }).rows.reverse()
    return findBursts(denied, burstKey, s.deniedCount, s.deniedWindowMinutes).map((b) => ({
      card: b[0]!.card || null,
      personId: b[0]!.personId,
      personName: b[0]!.personName,
      doors: [...new Set(b.map((e) => e.doorName ?? `${e.controllerName} ${e.door}`))],
      doorRefs: [
        ...new Map(
          b.map((e) => [`${e.controllerId}:${e.door}`, { controllerId: e.controllerId, door: e.door }]),
        ).values(),
      ],
      count: b.length,
      first: b[0]!.timestamp!,
      last: b[b.length - 1]!.timestamp!,
      reasons: [...new Set(b.map((e) => e.reason))],
    }))
  }

  /** Active cards without a granted access for at least `inactiveDays` (never used: counted from their creation). */
  inactiveCards(now = new Date()): InactiveCardDto[] {
    const s = this.settings()
    const rows = this.db.all<{
      id: number
      number: number
      person_id: number | null
      person_name: string | null
      person_active: number | null
      created_at: string
      last_used: string | null
    }>(
      `SELECT c.id, c.number, c.person_id, TRIM(p.last_name || ' ' || p.first_name) AS person_name, p.active AS person_active, c.created_at,
              (SELECT MAX(e.timestamp) FROM events e WHERE e.card = c.number AND e.type = 1 AND e.granted = 1) AS last_used
       FROM cards c LEFT JOIN people p ON p.id = c.person_id
       WHERE c.status = 'active'`,
    )
    const today = parseLocal(localDate(now)).getTime()
    return rows
      .map((r) => {
        const since = r.last_used ?? r.created_at
        return {
          cardId: r.id,
          number: r.number,
          personId: r.person_id,
          personName: r.person_name,
          personActive: r.person_active === null ? null : toBool(r.person_active),
          lastUsedAt: r.last_used,
          createdAt: r.created_at,
          // rounded: days across a daylight saving change are 23 or 25 hours long
          daysInactive: Math.round((today - parseLocal(since.slice(0, 10)).getTime()) / 86_400_000),
        }
      })
      .filter((c) => c.daysInactive >= s.inactiveDays)
      .sort((a, b) => b.daysInactive - a.daysInactive)
  }

  // --- checks on new events (real time) -------------------------------------------------------

  /** Is this new granted access unusual for the person? (habits: the `baselineDays` before today) */
  checkAccess(e: EventDto): UnusualAccessDto | null {
    if (e.type !== 1 || !e.granted || e.personId === null || !e.timestamp) return null
    const s = this.settings()
    const day = e.timestamp.slice(0, 10)
    const b = this.baselines([e.personId], `${addDays(day, -s.baselineDays)} 00:00:00`, `${day} 00:00:00`).get(
      e.personId,
    ) ?? { minutes: [], nonWorking: 0 }
    return this.unusual(e, b, this.nonWorkingDays(day, day)(day), s)
  }

  /**
   * Does this new denied attempt complete a burst? Returns the number of attempts in the window
   * when it reaches the threshold exactly (one alert per burst), otherwise null.
   */
  checkDenied(e: EventDto): { count: number; windowMinutes: number } | null {
    if (e.type !== 1 || e.granted || !e.timestamp) return null
    const s = this.settings()
    const since = localDateTime(new Date(parseLocal(e.timestamp).getTime() - s.deniedWindowMinutes * 60_000))
    const where = e.card > 0 ? 'card = ?' : 'card = 0 AND controller_id = ? AND door = ?'
    const params = e.card > 0 ? [e.card] : [e.controllerId, e.door]
    const n = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events WHERE type = 1 AND granted = 0 AND ${where} AND timestamp >= ? AND timestamp <= ?`,
      [...params, since, e.timestamp],
    )!.n
    return n === s.deniedCount ? { count: n, windowMinutes: s.deniedWindowMinutes } : null
  }
}
