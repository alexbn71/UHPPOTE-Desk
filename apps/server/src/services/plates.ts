import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '@uhppote-desk/protocol'
import {
  plateMatchKey,
  plateReadings,
  type PlateDto,
  type PlateOutcome,
  type PlateReadDto,
  type PlateReaderDto,
  type PlateReaderInput,
} from '@uhppote-desk/shared'
import { HttpError } from '../auth/auth.js'
import { fromBool, toBool, type Db } from '../db/database.js'
import type { ControllerRepo, ScheduleRepo, TimeProfileRecord } from '../db/repos.js'
import type { ControllerGateway } from '../gateway/gateway.js'
import { localDate, localDateTime, parseLocal } from '../util/time.js'
import type { GuestService } from './guests.js'
import type { IntegrationEvents } from './integrationEvents.js'

/** Prefix of the reader keys, to recognise them. */
export const READER_KEY_PREFIX = 'uhp_'
/** Wrong reader keys allowed per address within FAIL_WINDOW_MS. */
const MAX_FAILURES = 10
const FAIL_WINDOW_MS = 15 * 60_000
const SNAPSHOT_TIMEOUT_MS = 4000
const MAX_PHOTO_BYTES = 5 * 1024 * 1024

const hash = (s: string) => createHash('sha256').update(s).digest('hex')

// --- time profiles --------------------------------------------------------------------------------------

/**
 * Does the time profile allow an access at `now` ('YYYY-MM-DD HH:mm:ss')? As the controller does: within the
 * validity dates, on an enabled weekday, inside one of the segments (both ends included); otherwise the linked
 * profile is checked. A missing profile allows nothing.
 */
export function profileAllows(profiles: TimeProfileRecord[], id: number, now: string): boolean {
  const date = now.slice(0, 10)
  const hhmm = now.slice(11, 16)
  const weekday = (parseLocal(now).getDay() + 6) % 7
  const seen = new Set<number>()
  let p = profiles.find((x) => x.id === id)
  while (p && !seen.has(p.id)) {
    seen.add(p.id)
    if (
      date >= p.validFrom &&
      date <= p.validTo &&
      p.weekdays[weekday] &&
      p.segments.some((s) => s.start !== s.end && hhmm >= s.start && hhmm <= s.end)
    )
      return true
    const linked = p.linkedTo
    p = linked ? profiles.find((x) => x.id === linked) : undefined
  }
  return false
}

// --- rows -----------------------------------------------------------------------------------------------

interface ReaderRow {
  id: number
  name: string
  door_id: number
  key_hash: string
  key_prefix: string
  snapshot_url: string
  debounce_seconds: number
  open_door: number
  enabled: number
  last_read_at: string | null
  created_at: string
}

const mapReader = (r: ReaderRow): PlateReaderDto => ({
  id: r.id,
  name: r.name,
  doorId: r.door_id,
  keyPrefix: r.key_prefix,
  snapshotUrl: r.snapshot_url,
  debounceSeconds: r.debounce_seconds,
  openDoor: toBool(r.open_door),
  enabled: toBool(r.enabled),
  lastReadAt: r.last_read_at,
  createdAt: r.created_at,
})

interface PlateRow {
  id: number
  plate: string
  person_id: number | null
  person_name: string | null
  guest_pass_id: number | null
  guest_name: string | null
  note: string
  created_at: string
}

const PLATE_SELECT = `
  SELECT pl.id, pl.plate, pl.person_id, TRIM(pe.last_name || ' ' || pe.first_name) AS person_name,
         pl.guest_pass_id, g.name AS guest_name, pl.note, pl.created_at
  FROM plates pl
  LEFT JOIN people pe ON pe.id = pl.person_id
  LEFT JOIN guest_passes g ON g.id = pl.guest_pass_id`

const mapPlate = (r: PlateRow): PlateDto => ({
  id: r.id,
  plate: r.plate,
  personId: r.person_id,
  personName: r.person_name,
  guestPassId: r.guest_pass_id,
  guestName: r.guest_name,
  note: r.note,
  createdAt: r.created_at,
})

interface ReadRow {
  id: number
  at: string
  reader_id: number | null
  reader_name: string
  door_id: number | null
  door_name: string | null
  raw: string
  plate: string
  plate_id: number | null
  person_id: number | null
  guest_pass_id: number | null
  owner_name: string | null
  outcome: PlateOutcome
  opened: number
  photo: string | null
}

