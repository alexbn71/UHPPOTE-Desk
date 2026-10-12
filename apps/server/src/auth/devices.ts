import { createHash, randomBytes } from 'node:crypto'
import type { DeviceDto, MobileSettings } from '@uhppote-desk/shared'
import type { Db } from '../db/database.js'
import { addDays, localDateTime } from '../util/time.js'

export const DEVICE_COOKIE = 'uhd_device'
/** Minimum interval between two writes of the "last used" columns of a device. */
const LAST_USED_WRITE_MS = 60_000

interface DeviceRow {
  id: number
  operator_id: number
  operator_name: string
  name: string
  created_at: string
  last_used_at: string | null
  last_ip: string | null
  biometric: number
  push: number
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex')

const SELECT = `
  SELECT d.id, d.operator_id, o.username AS operator_name, d.name, d.created_at, d.last_used_at, d.last_ip,
         EXISTS (SELECT 1 FROM webauthn_credentials w WHERE w.device_id = d.id) AS biometric,
         EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.device_id = d.id) AS push
  FROM devices d JOIN operators o ON o.id = d.operator_id`

/**
 * Remembered devices (mobile app): a long-lived cookie per device instead of a 12-hour session.
 * Devices with fingerprint/Face ID never expire; the others last the configured number of days from the login.
 */
export class DeviceService {
  private readonly lastWrite = new Map<number, number>()

  constructor(
    private readonly db: Db,
    private readonly settings: () => MobileSettings,
  ) {}

  /** Expiry of a device: null = never (fingerprint/Face ID registered). */
  private expiresAt(r: Pick<DeviceRow, 'created_at' | 'biometric'>): string | null {
    if (r.biometric) return null
    return `${addDays(r.created_at.slice(0, 10), this.settings().sessionDays)}${r.created_at.slice(10)}`
  }

  private map(r: DeviceRow): DeviceDto {
    return {
      id: r.id,
      operatorId: r.operator_id,
      operatorName: r.operator_name,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      lastIp: r.last_ip,
      biometric: !!r.biometric,
      push: !!r.push,
      expiresAt: this.expiresAt(r),
    }
  }

  /** Creates a device for the operator; the returned token goes in the device cookie only. */
  create(operatorId: number, name: string, ip: string): { token: string; deviceId: number } {
    const token = randomBytes(32).toString('base64url')
    const deviceId = this.db.run(
      'INSERT INTO devices (operator_id, token_hash, name, last_used_at, last_ip) VALUES (?, ?, ?, ?, ?)',
      [operatorId, hash(token), name || 'Device', localDateTime(), ip],
    ).lastInsertRowid
    return { token, deviceId }
  }

  /** Operator and device of a valid (not expired) device token. */
  resolve(token: string | undefined, ip: string): { operatorId: number; deviceId: number } | null {
    if (!token) return null
    const r = this.db.get<DeviceRow>(`${SELECT} WHERE d.token_hash = ? AND o.active = 1`, [hash(token)])
    if (!r) return null
    const expires = this.expiresAt(r)
    if (expires !== null && expires <= localDateTime()) return null
    const now = Date.now()
    if (now - (this.lastWrite.get(r.id) ?? 0) >= LAST_USED_WRITE_MS || r.last_ip !== ip) {
      this.lastWrite.set(r.id, now)
      this.db.run('UPDATE devices SET last_used_at = ?, last_ip = ? WHERE id = ?', [localDateTime(), ip, r.id])
    }
    return { operatorId: r.operator_id, deviceId: r.id }
  }

  get(id: number): DeviceDto | undefined {
    const r = this.db.get<DeviceRow>(`${SELECT} WHERE d.id = ?`, [id])
    return r && this.map(r)
  }

  list(): DeviceDto[] {
    return this.db.all<DeviceRow>(`${SELECT} ORDER BY o.username, d.created_at DESC`).map((r) => this.map(r))
  }

  revoke(id: number): boolean {
    this.lastWrite.delete(id)
    return this.db.run('DELETE FROM devices WHERE id = ?', [id]).changes > 0
  }

  /** Revokes every device of an operator except one (e.g. after a password change). */
  revokeAll(operatorId: number, except: number | null = null): void {
    this.db.run('DELETE FROM devices WHERE operator_id = ? AND id <> ?', [operatorId, except ?? 0])
  }
}
