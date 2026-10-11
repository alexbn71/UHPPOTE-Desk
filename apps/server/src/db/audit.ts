import type { Db } from './database.js'
import type { SessionUser } from '../auth/auth.js'

export interface AuditEntry {
  id: number
  at: string
  operatorId: number | null
  operatorName: string | null
  action: string
  target: string | null
  details: unknown
  outcome: 'ok' | 'error'
  error: string | null
}

export class AuditLog {
  constructor(private readonly db: Db) {}

  log(
    user: Pick<SessionUser, 'id' | 'username'> | null,
    action: string,
    target: string | null,
    details?: unknown,
    error?: Error | string | null,
  ): void {
    this.db.run(
      'INSERT INTO audit_log (operator_id, operator_name, action, target, details, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        user?.id ?? null,
        user?.username ?? 'sistema',
        action,
        target,
        details === undefined ? null : JSON.stringify(details),
        error ? 'error' : 'ok',
        error ? (typeof error === 'string' ? error : error.message) : null,
      ],
    )
  }

  /** Runs an operation and records its outcome in the audit log. */
  async track<T>(
    user: Pick<SessionUser, 'id' | 'username'> | null,
    action: string,
    target: string | null,
    details: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await fn()
      this.log(user, action, target, details)
      return result
    } catch (err) {
      this.log(user, action, target, details, err as Error)
      throw err
    }
  }

  query(opts: { limit: number; offset: number; action?: string | undefined; operatorId?: number | undefined }): { rows: AuditEntry[]; total: number } {
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.action) {
      where.push('action LIKE ?')
      params.push(`${opts.action}%`)
    }
    if (opts.operatorId) {
      where.push('operator_id = ?')
      params.push(opts.operatorId)
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM audit_log ${w}`, params)!.n
    const rows = this.db
      .all<{
        id: number
        at: string
        operator_id: number | null
        operator_name: string | null
        action: string
        target: string | null
        details: string | null
        outcome: 'ok' | 'error'
        error: string | null
      }>(`SELECT * FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, opts.limit, opts.offset])
      .map((r) => ({
        id: r.id,
        at: r.at,
        operatorId: r.operator_id,
        operatorName: r.operator_name,
        action: r.action,
        target: r.target,
        details: r.details ? JSON.parse(r.details) : null,
        outcome: r.outcome,
        error: r.error,
      }))
    return { rows, total }
  }
}