const mapRead = (r: ReadRow): PlateReadDto => ({
  id: r.id,
  at: r.at,
  readerId: r.reader_id,
  readerName: r.reader_name,
  doorId: r.door_id,
  doorName: r.door_name,
  raw: r.raw,
  plate: r.plate,
  plateId: r.plate_id,
  personId: r.person_id,
  guestPassId: r.guest_pass_id,
  ownerName: r.owner_name,
  outcome: r.outcome,
  opened: toBool(r.opened),
  hasPhoto: r.photo !== null,
})

/** The decision on one plate owner. */
interface Decision {
  plateId: number
  plate: string
  personId: number | null
  guestPassId: number | null
  ownerName: string
  outcome: PlateOutcome
}

export interface PlateReadResult {
  outcome: PlateOutcome
  opened: boolean
  plate: string | null
  /** The reading was ignored: the camera already opened the door a few seconds ago, or the same plate was refused. */
  ignored: boolean
}

/**
 * Licence plates: people and guest passes own plates; plate readers (cameras with plate recognition, e.g. AgentDVR)
 * send what they read with their secret key. An authorised plate opens the reader's door: a person needs a
 * permission on that door, within its time profile; a guest needs an active pass for that door. Every reading is
 * recorded with a photo from the camera and published as `plate.granted` / `plate.denied`.
 */
