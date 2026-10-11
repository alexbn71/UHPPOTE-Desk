const p = (n: number) => String(n).padStart(2, '0')

/** 'YYYY-MM-DD HH:mm:ss' in ora locale. */
export function localDateTime(d = new Date()): string {
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 'YYYY-MM-DD' in ora locale. */
export function localDate(d = new Date()): string {
  return localDateTime(d).slice(0, 10)
}

/** Interpreta 'YYYY-MM-DD HH:mm:ss' come ora locale. */
export function parseLocal(s: string): Date {
  const [date, time = '00:00:00'] = s.split(' ')
  const [y, m, d] = date!.split('-').map(Number)
  const [hh, mm, ss = 0] = time.split(':').map(Number)
  return new Date(y!, m! - 1, d!, hh, mm, ss)
}

export function addDays(date: string, days: number): string {
  const d = parseLocal(date)
  d.setDate(d.getDate() + days)
  return localDate(d)
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h! * 60 + m!
}
