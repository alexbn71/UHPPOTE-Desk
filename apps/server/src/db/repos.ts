import type {
  CardDto,
  ControllerDto,
  ControllerSettings,
  DoorDto,
  EventDto,
  PersonDto,
} from '@uhppote-desk/shared'
import type { Db } from './database.js'
import { fromBool, toBool, weekdaysFromString, weekdaysToString } from './database.js'

// ===========================================================================
// Zone e reparti (strutture ad albero identiche)
// ===========================================================================

export interface TreeNode {
  id: number
  name: string
  parentId: number | null
}

export class TreeRepo {
  constructor(
    private readonly db: Db,
    private readonly table: 'zones' | 'departments',
  ) {}

  list(): TreeNode[] {
    return this.db
      .all<{ id: number; name: string; parent_id: number | null }>(`SELECT * FROM ${this.table} ORDER BY name`)
      .map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id }))
  }

  create(name: string, parentId: number | null): number {
    return this.db.run(`INSERT INTO ${this.table} (name, parent_id) VALUES (?, ?)`, [name, parentId]).lastInsertRowid
  }

  update(id: number, name: string, parentId: number | null): boolean {
    if (parentId === id) throw new Error('Un elemento non può essere padre di sé stesso')
    return this.db.run(`UPDATE ${this.table} SET name = ?, parent_id = ? WHERE id = ?`, [name, parentId, id]).changes > 0
  }

  delete(id: number): boolean {
    return this.db.run(`DELETE FROM ${this.table} WHERE id = ?`, [id]).changes > 0
  }

  /** Trova o crea un percorso "A\B\C" restituendo l'ID della foglia. */
  ensurePath(path: string): number | null {
    const parts = path
      .split('\\')
      .map((p) => p.trim())
      .filter(Boolean)
    let parent: number | null = null
    for (const name of parts) {
      const row: { id: number } | undefined = this.db.get<{ id: number }>(
        `SELECT id FROM ${this.table} WHERE name = ? AND parent_id IS ?`,
        [name, parent],
      )
      parent = row ? row.id : this.create(name, parent)
    }
    return parent
  }
}

// ===========================================================================
// Controller e porte
// ===========================================================================

interface ControllerRow {
  id: number
  serial: number
  name: string
  host: string | null
  port: number
  transport: 'udp' | 'tcp'
  zone_id: number | null
  enabled: number
  firmware: string | null
  last_seen_at: string | null
  last_collected_index: number
  event_epoch: number
}

interface DoorRow {
  id: number
  controller_id: number
  door: number
  name: string
  active: number
  attendance: number
  mode: number
  delay: number
}

export interface ControllerRecord extends Omit<ControllerDto, 'online' | 'doors'> {
  eventEpoch: number
}

export const DEFAULT_SETTINGS: ControllerSettings = {
  interlock: 0,
  antipassback: 0,
  keypads: [false, false, false, false],
  passcodes: [[], [], [], []],
  firstCard: [null, null, null, null],
  recordSpecialEvents: true,
  pcControl: false,
  listenerInterval: 0,
}

function mapController(r: ControllerRow): ControllerRecord {
  return {
    id: r.id,
    serial: r.serial,
    name: r.name,
    host: r.host,
    port: r.port,
    transport: r.transport,
    zoneId: r.zone_id,
    enabled: toBool(r.enabled),
    firmware: r.firmware,
    lastSeenAt: r.last_seen_at,
    lastCollectedIndex: r.last_collected_index,
    eventEpoch: r.event_epoch,
  }
}

function mapDoor(r: DoorRow): DoorDto {
  return {
    id: r.id,
    controllerId: r.controller_id,
    door: r.door,
    name: r.name,
    active: toBool(r.active),
    attendance: toBool(r.attendance),
    mode: r.mode,
    delay: r.delay,
  }
}

export class ControllerRepo {
  constructor(private readonly db: Db) {}

  list(): ControllerRecord[] {
    return this.db.all<ControllerRow>('SELECT * FROM controllers ORDER BY name').map(mapController)
  }

  get(id: number): ControllerRecord | undefined {
    const r = this.db.get<ControllerRow>('SELECT * FROM controllers WHERE id = ?', [id])
    return r && mapController(r)
  }

  getBySerial(serial: number): ControllerRecord | undefined {
    const r = this.db.get<ControllerRow>('SELECT * FROM controllers WHERE serial = ?', [serial])
    return r && mapController(r)
  }

