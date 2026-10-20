import { createHash, randomBytes } from 'node:crypto'
import type {
  GuestOpenDto,
  GuestOutcome,
  GuestPassDto,
  GuestPassInput,
  GuestStatus,
  GuestViewDto,
} from '@uhppote-desk/shared'
import { HttpError } from '../auth/auth.js'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { fromBool, toBool, weekdaysFromString, weekdaysToString, type Db } from '../db/database.js'
import type { ControllerRepo } from '../db/repos.js'
import { localDateTime, parseLocal } from '../util/time.js'
import { inWindow, minuteOfDay } from './anomalies.js'
import type { IntegrationEvents } from './integrationEvents.js'

/** Wrong PINs in a row that lock a pass. */
export const MAX_WRONG_PINS = 5
/** Failed attempts (unknown links, wrong PINs) allowed per address within FAIL_WINDOW_MS. */
const MAX_FAILURES = 10
const FAIL_WINDOW_MS = 15 * 60_000

interface PassRow {
  id: number
  name: string
  note: string
  token_hash: string
  door_ids: string
  valid_from: string
  valid_to: string
  weekdays: string
  time_from: string | null
  time_to: string | null
  max_opens: number | null
  pin_hash: string | null
  bind_device: number
  device_hash: string | null
  bound_at: string | null
  failed_pins: number
  locked: number
  revoked_at: string | null
  created_by: string
  created_at: string
  opens: number
  last_open_at: string | null
}

const SELECT = `
  SELECT g.*,
         (SELECT COUNT(*) FROM guest_opens o WHERE o.pass_id = g.id AND o.outcome = 'ok') AS opens,
         (SELECT MAX(o.at) FROM guest_opens o WHERE o.pass_id = g.id AND o.outcome = 'ok') AS last_open_at
  FROM guest_passes g`

const hash = (s: string) => createHash('sha256').update(s).digest('hex')

/** A new secret for a link (128 bits) or for the device cookie. */
export const newGuestToken = () => randomBytes(16).toString('base64url')

type StatusInput = Pick<
  GuestPassDto,
  'validFrom' | 'validTo' | 'weekdays' | 'timeFrom' | 'timeTo' | 'maxOpens' | 'locked' | 'revokedAt' | 'opens'
>

/** Can the pass be used at `now` ('YYYY-MM-DD HH:mm:ss')? Otherwise the first reason why not. */
export function guestStatus(p: StatusInput, now = localDateTime()): GuestStatus {
  if (p.revokedAt) return 'revoked'
  const minute = now.slice(0, 16)
  if (minute >= p.validTo) return 'expired'
  if (p.maxOpens !== null && p.opens >= p.maxOpens) return 'used'
  if (p.locked) return 'locked'
  if (minute < p.validFrom) return 'notYet'
  if (!p.weekdays[(parseLocal(now).getDay() + 6) % 7]) return 'outsideHours'
  if (p.timeFrom && p.timeTo && !inWindow(minuteOfDay(now), minuteOfDay(p.timeFrom), minuteOfDay(p.timeTo)))
    return 'outsideHours'
  return 'active'
}

function map(r: PassRow): GuestPassDto {
  const dto: Omit<GuestPassDto, 'status'> = {
    id: r.id,
    name: r.name,
    note: r.note,
    doorIds: JSON.parse(r.door_ids) as number[],
    validFrom: r.valid_from,
    validTo: r.valid_to,
    weekdays: weekdaysFromString(r.weekdays),
    timeFrom: r.time_from,
    timeTo: r.time_to,
    maxOpens: r.max_opens,
    bindDevice: toBool(r.bind_device),
    hasPin: r.pin_hash !== null,
    boundAt: r.bound_at,
    locked: toBool(r.locked),
    revokedAt: r.revoked_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
    opens: r.opens,
    lastOpenAt: r.last_open_at,
  }
  return { ...dto, status: guestStatus(dto) }
}

/** The pass and door a guest may open now, after the checks of `authorize`. */
export interface GuestGrant {
  pass: GuestPassDto
  door: { id: number; name: string; controllerId: number; door: number }
}

/**
 * Guest passes: a secret link that opens some doors in a validity period (optionally only on some days and
 * hours), without a card or an app. Only the SHA-256 of a link is stored, like API tokens. A pass can be bound
 * to the first phone that uses it (a random cookie, also stored as a hash) and protected by a PIN.
 */
export class GuestService {
  /** Failed attempts per address: unknown links and wrong PINs. */
  private readonly failures = new Map<string, { count: number; since: number }>()

  constructor(
    private readonly db: Db,
    private readonly controllers: ControllerRepo,
    private readonly bus: IntegrationEvents,
  ) {}

