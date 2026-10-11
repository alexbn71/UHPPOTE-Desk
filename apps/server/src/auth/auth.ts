import { randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { OperatorDto, Role } from '@uhppote-desk/shared'
import type { Db } from '../db/database.js'
import { toBool } from '../db/database.js'
import { hashPassword, randomPassword, verifyPassword } from './password.js'

export const SESSION_COOKIE = 'uhd_session'

interface OperatorRow {
  id: number
  username: string
  display_name: string
  password_hash: string
  role: Role
  active: number
  must_change_password: number
  last_login_at: string | null
}

export interface SessionUser {
  id: number
  username: string
  displayName: string
  role: Role
  mustChangePassword: boolean
  /** Zone consentite; vuoto = tutte. */
  zoneIds: number[]
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null
  }
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

export function hasRole(user: SessionUser | null, role: Role): boolean {
  return !!user && ROLE_RANK[user.role] >= ROLE_RANK[role]
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message)
  }
}

function localNow(offsetMs = 0): string {
  const d = new Date(Date.now() + offsetMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly sessionHours: number,
  ) {}

  /** Crea l'utente admin se non esiste alcun operatore. Restituisce la password generata (se generata). */
  async bootstrap(initialPassword: string | null): Promise<{ created: boolean; password?: string }> {
    const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM operators')!.n
    if (count > 0) return { created: false }
    const password = initialPassword ?? randomPassword()
    this.db.run(
      `INSERT INTO operators (username, display_name, password_hash, role, must_change_password) VALUES ('admin', 'Amministratore', ?, 'admin', 1)`,
      [await hashPassword(password)],
    )
    return initialPassword ? { created: true } : { created: true, password }
  }

  async login(username: string, password: string, ip: string, userAgent: string): Promise<{ sessionId: string; user: SessionUser } | null> {
    const row = this.db.get<OperatorRow>('SELECT * FROM operators WHERE username = ? AND active = 1', [username])
    // verifica comunque una password per non rivelare l'esistenza dell'utente tramite i tempi di risposta
    const ok = await verifyPassword(password, row?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
    if (!row || !ok) return null
    const sessionId = randomBytes(32).toString('base64url')
    this.db.run('INSERT INTO sessions (id, operator_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)', [
      sessionId,
      row.id,
      localNow(),
      localNow(this.sessionHours * 3600_000),
      ip,
      userAgent.slice(0, 300),
    ])
    this.db.run('UPDATE operators SET last_login_at = ? WHERE id = ?', [localNow(), row.id])
    return { sessionId, user: this.toSessionUser(row) }
  }

  logout(sessionId: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId])
  }

  resolve(sessionId: string | undefined): SessionUser | null {
    if (!sessionId) return null
    const row = this.db.get<OperatorRow>(
      `SELECT o.* FROM sessions s JOIN operators o ON o.id = s.operator_id
       WHERE s.id = ? AND s.expires_at > ? AND o.active = 1`,
      [sessionId, localNow()],
    )
    return row ? this.toSessionUser(row) : null
  }

  purgeExpired(): number {
    return this.db.run('DELETE FROM sessions WHERE expires_at <= ?', [localNow()]).changes
  }

  async changePassword(operatorId: number, current: string, next: string): Promise<boolean> {
    const row = this.db.get<OperatorRow>('SELECT * FROM operators WHERE id = ?', [operatorId])
    if (!row || !(await verifyPassword(current, row.password_hash))) return false
    await this.setPassword(operatorId, next, false)
    return true
  }

  async setPassword(operatorId: number, password: string, mustChange: boolean): Promise<void> {
    this.db.run('UPDATE operators SET password_hash = ?, must_change_password = ? WHERE id = ?', [
      await hashPassword(password),
      mustChange ? 1 : 0,
      operatorId,
    ])
  }

  /** Invalida tutte le sessioni di un operatore tranne quella indicata. */
  revokeSessions(operatorId: number, except?: string): void {
    this.db.run('DELETE FROM sessions WHERE operator_id = ? AND id <> ?', [operatorId, except ?? ''])
  }

  private toSessionUser(row: OperatorRow): SessionUser {
    const zones = this.db.all<{ zone_id: number }>('SELECT zone_id FROM operator_zones WHERE operator_id = ?', [row.id])
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      mustChangePassword: toBool(row.must_change_password),
      zoneIds: zones.map((z) => z.zone_id),
    }
  }

  listOperators(): OperatorDto[] {
    return this.db.all<OperatorRow>('SELECT * FROM operators ORDER BY username').map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      active: toBool(r.active),
      mustChangePassword: toBool(r.must_change_password),
      zoneIds: this.db.all<{ zone_id: number }>('SELECT zone_id FROM operator_zones WHERE operator_id = ?', [r.id]).map((z) => z.zone_id),
      lastLoginAt: r.last_login_at,
    }))
  }
}

/** preHandler: richiede un ruolo minimo. */
export function requireRole(role: Role) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw new HttpError(401, 'Autenticazione richiesta')
    if (req.user.mustChangePassword && !req.url.startsWith('/api/auth/')) {
      throw new HttpError(403, 'È necessario cambiare la password prima di continuare')
    }
    if (!hasRole(req.user, role)) throw new HttpError(403, 'Permessi insufficienti')
  }
}