  create(c: Pick<ControllerRecord, 'serial' | 'name' | 'host' | 'port' | 'transport' | 'zoneId' | 'enabled'>): number {
    return this.db.tx(() => {
      const id = this.db.run(
        'INSERT INTO controllers (serial, name, host, port, transport, zone_id, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [c.serial, c.name, c.host, c.port, c.transport, c.zoneId, fromBool(c.enabled)],
      ).lastInsertRowid
      for (let d = 1; d <= 4; d++) {
        this.db.run('INSERT INTO doors (controller_id, door, name) VALUES (?, ?, ?)', [id, d, `${c.name} - Porta ${d}`])
      }
      this.db.run('INSERT INTO controller_settings (controller_id, settings) VALUES (?, ?)', [id, JSON.stringify(DEFAULT_SETTINGS)])
      return id
    })
  }

  update(id: number, c: Pick<ControllerRecord, 'serial' | 'name' | 'host' | 'port' | 'transport' | 'zoneId' | 'enabled'>): boolean {
    return (
      this.db.run('UPDATE controllers SET serial = ?, name = ?, host = ?, port = ?, transport = ?, zone_id = ?, enabled = ? WHERE id = ?', [
        c.serial,
        c.name,
        c.host,
        c.port,
        c.transport,
        c.zoneId,
        fromBool(c.enabled),
        id,
      ]).changes > 0
    )
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM controllers WHERE id = ?', [id]).changes > 0
  }

  markSeen(id: number, at: string, firmware?: string): void {
    if (firmware) this.db.run('UPDATE controllers SET last_seen_at = ?, firmware = ? WHERE id = ?', [at, firmware, id])
    else this.db.run('UPDATE controllers SET last_seen_at = ? WHERE id = ?', [at, id])
  }

  setHost(id: number, host: string): void {
    this.db.run('UPDATE controllers SET host = ? WHERE id = ?', [host, id])
  }

  setCollectedIndex(id: number, index: number): void {
    this.db.run('UPDATE controllers SET last_collected_index = ? WHERE id = ? AND last_collected_index < ?', [index, id, index])
  }

  /** Il controller ha ricominciato la numerazione eventi: nuova epoca, indice azzerato. */
  startNewEventEpoch(id: number): number {
    this.db.run('UPDATE controllers SET last_collected_index = 0, event_epoch = event_epoch + 1 WHERE id = ?', [id])
    return this.get(id)!.eventEpoch
  }

  doors(controllerId?: number): DoorDto[] {
    const rows =
      controllerId === undefined
        ? this.db.all<DoorRow>('SELECT * FROM doors ORDER BY controller_id, door')
        : this.db.all<DoorRow>('SELECT * FROM doors WHERE controller_id = ? ORDER BY door', [controllerId])
    return rows.map(mapDoor)
  }

  door(id: number): DoorDto | undefined {
    const r = this.db.get<DoorRow>('SELECT * FROM doors WHERE id = ?', [id])
    return r && mapDoor(r)
  }

  doorByNumber(controllerId: number, door: number): DoorDto | undefined {
    const r = this.db.get<DoorRow>('SELECT * FROM doors WHERE controller_id = ? AND door = ?', [controllerId, door])
    return r && mapDoor(r)
  }

  updateDoor(id: number, d: Pick<DoorDto, 'name' | 'active' | 'attendance' | 'mode' | 'delay'>): boolean {
    return (
      this.db.run('UPDATE doors SET name = ?, active = ?, attendance = ?, mode = ?, delay = ? WHERE id = ?', [
        d.name,
        fromBool(d.active),
        fromBool(d.attendance),
        d.mode,
        d.delay,
        id,
      ]).changes > 0
    )
  }

  settings(controllerId: number): ControllerSettings {
    const r = this.db.get<{ settings: string }>('SELECT settings FROM controller_settings WHERE controller_id = ?', [controllerId])
    return r ? { ...DEFAULT_SETTINGS, ...(JSON.parse(r.settings) as Partial<ControllerSettings>) } : { ...DEFAULT_SETTINGS }
  }

  saveSettings(controllerId: number, s: ControllerSettings): void {
    this.db.run(
      'INSERT INTO controller_settings (controller_id, settings) VALUES (?, ?) ON CONFLICT(controller_id) DO UPDATE SET settings = excluded.settings',
      [controllerId, JSON.stringify(s)],
    )
  }
}

