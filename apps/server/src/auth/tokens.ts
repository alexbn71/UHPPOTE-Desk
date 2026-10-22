import { createHash, randomBytes } from 'node:crypto'
import type { ApiTokenDto, Role, TokenAccess } from '@uhppote-desk/shared'
import { fromBool, toBool, type Db } from '../db/database.js'
import { localDate, localDateTime } from '../util/time.js'
import type { SessionUser } from './auth.js'

/** Prefix of every token: makes them recognisable (e.g. by secret scanners). */
export const TOKEN_PREFIX = 'uhd_'
/** Minimum interval between two writes of the "last used" columns of the same token. */
const LAST_USED_WRITE_MS = 60_000

export type ApiTokenInput = Pick<ApiTokenDto, 'name' | 'access' | 'zoneIds' | 'doorIds' | 'expiresAt' | 'active'>

interface TokenRow {
  id: number
  name: string
  token_hash: string
  prefix: string
  access: TokenAccess
  zone_ids: string
  door_ids: string
  expires_at: string | null
  active: number
  created_at: string
  created_by: string | null
  last_used_at: string | null
  last_used_ip: string | null
}

const ROLE: Record<TokenAccess, Role> = { read: 'viewer', doors: 'viewer', operator: 'operator', admin: 'admin' }

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

const mapToken = (r: TokenRow): ApiTokenDto => ({
  id: r.id,
  name: r.name,
  prefix: r.prefix,
  access: r.access,
  zoneIds: JSON.parse(r.zone_ids) as number[],
  doorIds: JSON.parse(r.door_ids) as number[],
  expiresAt: r.expires_at,
  active: toBool(r.active),
  createdAt: r.created_at,
  createdBy: r.created_by,
  lastUsedAt: r.last_used_at,
  lastUsedIp: r.last_used_ip,
})

/**
 * API tokens for machine-to-machine access (`Authorization: Bearer uhd_…`).
 * Only the SHA-256 of a token is stored: the token is shown once, when it is created.
 */
export class ApiTokenService {
  private readonly lastWrite = new Map<number, number>()

  constructor(private readonly db: Db) {}

  list(): ApiTokenDto[] {
    return this.db.all<TokenRow>('SELECT * FROM api_tokens ORDER BY name, id').map(mapToken)
  }

  get(id: number): ApiTokenDto | undefined {
    const r = this.db.get<TokenRow>('SELECT * FROM api_tokens WHERE id = ?', [id])
    return r && mapToken(r)
  }

  /** Creates a token; the returned `token` cannot be read again later. */
  create(t: ApiTokenInput, createdBy: string): { token: string; apiToken: ApiTokenDto } {
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
    const id = this.db.run(
      'INSERT INTO api_tokens (name, token_hash, prefix, access, zone_ids, door_ids, expires_at, active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        t.name,
        hash(token),
        token.slice(0, TOKEN_PREFIX.length + 6),
        t.access,
        JSON.stringify(t.zoneIds),
        JSON.stringify(t.doorIds),
        t.expiresAt,
        fromBool(t.active),
        createdBy,
      ],
    ).lastInsertRowid
    return { token, apiToken: this.get(id)! }
  }

  update(id: number, t: ApiTokenInput): boolean {
    return (
      this.db.run(
        'UPDATE api_tokens SET name = ?, access = ?, zone_ids = ?, door_ids = ?, expires_at = ?, active = ? WHERE id = ?',
        [t.name, t.access, JSON.stringify(t.zoneIds), JSON.stringify(t.doorIds), t.expiresAt, fromBool(t.active), id],
      ).changes > 0
    )
  }

  delete(id: number): boolean {
    this.lastWrite.delete(id)
    return this.db.run('DELETE FROM api_tokens WHERE id = ?', [id]).changes > 0
  }

  /** The principal of a valid token (active, not expired), or null. */
  resolve(token: string, ip: string): SessionUser | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null
    const r = this.db.get<TokenRow>('SELECT * FROM api_tokens WHERE token_hash = ? AND active = 1', [hash(token)])
    if (!r || (r.expires_at !== null && r.expires_at < localDate())) return null
    const now = Date.now()
    if (now - (this.lastWrite.get(r.id) ?? 0) >= LAST_USED_WRITE_MS || r.last_used_ip !== ip) {
      this.lastWrite.set(r.id, now)
      this.db.run('UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?', [localDateTime(), ip, r.id])
    }
    const t = mapToken(r)
    return {
      id: null,
      tokenId: t.id,
      deviceId: null,
      username: `token:${t.name}`,
      displayName: t.name,
      role: ROLE[t.access],
      mustChangePassword: false,
      passwordManaged: true,
      totpEnabled: false,
      mustSetupTotp: false,
      totpBypass: false,
      zoneIds: t.zoneIds,
      doorIds: t.doorIds,
      canOpenDoors: t.access !== 'read',
    }
  }
}
