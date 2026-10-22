import { randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { OperatorDto, Role, SecuritySettings } from '@uhppote-desk/shared'
import { securitySettingsSchema, translate } from '@uhppote-desk/shared'
import type { Db } from '../db/database.js'
import { toBool } from '../db/database.js'
import { hashPassword, randomPassword, verifyPassword } from './password.js'
import { generateRecoveryCode, generateSecret, hashRecoveryCode, otpauthUri, verifyTotp } from './totp.js'

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
  totp_secret: string | null
  totp_pending: string | null
  totp_last_step: number
}

/** Number of recovery codes generated when two-factor authentication is activated. */
export const RECOVERY_CODES = 10

/** Key of the security settings in the settings table. */
const SECURITY_KEY = 'security'

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
  /** Two-factor authentication (authenticator app) is active. */
  totpEnabled: boolean
  /** Two-factor authentication is mandatory for the role (security settings) and not active yet: set it up first. */
  mustSetupTotp: boolean
  /** Emergency access (ADMIN_2FA_BYPASS) applies to this user: an administrator, no second factor asked. */
  totpBypass: boolean
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
    /** ADMIN_2FA_BYPASS: administrators skip the second factor (emergency access). */
    private readonly admin2faBypass = false,
  ) {}

  /** Security settings, read once and kept in memory (they are checked at every request). */
  private security: SecuritySettings | null = null

  securitySettings(): SecuritySettings {
    if (!this.security) {
      const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SECURITY_KEY])
      const parsed = securitySettingsSchema.safeParse(row ? JSON.parse(row.value) : {})
      this.security = parsed.success ? parsed.data : securitySettingsSchema.parse({})
    }
    return this.security
  }

  saveSecuritySettings(s: SecuritySettings): void {
    this.db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [SECURITY_KEY, JSON.stringify(s)],
    )
    this.security = s
  }

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

  /**
   * Checks the credentials; null if wrong. Creates no session.
   * The login is recorded unless `record` is false (the second factor is still to be checked: see `recordLogin`).
   */
  async authenticate(username: string, password: string, record = true): Promise<SessionUser | null> {
    const row = this.db.get<OperatorRow>('SELECT * FROM operators WHERE username = ? AND active = 1', [username])
    // verify a password anyway, so that response times do not reveal whether the user exists
    const ok = await verifyPassword(
      password,
      row?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    )
    if (!row || !ok) return null
    if (record) this.recordLogin(row.id)
    return this.toSessionUser(row)
  }

  recordLogin(operatorId: number): void {
    this.db.run('UPDATE operators SET last_login_at = ? WHERE id = ?', [localNow(), operatorId])
  }

  /** Whether the password of the operator is the given one (sensitive operations ask it again). */
  async checkPassword(operatorId: number, password: string): Promise<boolean> {
    const row = this.db.get<OperatorRow>('SELECT * FROM operators WHERE id = ?', [operatorId])
    return !!row && (await verifyPassword(password, row.password_hash))
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

  // --- two-factor authentication (TOTP) ---------------------------------------

  /** Whether two-factor authentication is mandatory for the role (security settings). */
  totpRequiredFor(role: Role): boolean {
    const level = this.securitySettings().require2fa
    if (level === 'none') return false
    return ROLE_RANK[role] >= ROLE_RANK[level === 'all' ? 'viewer' : level]
  }

  /** Whether the operator has two-factor authentication active. */
  hasTotp(operatorId: number): boolean {
    return !!this.db.get<{ totp_secret: string | null }>('SELECT totp_secret FROM operators WHERE id = ?', [operatorId])
      ?.totp_secret
  }

  /**
   * Second factor of a login or of a sensitive operation: a code of the authenticator app or an unused recovery code
   * (which is then used up). Returns which one matched, or null.
   */
  verifySecondFactor(operatorId: number, code: string): 'totp' | 'recovery' | null {
    const row = this.db.get<OperatorRow>('SELECT * FROM operators WHERE id = ?', [operatorId])
    if (!row?.totp_secret) return null
    const step = verifyTotp(row.totp_secret, code, row.totp_last_step)
    if (step !== null) {
      this.db.run('UPDATE operators SET totp_last_step = ? WHERE id = ?', [step, operatorId])
      return 'totp'
    }
    const used = this.db.run(
      'UPDATE operator_recovery_codes SET used_at = ? WHERE operator_id = ? AND code_hash = ? AND used_at IS NULL',
      [localNow(), operatorId, hashRecoveryCode(code)],
    )
    return used.changes > 0 ? 'recovery' : null
  }

  /** Starts the setup: a new secret, kept aside until it is confirmed with a code of the app. */
  beginTotpSetup(operatorId: number, issuer: string): { secret: string; uri: string } {
    const row = this.db.get<OperatorRow>('SELECT * FROM operators WHERE id = ?', [operatorId])
    if (!row) throw new HttpError(404, 'notFound')
    if (row.totp_secret) throw new HttpError(400, 'totpAlreadyEnabled')
    const secret = generateSecret()
    this.db.run('UPDATE operators SET totp_pending = ? WHERE id = ?', [secret, operatorId])
    return { secret, uri: otpauthUri(secret, row.username, issuer) }
  }

  /** Confirms the setup with a code of the app: activates it and returns the new recovery codes; null if wrong. */
  confirmTotpSetup(operatorId: number, code: string): string[] | null {
    const row = this.db.get<OperatorRow>('SELECT * FROM operators WHERE id = ?', [operatorId])
    if (!row?.totp_pending) throw new HttpError(400, 'totpNoSetup')
    const step = verifyTotp(row.totp_pending, code)
    if (step === null) return null
    return this.db.tx(() => {
      this.db.run(
        'UPDATE operators SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ?, totp_enabled_at = ? WHERE id = ?',
        [step, localNow(), operatorId],
      )
      return this.replaceRecoveryCodes(operatorId)
    })
  }

  /** New recovery codes (the old ones stop working). */
  replaceRecoveryCodes(operatorId: number): string[] {
    const codes = Array.from({ length: RECOVERY_CODES }, generateRecoveryCode)
    this.db.tx(() => {
      this.db.run('DELETE FROM operator_recovery_codes WHERE operator_id = ?', [operatorId])
      for (const c of codes)
        this.db.run('INSERT INTO operator_recovery_codes (operator_id, code_hash) VALUES (?, ?)', [
          operatorId,
          hashRecoveryCode(c),
        ])
    })
    return codes
  }

  /** Recovery codes still usable. */
  recoveryCodesLeft(operatorId: number): number {
    return this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM operator_recovery_codes WHERE operator_id = ? AND used_at IS NULL',
      [operatorId],
    )!.n
  }

  /** Turns two-factor authentication off and forgets the secret and the recovery codes. */
  disableTotp(operatorId: number): void {
    this.db.tx(() => {
      this.db.run(
        'UPDATE operators SET totp_secret = NULL, totp_pending = NULL, totp_last_step = 0, totp_enabled_at = NULL WHERE id = ?',
        [operatorId],
      )
      this.db.run('DELETE FROM operator_recovery_codes WHERE operator_id = ?', [operatorId])
    })
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
      totpEnabled: !!row.totp_secret,
      mustSetupTotp: !row.totp_secret && this.totpRequiredFor(row.role),
      totpBypass: this.admin2faBypass && row.role === 'admin',
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
      totpEnabled: !!r.totp_secret,
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
    if (req.user.mustSetupTotp && !req.url.startsWith('/api/auth/')) {
      throw new HttpError(403, 'mustSetupTotp')
    }
    if (!hasRole(req.user, role)) throw new HttpError(403, 'forbidden')
  }
}