// ===========================================================================
// Persone, tessere, permessi
// ===========================================================================

interface PersonRow {
  id: number
  code: string
  first_name: string
  last_name: string
  department_id: number | null
  department_name: string | null
  email: string
  phone: string
  notes: string
  pin: number
  valid_from: string
  valid_to: string
  active: number
  shift_id: number | null
  has_photo: number
}

interface CardRow {
  id: number
  number: number
  person_id: number | null
  person_name: string | null
  status: CardDto['status']
  created_at: string
}

export type PersonInput = Omit<PersonDto, 'id' | 'departmentName' | 'hasPhoto' | 'cards'>

const PERSON_SELECT = `
  SELECT p.id, p.code, p.first_name, p.last_name, p.department_id, d.name AS department_name, p.email, p.phone,
         p.notes, p.pin, p.valid_from, p.valid_to, p.active, p.shift_id, (p.photo IS NOT NULL) AS has_photo
  FROM people p LEFT JOIN departments d ON d.id = p.department_id`

const CARD_SELECT = `
  SELECT c.id, c.number, c.person_id, TRIM(p.last_name || ' ' || p.first_name) AS person_name, c.status, c.created_at
  FROM cards c LEFT JOIN people p ON p.id = c.person_id`

function mapCard(r: CardRow): CardDto {
  return { id: r.id, number: r.number, personId: r.person_id, personName: r.person_name, status: r.status, createdAt: r.created_at }
}

export interface PermissionRow {
  personId: number
  doorId: number
  profileId: number | null
  firstCard: boolean
}

export class PeopleRepo {
  constructor(private readonly db: Db) {}

  private mapPerson(r: PersonRow, cards: CardDto[]): PersonDto {
    return {
      id: r.id,
      code: r.code,
      firstName: r.first_name,
      lastName: r.last_name,
      departmentId: r.department_id,
      departmentName: r.department_name,
      email: r.email,
      phone: r.phone,
      notes: r.notes,
      pin: r.pin,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      active: toBool(r.active),
      shiftId: r.shift_id,
      hasPhoto: toBool(r.has_photo),
      cards,
    }
  }

