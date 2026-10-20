import { errorInfo, type ErrorInfo } from '@uhppote-desk/shared'
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
  /** English text of the error. */
  error: string | null
  /** Translatable form of the error, when it has a code (controller errors). */
  errorInfo: ErrorInfo | null
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
    const info = error ? errorInfo(error) : null
    this.db.run(
      'INSERT INTO audit_log (operator_id, operator_name, action, target, details, outcome, error, error_info) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        user?.id ?? null,
        user?.username ?? 'sistema',
        action,
        target,
        details === undefined ? null : JSON.stringify(details),
        error ? 'error' : 'ok',
        error ? (typeof error === 'string' ? error : error.message) : null,
        info?.code ? JSON.stringify(info) : null,
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

  query(opts: { limit: number; offset: number; action?: string | undefined; operatorId?: number | undefined }): {
    rows: AuditEntry[]
    total: number
  } {
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
        error_info: string | null
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
        errorInfo: r.error_info ? (JSON.parse(r.error_info) as ErrorInfo) : null,
      }))
    return { rows, total }
  }
}
