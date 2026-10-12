import { SECRET_MASK, type Language, type NotificationChannelDto, type NotificationConfig, type WebhookEvent } from '@uhppote-desk/shared'
import { fromBool, toBool, type Db } from './database.js'

export type NotificationInput = Pick<NotificationChannelDto, 'name' | 'enabled' | 'events' | 'doorIds' | 'language' | 'dailyReport' | 'reportHour' | 'config'>

/** A channel with its real secrets (server side only). */
export type NotificationChannel = NotificationChannelDto

interface ChannelRow {
  id: number
  name: string
  type: string
  enabled: number
  events: string
  door_ids: string
  language: string
  config: string
  daily_report: number
  report_hour: number
  last_report_date: string | null
  last_sent_at: string | null
  last_error: string | null
  created_at: string
}

/** Fields of each channel type that hold credentials. */
const SECRET_FIELDS: Record<NotificationConfig['type'], string[]> = {
  telegram: ['botToken'],
  email: ['password'],
  ntfy: ['token', 'password'],
  gotify: ['appToken'],
}

const mapChannel = (r: ChannelRow): NotificationChannel => ({
  id: r.id,
  name: r.name,
  enabled: toBool(r.enabled),
  events: JSON.parse(r.events) as WebhookEvent[],
  doorIds: JSON.parse(r.door_ids) as number[],
  language: r.language as Language,
  dailyReport: toBool(r.daily_report),
  reportHour: r.report_hour,
  config: JSON.parse(r.config) as NotificationConfig,
  createdAt: r.created_at,
  lastSentAt: r.last_sent_at,
  lastError: r.last_error,
  lastReportDate: r.last_report_date,
})

/** Copy of the channel for the API: credentials replaced by SECRET_MASK (empty ones stay empty). */
export function maskChannel(c: NotificationChannel): NotificationChannelDto {
  const config = { ...c.config } as Record<string, unknown>
  for (const f of SECRET_FIELDS[c.config.type]) if (config[f]) config[f] = SECRET_MASK
  return { ...c, config: config as NotificationConfig }
}

/** Puts back the stored credentials where the client sent SECRET_MASK (same channel type only). */
function unmask(next: NotificationConfig, prev: NotificationConfig | undefined): NotificationConfig {
  const config = { ...next } as Record<string, unknown>
  const old = prev as Record<string, unknown> | undefined
  for (const f of SECRET_FIELDS[next.type]) {
    if (config[f] === SECRET_MASK) config[f] = prev?.type === next.type ? (old?.[f] ?? '') : ''
  }
  return config as NotificationConfig
}

export class NotificationRepo {
  constructor(private readonly db: Db) {}

  list(): NotificationChannel[] {
    return this.db.all<ChannelRow>('SELECT * FROM notification_channels ORDER BY name, id').map(mapChannel)
  }

  get(id: number): NotificationChannel | undefined {
    const r = this.db.get<ChannelRow>('SELECT * FROM notification_channels WHERE id = ?', [id])
    return r && mapChannel(r)
  }

  create(n: NotificationInput): number {
    return this.db.run(
      'INSERT INTO notification_channels (name, type, enabled, events, door_ids, language, config, daily_report, report_hour) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [n.name, n.config.type, fromBool(n.enabled), JSON.stringify(n.events), JSON.stringify(n.doorIds), n.language, JSON.stringify(unmask(n.config, undefined)), fromBool(n.dailyReport), n.reportHour],
    ).lastInsertRowid
  }

  update(id: number, n: NotificationInput): boolean {
    const prev = this.get(id)
    if (!prev) return false
    this.db.run(
      'UPDATE notification_channels SET name = ?, type = ?, enabled = ?, events = ?, door_ids = ?, language = ?, config = ?, daily_report = ?, report_hour = ? WHERE id = ?',
      [n.name, n.config.type, fromBool(n.enabled), JSON.stringify(n.events), JSON.stringify(n.doorIds), n.language, JSON.stringify(unmask(n.config, prev.config)), fromBool(n.dailyReport), n.reportHour, id],
    )
    return true
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM notification_channels WHERE id = ?', [id]).changes > 0
  }

  recordResult(id: number, at: string, error: string | null): void {
    this.db.run('UPDATE notification_channels SET last_sent_at = ?, last_error = ? WHERE id = ?', [at, error, id])
  }

  setReportDate(id: number, date: string): void {
    this.db.run('UPDATE notification_channels SET last_report_date = ? WHERE id = ?', [date, id])
  }
}