  list(opts: { search?: string | undefined; departmentId?: number | undefined; active?: boolean | undefined } = {}): PersonDto[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.search) {
      where.push(`(p.code LIKE ? OR p.last_name LIKE ? OR p.first_name LIKE ? OR p.id IN (SELECT person_id FROM cards WHERE CAST(number AS TEXT) LIKE ?))`)
      const s = `%${opts.search}%`
      params.push(s, s, s, s)
    }
    if (opts.departmentId) {
      where.push('p.department_id = ?')
      params.push(opts.departmentId)
    }
    if (opts.active !== undefined) {
      where.push('p.active = ?')
      params.push(fromBool(opts.active))
    }
    const rows = this.db.all<PersonRow>(`${PERSON_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.last_name, p.first_name`, params)
    const cards = this.db.all<CardRow>(`${CARD_SELECT} WHERE c.person_id IS NOT NULL ORDER BY c.number`).map(mapCard)
    const byPerson = new Map<number, CardDto[]>()
    for (const c of cards) byPerson.set(c.personId!, [...(byPerson.get(c.personId!) ?? []), c])
    return rows.map((r) => this.mapPerson(r, byPerson.get(r.id) ?? []))
  }

  get(id: number): PersonDto | undefined {
    const r = this.db.get<PersonRow>(`${PERSON_SELECT} WHERE p.id = ?`, [id])
    return r && this.mapPerson(r, this.cards({ personId: id }))
  }

  getByCode(code: string): PersonDto | undefined {
    const r = this.db.get<PersonRow>(`${PERSON_SELECT} WHERE p.code = ?`, [code])
    return r && this.mapPerson(r, this.cards({ personId: r.id }))
  }

  create(p: PersonInput): number {
    return this.db.run(
      `INSERT INTO people (code, first_name, last_name, department_id, email, phone, notes, pin, valid_from, valid_to, active, shift_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.code, p.firstName, p.lastName, p.departmentId, p.email, p.phone, p.notes, p.pin, p.validFrom, p.validTo, fromBool(p.active), p.shiftId],
    ).lastInsertRowid
  }

  update(id: number, p: PersonInput): boolean {
    return (
      this.db.run(
        `UPDATE people SET code = ?, first_name = ?, last_name = ?, department_id = ?, email = ?, phone = ?, notes = ?, pin = ?,
         valid_from = ?, valid_to = ?, active = ?, shift_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [p.code, p.firstName, p.lastName, p.departmentId, p.email, p.phone, p.notes, p.pin, p.validFrom, p.validTo, fromBool(p.active), p.shiftId, id],
      ).changes > 0
    )
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM people WHERE id = ?', [id]).changes > 0
  }

  setPhoto(id: number, data: Buffer | null, type: string | null): void {
    this.db.run('UPDATE people SET photo = ?, photo_type = ? WHERE id = ?', [data, type, id])
  }

  photo(id: number): { data: Buffer; type: string } | undefined {
    const r = this.db.get<{ photo: Uint8Array | null; photo_type: string | null }>('SELECT photo, photo_type FROM people WHERE id = ?', [id])
    return r?.photo ? { data: Buffer.from(r.photo), type: r.photo_type ?? 'image/jpeg' } : undefined
  }

  // --- tessere ---------------------------------------------------------------

  cards(opts: { personId?: number; unassigned?: boolean; search?: string } = {}): CardDto[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.personId !== undefined) {
      where.push('c.person_id = ?')
      params.push(opts.personId)
    }
    if (opts.unassigned) where.push('c.person_id IS NULL')
    if (opts.search) {
      where.push('CAST(c.number AS TEXT) LIKE ?')
      params.push(`%${opts.search}%`)
    }
    return this.db.all<CardRow>(`${CARD_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.number`, params).map(mapCard)
  }

  card(id: number): CardDto | undefined {
    const r = this.db.get<CardRow>(`${CARD_SELECT} WHERE c.id = ?`, [id])
    return r && mapCard(r)
  }

  cardByNumber(number: number): CardDto | undefined {
    const r = this.db.get<CardRow>(`${CARD_SELECT} WHERE c.number = ?`, [number])
    return r && mapCard(r)
  }

  createCard(number: number, personId: number | null, status: CardDto['status'] = 'active'): number {
    return this.db.run('INSERT INTO cards (number, person_id, status) VALUES (?, ?, ?)', [number, personId, status]).lastInsertRowid
  }

  updateCard(id: number, personId: number | null, status: CardDto['status']): boolean {
    return this.db.run('UPDATE cards SET person_id = ?, status = ? WHERE id = ?', [personId, status, id]).changes > 0
  }

  deleteCard(id: number): boolean {
    return this.db.run('DELETE FROM cards WHERE id = ?', [id]).changes > 0
  }

  // --- permessi --------------------------------------------------------------

  permissions(personId?: number): PermissionRow[] {
    const rows =
      personId === undefined
        ? this.db.all<{ person_id: number; door_id: number; profile_id: number | null; first_card: number }>('SELECT * FROM permissions')
        : this.db.all<{ person_id: number; door_id: number; profile_id: number | null; first_card: number }>(
            'SELECT * FROM permissions WHERE person_id = ?',
            [personId],
          )
    return rows.map((r) => ({ personId: r.person_id, doorId: r.door_id, profileId: r.profile_id, firstCard: toBool(r.first_card) }))
  }

  setPermissions(personId: number, perms: Omit<PermissionRow, 'personId'>[]): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM permissions WHERE person_id = ?', [personId])
      for (const p of perms) {
        this.db.run('INSERT INTO permissions (person_id, door_id, profile_id, first_card) VALUES (?, ?, ?, ?)', [
          personId,
          p.doorId,
          p.profileId,
          fromBool(p.firstCard),
        ])
      }
    })
  }

  grant(personId: number, doorId: number, profileId: number | null): void {
    this.db.run(
      `INSERT INTO permissions (person_id, door_id, profile_id) VALUES (?, ?, ?)
       ON CONFLICT(person_id, door_id) DO UPDATE SET profile_id = excluded.profile_id`,
      [personId, doorId, profileId],
    )
  }

  revoke(personId: number, doorId: number): void {
    this.db.run('DELETE FROM permissions WHERE person_id = ? AND door_id = ?', [personId, doorId])
  }
}

// ===========================================================================
// Profili orari e task
// ===========================================================================

export interface TimeProfileRecord {
  id: number
  name: string
  validFrom: string
  validTo: string
  weekdays: boolean[]
  segments: { start: string; end: string }[]
  linkedTo: number | null
}