export class PlateService {
  /** When each reader last opened its door (debounce). */
  private readonly lastOpen = new Map<number, number>()
  /** When a plate was last refused at a reader, by `${readerId}:${matchKey}` (no flood of identical refusals). */
  private readonly lastRefused = new Map<string, number>()
  private readonly failures = new Map<string, { count: number; since: number }>()
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly db: Db,
    private readonly deps: {
      controllers: ControllerRepo
      schedule: ScheduleRepo
      gateway: ControllerGateway
      guests: GuestService
      bus: IntegrationEvents
    },
    private readonly opts: { photoDir: string; photoDays: number; logger?: Logger },
  ) {}

  // --- plates -------------------------------------------------------------------------------------------

  plates(filter: { personId?: number | undefined } = {}): PlateDto[] {
    return filter.personId
      ? this.db
          .all<PlateRow>(`${PLATE_SELECT} WHERE pl.person_id = ? ORDER BY pl.plate`, [filter.personId])
          .map(mapPlate)
      : this.db.all<PlateRow>(`${PLATE_SELECT} ORDER BY pl.plate, pl.id`).map(mapPlate)
  }

  plate(id: number): PlateDto | undefined {
    const r = this.db.get<PlateRow>(`${PLATE_SELECT} WHERE pl.id = ?`, [id])
    return r && mapPlate(r)
  }

  addPlate(personId: number, plate: string, note: string): PlateDto {
    if (this.db.get('SELECT 1 FROM plates WHERE person_id = ? AND match_key = ?', [personId, plateMatchKey(plate)]))
      throw new HttpError(409, 'duplicate')
    const id = this.db.run('INSERT INTO plates (plate, match_key, person_id, note) VALUES (?, ?, ?, ?)', [
      plate,
      plateMatchKey(plate),
      personId,
      note,
    ]).lastInsertRowid
    return this.plate(id)!
  }

  deletePlate(id: number): boolean {
    return this.db.run('DELETE FROM plates WHERE id = ?', [id]).changes > 0
  }

  /**
   * The plates a reader should know (AgentDVR raises "plate recognised" only for plates in its list): those of
   * active people and of guest passes not expired or revoked. Whether one may enter now is decided at reading time.
   */
  knownPlates(): string[] {
    const now = localDateTime().slice(0, 16)
    return this.db
      .all<{ plate: string }>(
        `SELECT DISTINCT pl.plate FROM plates pl
         LEFT JOIN people pe ON pe.id = pl.person_id
         LEFT JOIN guest_passes g ON g.id = pl.guest_pass_id
         WHERE (pe.active = 1 AND pe.valid_to >= ?) OR (g.revoked_at IS NULL AND g.valid_to > ?)
         ORDER BY pl.plate`,
        [localDate(), now],
      )
      .map((r) => r.plate)
  }

  // --- readers ------------------------------------------------------------------------------------------

  readers(): PlateReaderDto[] {
    return this.db.all<ReaderRow>('SELECT * FROM plate_readers ORDER BY name, id').map(mapReader)
  }

  reader(id: number): PlateReaderDto | undefined {
    const r = this.db.get<ReaderRow>('SELECT * FROM plate_readers WHERE id = ?', [id])
    return r && mapReader(r)
  }

  private newKey(): { key: string; hash: string; prefix: string } {
    const key = READER_KEY_PREFIX + randomBytes(24).toString('base64url')
    return { key, hash: hash(key), prefix: key.slice(0, READER_KEY_PREFIX.length + 6) }
  }

  createReader(input: PlateReaderInput): { reader: PlateReaderDto; key: string } {
    const k = this.newKey()
    const id = this.db.run(
      `INSERT INTO plate_readers (name, door_id, key_hash, key_prefix, snapshot_url, debounce_seconds, open_door, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.doorId,
        k.hash,
        k.prefix,
        input.snapshotUrl,
        input.debounceSeconds,
        fromBool(input.openDoor),
        fromBool(input.enabled),
      ],
    ).lastInsertRowid
    return { reader: this.reader(id)!, key: k.key }
  }

  updateReader(id: number, input: PlateReaderInput): void {
    this.db.run(
      `UPDATE plate_readers SET name = ?, door_id = ?, snapshot_url = ?, debounce_seconds = ?, open_door = ?, enabled = ?
       WHERE id = ?`,
      [
        input.name,
        input.doorId,
        input.snapshotUrl,
        input.debounceSeconds,
        fromBool(input.openDoor),
        fromBool(input.enabled),
        id,
      ],
    )
  }

  /** A new key: the URLs configured in the camera software must be updated. */
  newReaderKey(id: number): string {
    const k = this.newKey()
    this.db.run('UPDATE plate_readers SET key_hash = ?, key_prefix = ? WHERE id = ?', [k.hash, k.prefix, id])
    return k.key
  }

  deleteReader(id: number): boolean {
    this.lastOpen.delete(id)
    return this.db.run('DELETE FROM plate_readers WHERE id = ?', [id]).changes > 0
  }

  /** The enabled reader of a key; wrong keys count as failed attempts of the address. */
  readerByKey(key: string | undefined, ip: string): ReaderRow {
    const f = this.failures.get(ip)
    const now = Date.now()
    if (f && now - f.since < FAIL_WINDOW_MS && f.count >= MAX_FAILURES) throw new HttpError(429, 'tooManyAttempts')
    const r = key?.startsWith(READER_KEY_PREFIX)
      ? this.db.get<ReaderRow>('SELECT * FROM plate_readers WHERE key_hash = ? AND enabled = 1', [hash(key)])
      : undefined
    if (!r) {
      if (!f || now - f.since >= FAIL_WINDOW_MS) this.failures.set(ip, { count: 1, since: now })
      else f.count++
      throw new HttpError(403, 'invalidReaderKey')
    }
    return r
  }

  // --- readings -----------------------------------------------------------------------------------------

  reads(q: {
    from?: string | undefined
    to?: string | undefined
    outcome?: 'granted' | 'denied' | undefined
    search?: string | undefined
    readerId?: number | undefined
    limit: number
    offset: number
  }): { rows: PlateReadDto[]; total: number } {
    const where: string[] = []
    const params: (string | number)[] = []
    if (q.from) {
      where.push('at >= ?')
      params.push(q.from)
    }
    if (q.to) {
      where.push('at <= ?')
      params.push(q.to)
    }
    if (q.outcome === 'granted') where.push("outcome = 'granted'")
    if (q.outcome === 'denied') where.push("outcome <> 'granted'")
    if (q.readerId) {
      where.push('reader_id = ?')
      params.push(q.readerId)
    }
    if (q.search) {
      where.push('(plate LIKE ? OR owner_name LIKE ?)')
      params.push(`%${q.search.toUpperCase().replace(/[^A-Z0-9]/g, '')}%`, `%${q.search}%`)
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM plate_reads ${w}`, params)!.n
    const rows = this.db
      .all<ReadRow>(`SELECT * FROM plate_reads ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, q.limit, q.offset])
      .map(mapRead)
    return { rows, total }
  }

  /** The photo of a reading (JPEG), if it was taken and is still kept. */
  photo(readId: number): Buffer | null {
    const r = this.db.get<{ photo: string | null }>('SELECT photo FROM plate_reads WHERE id = ?', [readId])
    if (!r?.photo) return null
    try {
      return fs.readFileSync(path.join(this.opts.photoDir, r.photo))
    } catch {
      return null
    }
  }

  /** May this owner pass the door now? */
  private decide(
    owner: { id: number; plate: string; person_id: number | null; guest_pass_id: number | null },
    doorId: number,
    now: string,
  ): Decision | null {
    const base = { plateId: owner.id, plate: owner.plate, personId: owner.person_id, guestPassId: owner.guest_pass_id }
    if (owner.person_id !== null) {
      const p = this.db.get<{ name: string; active: number; valid_from: string; valid_to: string }>(
        "SELECT TRIM(last_name || ' ' || first_name) AS name, active, valid_from, valid_to FROM people WHERE id = ?",
        [owner.person_id],
      )
      if (!p) return null
      const today = now.slice(0, 10)
      const decision = (outcome: PlateOutcome): Decision => ({ ...base, ownerName: p.name, outcome })
      if (!toBool(p.active) || today < p.valid_from || today > p.valid_to) return decision('personInactive')
      const perm = this.db.get<{ profile_id: number | null }>(
        'SELECT profile_id FROM permissions WHERE person_id = ? AND door_id = ?',
        [owner.person_id, doorId],
      )
      if (!perm) return decision('noPermission')
      // no profile (or profile 1, the controller's "always") = at any time
      if (perm.profile_id !== null && perm.profile_id !== 1)
        if (!profileAllows(this.deps.schedule.profiles(), perm.profile_id, now)) return decision('outsideProfile')
      return decision('granted')
    }
    const pass = owner.guest_pass_id !== null ? this.deps.guests.get(owner.guest_pass_id) : undefined
    if (!pass) return null
    const decision = (outcome: PlateOutcome): Decision => ({ ...base, ownerName: pass.name, outcome })
    if (!pass.doorIds.includes(doorId)) return decision('noPermission')
    return decision(pass.status === 'active' ? 'granted' : pass.status)
  }

  /**
   * A reading from a camera: finds the owners of the plates read, opens the door when one may pass, records the
   * reading with a photo and publishes it. Readings right after an opening, and repeated refusals of the same
   * plate, are ignored (the car is still in front of the camera).
   */
  async read(key: string | undefined, raw: string, ip: string): Promise<PlateReadResult> {
    const reader = this.readerByKey(key, ip)
    const now = localDateTime()
    this.db.run('UPDATE plate_readers SET last_read_at = ? WHERE id = ?', [now, reader.id])
    const readings = plateReadings(raw)
    if (readings.length === 0) return { outcome: 'unknown', opened: false, plate: null, ignored: true }
    const debounceMs = reader.debounce_seconds * 1000
    if (Date.now() - (this.lastOpen.get(reader.id) ?? 0) < debounceMs)
      return { outcome: 'granted', opened: false, plate: readings[0]!, ignored: true }

    const door = this.deps.controllers.door(reader.door_id)
    // every owner of every plate read: a person first, then guests, the first that may pass wins
    const decisions: Decision[] = []
    for (const plate of readings) {
      const owners = this.db.all<{ id: number; plate: string; person_id: number | null; guest_pass_id: number | null }>(
        'SELECT id, plate, person_id, guest_pass_id FROM plates WHERE match_key = ? ORDER BY person_id IS NULL, id DESC',
        [plateMatchKey(plate)],
      )
      for (const o of owners) {
        const d = this.decide(o, reader.door_id, now)
        if (d) decisions.push(d)
      }
    }
    const best = decisions.find((d) => d.outcome === 'granted') ?? decisions[0]
    const outcome: PlateOutcome = best?.outcome ?? 'unknown'
    const plate = best?.plate ?? readings[0]!

    if (outcome !== 'granted') {
      const k = `${reader.id}:${plateMatchKey(plate)}`
      if (Date.now() - (this.lastRefused.get(k) ?? 0) < Math.max(debounceMs, 10_000))
        return { outcome, opened: false, plate, ignored: true }
      this.lastRefused.set(k, Date.now())
    }

    const open = outcome === 'granted' && toBool(reader.open_door) && !!door
    if (open) this.lastOpen.set(reader.id, Date.now())
    const [opening, photo] = await Promise.all([
      open
        ? this.deps.gateway
            .run(
              { id: null, username: `plate:${reader.name}` },
              door.controllerId,
              'plate-open-door',
              { door: door.door, name: door.name, plate, owner: best?.ownerName },
              (client, t) => client.openDoor(t, door.door),
            )
            .then(() => null)
            .catch((err: Error) => err)
        : Promise.resolve(null),
      this.snapshot(reader.snapshot_url),
    ])
    const failed = opening !== null
    if (failed) this.lastOpen.delete(reader.id) // the next reading may try again
    const finalOutcome: PlateOutcome = failed ? 'error' : outcome
    const opened = open && !failed

    const id = this.db.run(
      `INSERT INTO plate_reads (at, reader_id, reader_name, door_id, door_name, raw, plate, plate_id, person_id,
         guest_pass_id, owner_name, outcome, opened) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        now,
        reader.id,
        reader.name,
        door?.id ?? null,
        door?.name ?? null,
        raw.slice(0, 500),
        plate,
        best?.plateId ?? null,
        best?.personId ?? null,
        best?.guestPassId ?? null,
        best?.ownerName ?? null,
        finalOutcome,
        fromBool(opened),
      ],
    ).lastInsertRowid
    if (photo) this.savePhoto(id, now, photo)
    // a guest's opening counts towards the maximum openings of the pass and shows in its history
    if (opened && best?.guestPassId) {
      const pass = this.deps.guests.get(best.guestPassId)
      if (pass && door)
        this.deps.guests.record(
          pass,
          { id: door.id, name: door.name, controllerId: door.controllerId, door: door.door },
          'ok',
          `plate:${plate}`,
          false,
        )
    }
    if (door) {
      this.deps.bus.publishPlate(
        finalOutcome === 'granted' ? 'plate.granted' : 'plate.denied',
        door.controllerId,
        door.door,
        {
          readId: id,
          plate,
          ownerName: best?.ownerName ?? null,
          personId: best?.personId ?? null,
          guestPassId: best?.guestPassId ?? null,
          outcome: finalOutcome,
          opened,
          reader: reader.name,
          timestamp: now,
          photoPath: photo ? `/api/plates/reads/${id}/photo` : null,
        },
        photo,
      )
    }
    if (failed) this.opts.logger?.warn?.(`plate reader "${reader.name}": opening failed: ${opening.message}`)
    return { outcome: finalOutcome, opened, plate, ignored: false }
  }

  // --- photos -------------------------------------------------------------------------------------------

  /** A still image from the camera, or null (no URL, unreachable, not an image). */
  private async snapshot(url: string): Promise<Buffer | null> {
    if (!url || this.opts.photoDays <= 0) return null
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) })
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null
      const buf = Buffer.from(await res.arrayBuffer())
      return buf.length > 0 && buf.length <= MAX_PHOTO_BYTES ? buf : null
    } catch (err) {
      this.opts.logger?.warn?.(`plate snapshot ${url}: ${(err as Error).message}`)
      return null
    }
  }

  private savePhoto(readId: number, at: string, photo: Buffer): void {
    const rel = path.join(at.slice(0, 7), `${readId}.jpg`)
    try {
      fs.mkdirSync(path.join(this.opts.photoDir, at.slice(0, 7)), { recursive: true })
      fs.writeFileSync(path.join(this.opts.photoDir, rel), photo)
      this.db.run('UPDATE plate_reads SET photo = ? WHERE id = ?', [rel.replaceAll('\\', '/'), readId])
    } catch (err) {
      this.opts.logger?.warn?.(`plate photo ${readId}: ${(err as Error).message}`)
    }
  }

  /** Deletes the photos older than the retention; the readings themselves are kept. */
  purgePhotos(now = new Date()): number {
    const limit = localDateTime(new Date(now.getTime() - this.opts.photoDays * 86_400_000))
    const old = this.db.all<{ id: number; photo: string }>(
      'SELECT id, photo FROM plate_reads WHERE photo IS NOT NULL AND at < ?',
      [limit],
    )
    for (const r of old) {
      try {
        fs.rmSync(path.join(this.opts.photoDir, r.photo), { force: true })
      } catch {
        // already gone
      }
      this.db.run('UPDATE plate_reads SET photo = NULL WHERE id = ?', [r.id])
    }
    return old.length
  }

  start(): void {
    const run = () => {
      try {
        const n = this.purgePhotos()
        if (n > 0)
          this.opts.logger?.info?.(`plate readings: ${n} photos older than ${this.opts.photoDays} days deleted`)
      } catch (err) {
        this.opts.logger?.error?.(`plate photos cleanup: ${(err as Error).message}`)
      }
    }
    run()
    this.cleanupTimer = setInterval(run, 3600_000)
    this.cleanupTimer.unref()
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.cleanupTimer = null
  }
}
