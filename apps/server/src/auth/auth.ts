import { randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { OperatorDto, Role } from '@uhppote-desk/shared'
import { translate } from '@uhppote-desk/shared'
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
  /** Operator id; null for an API token. */
  id: number | null
  /** API token id; null for an operator session. */
  tokenId: number | null
  /** Remembered device (mobile app) the request comes from; null for a normal session or a token. */
  deviceId: number | null
  username: string
  displayName: string
  role: Role
  mustChangePassword: boolean
  /** The password is set by the ADMIN_PASSWORD variable and cannot be changed from the application. */
  passwordManaged: boolean
  /** Allowed zones; empty = all. */
  zoneIds: number[]
  /** Doors that may be opened; empty = all (within the zones). */
  doorIds: number[]
  /** May open doors (operators and above; API tokens with the `doors` access level). */
  canOpenDoors: boolean
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

/**
 * HTTP error with a translatable code (key under `errors.*` in the shared translations).
 * The message is the English text; the client shows it in the user's language using `code` and `params`.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(translate('en', `errors.${code}`, params))
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

  /** Creates the admin user if no operator exists. Returns the generated password (if one was generated). */
  /** Username of the built-in administrator. */
  static readonly ADMIN = 'admin'

  /** True when the administrator password is set by the ADMIN_PASSWORD variable. */
  private adminPasswordManaged = false

  /**
   * Makes sure the administrator exists, at every start.
   * - With `adminPassword` (ADMIN_PASSWORD): the `admin` user is created if missing, its password is set to that
   *   value (also when the variable changes), no password change is requested, and it cannot be changed from the app.
   * - Without it: on the very first start (no operators) `admin` is created with a generated password that must be
   *   changed at first login; afterwards nothing happens.
   */
  async ensureAdmin(
    adminPassword: string | null,
  ): Promise<{ action: 'created-generated' | 'created-env' | 'updated-env' | 'unchanged'; password?: string }> {
    this.adminPasswordManaged = !!adminPassword
    const row = this.db.get<OperatorRow>('SELECT * FROM operators WHERE username = ?', [AuthService.ADMIN])
    if (adminPassword) {
      if (!row) {
        this.db.run(
          `INSERT INTO operators (username, display_name, password_hash, role, must_change_password) VALUES (?, 'Administrator', ?, 'admin', 0)`,
          [AuthService.ADMIN, await hashPassword(adminPassword)],
        )
        return { action: 'created-env' }
      }
      const samePassword = await verifyPassword(adminPassword, row.password_hash)
      if (samePassword && !toBool(row.must_change_password) && toBool(row.active) && row.role === 'admin')
        return { action: 'unchanged' }
      this.db.run(
        "UPDATE operators SET password_hash = ?, must_change_password = 0, active = 1, role = 'admin' WHERE id = ?",
        [samePassword ? row.password_hash : await hashPassword(adminPassword), row.id],
      )
      if (!samePassword) this.revokeSessions(row.id)
      return { action: 'updated-env' }
    }
    const count = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM operators')!.n
    if (count > 0) return { action: 'unchanged' }
    const password = randomPassword()
    this.db.run(
      `INSERT INTO operators (username, display_name, password_hash, role, must_change_password) VALUES (?, 'Administrator', ?, 'admin', 1)`,
      [AuthService.ADMIN, await hashPassword(password)],
    )
    return { action: 'created-generated', password }
  }

  /** Whether the password of the given operator is managed by ADMIN_PASSWORD. */
  isPasswordManaged(username: string): boolean {
    return this.adminPasswordManaged && username.toLowerCase() === AuthService.ADMIN
  }

  /** Throws if the password of the operator cannot be changed from the application. */
  assertPasswordChangeable(operatorId: number): void {
    const row = this.db.get<{ username: string }>('SELECT username FROM operators WHERE id = ?', [operatorId])
    if (row && this.isPasswordManaged(row.username)) throw new HttpError(400, 'passwordManagedByEnv')
  }

  /** Checks the credentials (and records the login); null if wrong. Creates no session. */
  async authenticate(username: string, password: string): Promise<SessionUser | null> {
    const row = this.db.get<OperatorRow>('SELECT * FROM operators WHERE username = ? AND active = 1', [username])
    // verify a password anyway, so that response times do not reveal whether the user exists
    const ok = await verifyPassword(
      password,
      row?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    )
    if (!row || !ok) return null
    this.db.run('UPDATE operators SET last_login_at = ? WHERE id = ?', [localNow(), row.id])
    return this.toSessionUser(row)
  }

  /** The user of a remembered device (active operators only). */
  deviceUser(operatorId: number, deviceId: number): SessionUser | null {
    const row = this.db.get<OperatorRow>('SELECT * FROM operators WHERE id = ? AND active = 1', [operatorId])
    return row ? { ...this.toSessionUser(row), deviceId } : null
  }

  async login(
    username: string,
    password: string,
    ip: string,
    userAgent: string,
  ): Promise<{ sessionId: string; user: SessionUser } | null> {
    const user = await this.authenticate(username, password)
    if (!user) return null
    return { sessionId: this.createSession(user.id!, ip, userAgent), user }
  }

  createSession(operatorId: number, ip: string, userAgent: string): string {
    const sessionId = randomBytes(32).toString('base64url')
    this.db.run(
      'INSERT INTO sessions (id, operator_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
      [sessionId, operatorId, localNow(), localNow(this.sessionHours * 3600_000), ip, userAgent.slice(0, 300)],
    )
    return sessionId
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

  /** Invalidates all sessions of an operator except the given one. */
  revokeSessions(operatorId: number, except?: string): void {
    this.db.run('DELETE FROM sessions WHERE operator_id = ? AND id <> ?', [operatorId, except ?? ''])
  }

  private toSessionUser(row: OperatorRow): SessionUser {
    const zones = this.db.all<{ zone_id: number }>('SELECT zone_id FROM operator_zones WHERE operator_id = ?', [row.id])
    return {
      id: row.id,
      tokenId: null,
      deviceId: null,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      mustChangePassword: toBool(row.must_change_password),
      passwordManaged: this.isPasswordManaged(row.username),
      zoneIds: zones.map((z) => z.zone_id),
      doorIds: [],
      canOpenDoors: ROLE_RANK[row.role] >= ROLE_RANK.operator,
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
      zoneIds: this.db
        .all<{ zone_id: number }>('SELECT zone_id FROM operator_zones WHERE operator_id = ?', [r.id])
        .map((z) => z.zone_id),
      lastLoginAt: r.last_login_at,
    }))
  }
}

/** preHandler: requires a minimum role and an operator session (API tokens are refused). */
export function requireSession(role: Role) {
  const check = requireRole(role)
  return async (req: FastifyRequest, reply: FastifyReply) => {
    await check(req, reply)
    if (req.user!.tokenId !== null) throw new HttpError(403, 'tokenNotAllowed')
  }
}

/** preHandler: requires a minimum role. */
export function requireRole(role: Role) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.user) throw new HttpError(401, 'unauthenticated')
    if (req.user.mustChangePassword && !req.url.startsWith('/api/auth/')) {
      throw new HttpError(403, 'mustChangePassword')
    }
    if (!hasRole(req.user, role)) throw new HttpError(403, 'forbidden')
  }
}