export interface TaskRecord {
  id: number
  controllerId: number
  door: number
  task: number
  validFrom: string
  validTo: string
  weekdays: boolean[]
  startTime: string
  moreCards: number
  enabled: boolean
}

export class ScheduleRepo {
  constructor(private readonly db: Db) {}

  profiles(): TimeProfileRecord[] {
    return this.db
      .all<{ id: number; name: string; valid_from: string; valid_to: string; weekdays: string; segments: string; linked_to: number | null }>(
        'SELECT * FROM time_profiles ORDER BY id',
      )
      .map((r) => ({
        id: r.id,
        name: r.name,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        weekdays: weekdaysFromString(r.weekdays),
        segments: JSON.parse(r.segments) as { start: string; end: string }[],
        linkedTo: r.linked_to,
      }))
  }

  profile(id: number): TimeProfileRecord | undefined {
    return this.profiles().find((p) => p.id === id)
  }

  saveProfile(p: TimeProfileRecord): void {
    this.db.run(
      `INSERT INTO time_profiles (id, name, valid_from, valid_to, weekdays, segments, linked_to) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, valid_from = excluded.valid_from, valid_to = excluded.valid_to,
         weekdays = excluded.weekdays, segments = excluded.segments, linked_to = excluded.linked_to`,
      [p.id, p.name, p.validFrom, p.validTo, weekdaysToString(p.weekdays), JSON.stringify(p.segments), p.linkedTo],
    )
  }

  deleteProfile(id: number): boolean {
    return this.db.run('DELETE FROM time_profiles WHERE id = ?', [id]).changes > 0
  }

  tasks(controllerId?: number): TaskRecord[] {
    const rows = this.db.all<{
      id: number
      controller_id: number
      door: number
      task: number
      valid_from: string
      valid_to: string
      weekdays: string
      start_time: string
      more_cards: number
      enabled: number
    }>(
      controllerId === undefined ? 'SELECT * FROM tasks ORDER BY controller_id, start_time' : 'SELECT * FROM tasks WHERE controller_id = ? ORDER BY start_time',
      controllerId === undefined ? [] : [controllerId],
    )
    return rows.map((r) => ({
      id: r.id,
      controllerId: r.controller_id,
      door: r.door,
      task: r.task,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      weekdays: weekdaysFromString(r.weekdays),
      startTime: r.start_time,
      moreCards: r.more_cards,
      enabled: toBool(r.enabled),
    }))
  }

  saveTask(t: Omit<TaskRecord, 'id'>, id?: number): number {
    const params = [t.controllerId, t.door, t.task, t.validFrom, t.validTo, weekdaysToString(t.weekdays), t.startTime, t.moreCards, fromBool(t.enabled)]
    if (id) {
      this.db.run(
        'UPDATE tasks SET controller_id = ?, door = ?, task = ?, valid_from = ?, valid_to = ?, weekdays = ?, start_time = ?, more_cards = ?, enabled = ? WHERE id = ?',
        [...params, id],
      )
      return id
    }
    return this.db.run(
      'INSERT INTO tasks (controller_id, door, task, valid_from, valid_to, weekdays, start_time, more_cards, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params,
    ).lastInsertRowid
  }

  deleteTask(id: number): boolean {
    return this.db.run('DELETE FROM tasks WHERE id = ?', [id]).changes > 0
  }
}

// ===========================================================================
// Eventi
// ===========================================================================

export interface NewEvent {
  controllerId: number
  epoch: number
  index: number
  type: number
  granted: boolean
  door: number
  direction: number
  card: number
  timestamp: string | null
  reason: number
}

const EVENT_SELECT = `
  SELECT e.id, e.controller_id, c.name AS controller_name, e.idx, e.type, e.granted, e.door, d.name AS door_name, e.direction,
         e.card, e.person_id, TRIM(p.last_name || ' ' || p.first_name) AS person_name, e.timestamp, e.reason, e.received_at
  FROM events e
  JOIN controllers c ON c.id = e.controller_id
  LEFT JOIN doors d ON d.controller_id = e.controller_id AND d.door = e.door
  LEFT JOIN people p ON p.id = e.person_id`

interface EventRow {
  id: number
  controller_id: number
  controller_name: string
  idx: number
  type: number
  granted: number
  door: number
  door_name: string | null
  direction: number
  card: number
  person_id: number | null
  person_name: string | null
  timestamp: string | null
  reason: number
  received_at: string
}

