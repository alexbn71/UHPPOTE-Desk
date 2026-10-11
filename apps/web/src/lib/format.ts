/** 'YYYY-MM-DD HH:mm:ss' → 'GG/MM/AAAA HH:mm:ss' */
export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  const [d, t = ''] = s.split(/[ T]/)
  const [y, m, day] = d!.split('-')
  return `${day}/${m}/${y} ${t.slice(0, 8)}`.trim()
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const [y, m, d] = s.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
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
