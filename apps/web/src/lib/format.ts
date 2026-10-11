import i18n from '../i18n'

const locale = () => i18n.resolvedLanguage ?? 'en'

function parseLocal(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0))
}

/** 'YYYY-MM-DD HH:mm:ss' (controller local time) → localised date and time. */
export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  const d = parseLocal(s)
  if (!d) return s
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'short', timeStyle: 'medium' }).format(d)
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const d = parseLocal(s.slice(0, 10))
  if (!d) return s
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'short' }).format(d)
}

export function fmtMinutes(m: number): string {
  const sign = m < 0 ? '-' : ''
  const a = Math.abs(m)
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}

export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y!, m! - 1, d! + days)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

export function cardLabel(n: number): string {
  const facility = Math.floor(n / 100000)
  const num = n % 100000
  return `${n} (${facility},${num})`
}

/** Mantine DateInput display format for the current language (dayjs localized format). */
export const DATE_INPUT_FORMAT = 'L'