function mapEvent(r: EventRow): EventDto {
  return {
    id: r.id,
    controllerId: r.controller_id,
    controllerName: r.controller_name,
    index: r.idx,
    type: r.type,
    granted: toBool(r.granted),
    door: r.door,
    doorName: r.door_name,
    direction: r.direction,
    card: r.card,
    personId: r.person_id,
    personName: r.person_name,
    timestamp: r.timestamp,
    reason: r.reason,
    receivedAt: r.received_at,
  }
}

export interface EventFilter {
  from?: string | undefined
  to?: string | undefined
  controllerId?: number | undefined
  door?: number | undefined
  personId?: number | undefined
  card?: number | undefined
  granted?: boolean | undefined
  type?: number | undefined
  limit: number
  offset: number
}

export class EventRepo {
  constructor(private readonly db: Db) {}

  /** Inserisce l'evento se non già presente. Restituisce l'evento completo se inserito, altrimenti null. */
  insert(e: NewEvent): EventDto | null {
    const person = e.card > 0 ? this.db.get<{ person_id: number | null }>('SELECT person_id FROM cards WHERE number = ?', [e.card]) : undefined
    const r = this.db.run(
      `INSERT OR IGNORE INTO events (controller_id, epoch, idx, type, granted, door, direction, card, person_id, timestamp, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.controllerId, e.epoch, e.index, e.type, fromBool(e.granted), e.door, e.direction, e.card, person?.person_id ?? null, e.timestamp, e.reason],
    )
    if (r.changes === 0) return null
    const row = this.db.get<EventRow>(`${EVENT_SELECT} WHERE e.id = ?`, [r.lastInsertRowid])
    return row ? mapEvent(row) : null
  }

  exists(controllerId: number, epoch: number, index: number): boolean {
    return !!this.db.get('SELECT 1 FROM events WHERE controller_id = ? AND epoch = ? AND idx = ?', [controllerId, epoch, index])
  }

  query(f: EventFilter): { rows: EventDto[]; total: number } {
    const where: string[] = []
    const params: (string | number)[] = []
    if (f.from) {
      where.push('e.timestamp >= ?')
      params.push(f.from.length === 10 ? `${f.from} 00:00:00` : f.from)
    }
    if (f.to) {
      where.push('e.timestamp <= ?')
      params.push(f.to.length === 10 ? `${f.to} 23:59:59` : f.to)
    }
    if (f.controllerId) {
      where.push('e.controller_id = ?')
      params.push(f.controllerId)
    }
    if (f.door) {
      where.push('e.door = ?')
      params.push(f.door)
    }
    if (f.personId) {
      where.push('e.person_id = ?')
      params.push(f.personId)
    }
    if (f.card) {
      where.push('e.card = ?')
      params.push(f.card)
    }
    if (f.granted !== undefined) {
      where.push('e.granted = ?')
      params.push(fromBool(f.granted))
    }
    if (f.type !== undefined) {
      where.push('e.type = ?')
      params.push(f.type)
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) n FROM events e ${w}`, params)!.n
    const rows = this.db.all<EventRow>(`${EVENT_SELECT} ${w} ORDER BY e.timestamp DESC, e.id DESC LIMIT ? OFFSET ?`, [...params, f.limit, f.offset]).map(mapEvent)
    return { rows, total }
  }

  /** Ultimo swipe negato di tessera sconosciuta (per l'enrollment "passa la tessera"). */
  latestUnknownCards(sinceIso: string): { card: number; timestamp: string | null; controllerId: number; door: number }[] {
    return this.db.all(
      `SELECT card, MAX(timestamp) AS timestamp, controller_id AS controllerId, door FROM events
       WHERE type = 1 AND card > 0 AND received_at >= ? AND card NOT IN (SELECT number FROM cards)
       GROUP BY card ORDER BY MAX(id) DESC LIMIT 20`,
      [sinceIso],
    )
  }

  /** Swipe concessi sui lettori marcati "presenze" nell'intervallo. */
  attendancePunches(from: string, to: string): { personId: number; timestamp: string; direction: number }[] {
    return this.db.all(
      `SELECT e.person_id AS personId, e.timestamp, e.direction FROM events e
       JOIN doors d ON d.controller_id = e.controller_id AND d.door = e.door AND d.attendance = 1
       WHERE e.type = 1 AND e.granted = 1 AND e.person_id IS NOT NULL AND e.timestamp BETWEEN ? AND ?
       ORDER BY e.timestamp`,
      [from, to],
    )
  }
}