  list(): GuestPassDto[] {
    return this.db.all<PassRow>(`${SELECT} ORDER BY g.revoked_at IS NOT NULL, g.valid_to DESC, g.id DESC`).map(map)
  }

  get(id: number): GuestPassDto | undefined {
    const r = this.db.get<PassRow>(`${SELECT} WHERE g.id = ?`, [id])
    return r && map(r)
  }

  async create(input: GuestPassInput, createdBy: string): Promise<{ pass: GuestPassDto; token: string }> {
    const token = newGuestToken()
    const id = this.db.run(
      `INSERT INTO guest_passes (name, note, token_hash, door_ids, valid_from, valid_to, weekdays, time_from, time_to,
         max_opens, pin_hash, bind_device, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.note,
        hash(token),
        JSON.stringify(input.doorIds),
        input.validFrom,
        input.validTo,
        weekdaysToString(input.weekdays),
        input.timeFrom,
        input.timeTo,
        input.maxOpens,
        input.pin ? await hashPassword(input.pin) : null,
        fromBool(input.bindDevice),
        createdBy,
      ],
    ).lastInsertRowid
    return { pass: this.get(id)!, token }
  }

  /** Updates the settings; the link stays the same. A changed PIN also unlocks the pass. */
  async update(id: number, input: GuestPassInput): Promise<void> {
    this.db.run(
      `UPDATE guest_passes SET name = ?, note = ?, door_ids = ?, valid_from = ?, valid_to = ?, weekdays = ?,
         time_from = ?, time_to = ?, max_opens = ?, bind_device = ? WHERE id = ?`,
      [
        input.name,
        input.note,
        JSON.stringify(input.doorIds),
        input.validFrom,
        input.validTo,
        weekdaysToString(input.weekdays),
        input.timeFrom,
        input.timeTo,
        input.maxOpens,
        fromBool(input.bindDevice),
        id,
      ],
    )
    if (input.pin !== undefined) {
      this.db.run('UPDATE guest_passes SET pin_hash = ?, failed_pins = 0, locked = 0 WHERE id = ?', [
        input.pin ? await hashPassword(input.pin) : null,
        id,
      ])
    }
  }

  /** A new link: the old one stops working and the pass is no longer bound to a phone. */
  newLink(id: number): string {
    const token = newGuestToken()
    this.db.run('UPDATE guest_passes SET token_hash = ?, device_hash = NULL, bound_at = NULL WHERE id = ?', [
      hash(token),
      id,
    ])
    return token
  }

  /** Lets the link be used from another phone (the next one that opens a door) and clears a PIN lock. */
  unbind(id: number): void {
    this.db.run(
      'UPDATE guest_passes SET device_hash = NULL, bound_at = NULL, failed_pins = 0, locked = 0 WHERE id = ?',
      [id],
    )
  }

  revoke(id: number): void {
    this.db.run('UPDATE guest_passes SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [localDateTime(), id])
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM guest_passes WHERE id = ?', [id]).changes > 0
  }

  opens(id: number, limit = 200): GuestOpenDto[] {
    return this.db
      .all<{
        id: number
        at: string
        door_id: number | null
        door_name: string | null
        outcome: GuestOutcome
        ip: string | null
      }>('SELECT * FROM guest_opens WHERE pass_id = ? ORDER BY id DESC LIMIT ?', [id, limit])
      .map((r) => ({ id: r.id, at: r.at, doorId: r.door_id, doorName: r.door_name, outcome: r.outcome, ip: r.ip }))
  }

  // --- the guest side -------------------------------------------------------------------------------

  /** Doors of the pass that still exist and are usable. */
  private doors(p: GuestPassDto): GuestGrant['door'][] {
    return p.doorIds.flatMap((id) => {
      const d = this.controllers.door(id)
      const c = d && this.controllers.get(d.controllerId)
      return d?.active && c?.enabled ? [{ id: d.id, name: d.name, controllerId: d.controllerId, door: d.door }] : []
    })
  }

  private assertNotBlocked(ip: string): void {
    const f = this.failures.get(ip)
    if (f && Date.now() - f.since < FAIL_WINDOW_MS && f.count >= MAX_FAILURES)
      throw new HttpError(429, 'tooManyAttempts')
  }

  private fail(ip: string): void {
    const now = Date.now()
    const f = this.failures.get(ip)
    if (!f || now - f.since >= FAIL_WINDOW_MS) this.failures.set(ip, { count: 1, since: now })
    else f.count++
    // keep the map small: forget the addresses whose window is over
    if (this.failures.size > 1000)
      for (const [k, v] of this.failures) if (now - v.since >= FAIL_WINDOW_MS) this.failures.delete(k)
  }

  /** The pass of a link (unknown links count as failed attempts of the address). */
  private resolve(token: string, ip: string): { pass: GuestPassDto; row: PassRow } {
    this.assertNotBlocked(ip)
    const row = this.db.get<PassRow>(`${SELECT} WHERE g.token_hash = ?`, [hash(token)])
    if (!row) {
      this.fail(ip)
      throw new HttpError(404, 'guestNotFound')
    }
    return { pass: map(row), row }
  }

  /** Is the device the one the pass is bound to (or may it still bind it)? */
  private deviceMatches(row: PassRow, deviceSecret: string | undefined): 'bound' | 'free' | 'other' {
    if (!toBool(row.bind_device) || row.device_hash === null) return 'free'
    return deviceSecret && hash(deviceSecret) === row.device_hash ? 'bound' : 'other'
  }

  /** The link page: who the pass is for, the doors, the validity, and whether a PIN is needed here. */
  view(token: string, deviceSecret: string | undefined, ip: string): GuestViewDto {
    const { pass, row } = this.resolve(token, ip)
    const device = this.deviceMatches(row, deviceSecret)
    return {
      name: pass.name,
      doors: this.doors(pass).map((d) => ({ id: d.id, name: d.name })),
      validFrom: pass.validFrom,
      validTo: pass.validTo,
      weekdays: pass.weekdays,
      timeFrom: pass.timeFrom,
      timeTo: pass.timeTo,
      opensLeft: pass.maxOpens === null ? null : Math.max(0, pass.maxOpens - pass.opens),
      status: pass.status,
      pinRequired: pass.hasPin && device !== 'bound',
      otherDevice: device === 'other',
    }
  }

  /**
   * Checks that the link may open the door now from this device, with this PIN; binds the pass to the device
   * at its first use. Refused attempts are recorded and published as `guest.refused`.
   */
  async authorize(
    token: string,
    doorId: number,
    deviceSecret: string,
    pin: string | undefined,
    ip: string,
  ): Promise<GuestGrant> {
    const { pass, row } = this.resolve(token, ip)
    const door = this.doors(pass).find((d) => d.id === doorId)
    if (!door) throw new HttpError(404, 'doorNotFound')
    const refuse = (outcome: Exclude<GuestOutcome, 'ok' | 'error'>, status: number, code: string, params = {}) => {
      this.record(pass, door, outcome, ip)
      return new HttpError(status, code, params)
    }
    if (pass.status !== 'active') throw refuse(pass.status, 403, `guestStatus.${pass.status}`)
    const device = this.deviceMatches(row, deviceSecret)
    if (device === 'other') throw refuse('otherDevice', 403, 'guestOtherDevice')
    if (row.pin_hash && device !== 'bound') {
      if (!pin) throw new HttpError(403, 'guestPinRequired')
      if (!(await verifyPassword(pin, row.pin_hash))) {
        this.fail(ip)
        const failed = row.failed_pins + 1
        const locked = failed >= MAX_WRONG_PINS
        this.db.run('UPDATE guest_passes SET failed_pins = ?, locked = ? WHERE id = ?', [
          failed,
          fromBool(locked),
          pass.id,
        ])
        if (locked) throw refuse('locked', 403, 'guestStatus.locked')
        throw refuse('wrongPin', 403, 'guestWrongPin', { left: MAX_WRONG_PINS - failed })
      }
      if (row.failed_pins > 0) this.db.run('UPDATE guest_passes SET failed_pins = 0 WHERE id = ?', [pass.id])
    }
    if (toBool(row.bind_device) && row.device_hash === null) {
      this.db.run('UPDATE guest_passes SET device_hash = ?, bound_at = ? WHERE id = ?', [
        hash(deviceSecret),
        localDateTime(),
        pass.id,
      ])
    }
    return { pass, door }
  }

  /** Records an attempt; refused ones and successful openings also reach the integrations. */
  record(pass: GuestPassDto, door: GuestGrant['door'], outcome: GuestOutcome, ip: string): void {
    this.db.run('INSERT INTO guest_opens (pass_id, door_id, door_name, outcome, ip) VALUES (?, ?, ?, ?, ?)', [
      pass.id,
      door.id,
      door.name,
      outcome,
      ip,
    ])
    if (outcome === 'error') return
    this.bus.publishGuest(outcome === 'ok' ? 'guest.opened' : 'guest.refused', door.controllerId, door.door, {
      passId: pass.id,
      guestName: pass.name,
      outcome,
      createdBy: pass.createdBy,
      timestamp: localDateTime(),
    })
  }
}
