import { z } from 'zod'
import {
  DOOR_OPEN_FOR,
  MOBILE_SESSION_DAYS,
  OPEN_CONFIRMATIONS,
  RULE_SEVERITIES,
  TOKEN_ACCESS,
  WEBHOOK_EVENTS,
  type GuestOutcome,
  type GuestStatus,
  type OpenConfirmation,
  type PlateOutcome,
  type RuleSeverity,
  type TokenAccess,
  type WebhookEvent,
} from './labels.js'
import { LANGUAGES, type ErrorInfo, type Language } from './i18n/index.js'
import { MIN_PLATE_LENGTH, normalizePlate } from './plates.js'

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date (YYYY-MM-DD)')
export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Invalid time (HH:mm)')
export const ipv4Schema = z.ipv4({ message: 'Invalid IPv4 address' })
export const weekdaysSchema = z.array(z.boolean()).length(7)
export const doorNumberSchema = z.number().int().min(1).max(4)
export const pinSchema = z.number().int().min(0).max(999999)
export const cardNumberSchema = z.number().int().min(1).max(4294967294)
export const roleSchema = z.enum(['admin', 'operator', 'viewer'])
export type Role = z.infer<typeof roleSchema>
export const idParam = z.object({ id: z.coerce.number().int().positive() })

// ---------------------------------------------------------------------------
// Authentication and operators
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  /** Remember this device: long login with a device cookie (mobile app). */
  remember: z.boolean().optional(),
  deviceName: z.string().trim().max(100).optional(),
  /** Second factor, when the operator has two-factor authentication: code of the app or a recovery code. */
  totp: z.string().trim().max(40).optional(),
})

/** Start of the two-factor setup: the password is asked again. */
export const totpSetupSchema = z.object({ password: z.string().min(1) })

/** A code of the authenticator app (or a recovery code where accepted). */
export const totpCodeSchema = z.object({ code: z.string().trim().min(6).max(40) })

/** Switching two-factor authentication off: password and a current code (or a recovery code). */
export const totpDisableSchema = z.object({ password: z.string().min(1), code: z.string().trim().min(6).max(40) })

/** Who must use two-factor authentication: nobody, administrators, operators and administrators, everybody. */
export const REQUIRE_2FA_LEVELS = ['none', 'admin', 'operator', 'all'] as const
export type Require2fa = (typeof REQUIRE_2FA_LEVELS)[number]

/** Security settings, changed by the administrators. */
export const securitySettingsSchema = z.object({
  require2fa: z.enum(REQUIRE_2FA_LEVELS).default('none'),
})
export type SecuritySettings = z.infer<typeof securitySettingsSchema>

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'The password must be at least 8 characters long'),
})

export const operatorInputSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(50)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Only letters, digits, dot, dash and underscore'),
  displayName: z.string().min(1).max(100),
  role: roleSchema,
  active: z.boolean().default(true),
  password: z.string().min(8).optional(),
  zoneIds: z.array(z.number().int()).default([]),
})

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export const zoneInputSchema = z.object({
  name: z.string().min(1).max(100),
  parentId: z.number().int().nullable().default(null),
})

export const departmentInputSchema = zoneInputSchema

export const controllerInputSchema = z.object({
  serial: z.number().int().min(1).max(4294967295),
  name: z.string().min(1).max(100),
  host: ipv4Schema.nullable().default(null),
  port: z.number().int().min(1).max(65535).default(60000),
  transport: z.enum(['udp', 'tcp']).default('udp'),
  zoneId: z.number().int().nullable().default(null),
  enabled: z.boolean().default(true),
})

/** How the swipes on a door count for "persons inside": entry, exit or not counted. */
export const DOOR_PRESENCE = ['entry', 'exit', 'none'] as const
export type DoorPresence = (typeof DOOR_PRESENCE)[number]

export const doorInputSchema = z.object({
  name: z.string().min(1).max(100),
  active: z.boolean(),
  attendance: z.boolean(),
  presence: z.enum(DOOR_PRESENCE).default('entry'),
  mode: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  delay: z.number().int().min(0).max(255),
})

export const setIpSchema = z.object({
  address: ipv4Schema,
  netmask: ipv4Schema,
  gateway: ipv4Schema,
})

// ---------------------------------------------------------------------------
// People, cards, permissions
// ---------------------------------------------------------------------------

export const personInputSchema = z
  .object({
    code: z.string().min(1).max(50),
    firstName: z.string().max(100).default(''),
    lastName: z.string().min(1).max(100),
    departmentId: z.number().int().nullable().default(null),
    email: z.string().max(200).default(''),
    phone: z.string().max(50).default(''),
    notes: z.string().max(2000).default(''),
    pin: pinSchema.default(0),
    validFrom: dateSchema,
    validTo: dateSchema,
    active: z.boolean().default(true),
    shiftId: z.number().int().nullable().default(null),
  })
  .refine((p) => p.validFrom <= p.validTo, { message: 'The start date must precede the end date', path: ['validTo'] })

export const cardInputSchema = z.object({
  number: cardNumberSchema,
  personId: z.number().int().nullable(),
  status: z.enum(['active', 'lost', 'disabled']).default('active'),
})

export const replaceCardSchema = z.object({
  newNumber: cardNumberSchema,
})

/** Permission: profileId null = always; firstCard optional. */
export const permissionSchema = z.object({
  doorId: z.number().int(),
  profileId: z.number().int().min(2).max(254).nullable(),
  firstCard: z.boolean().default(false),
})

export const personPermissionsSchema = z.object({
  permissions: z.array(permissionSchema),
})

export const bulkPermissionsSchema = z.object({
  personIds: z.array(z.number().int()).min(1),
  doorIds: z.array(z.number().int()).min(1),
  action: z.enum(['grant', 'revoke']),
  profileId: z.number().int().min(2).max(254).nullable().default(null),
})

// ---------------------------------------------------------------------------
// Time profiles and tasks
// ---------------------------------------------------------------------------

export const segmentSchema = z.object({ start: hhmmSchema, end: hhmmSchema })

export const timeProfileInputSchema = z.object({
  id: z.number().int().min(2).max(254),
  name: z.string().min(1).max(100),
  validFrom: dateSchema,
  validTo: dateSchema,
  weekdays: weekdaysSchema,
  segments: z.array(segmentSchema).max(3),
  linkedTo: z.number().int().min(2).max(254).nullable().default(null),
})

export const taskInputSchema = z.object({
  controllerId: z.number().int(),
  door: doorNumberSchema,
  task: z.number().int().min(0).max(12),
  validFrom: dateSchema,
  validTo: dateSchema,
  weekdays: weekdaysSchema,
  startTime: hhmmSchema,
  moreCards: z.number().int().min(0).max(255).default(0),
  enabled: z.boolean().default(true),
})

// ---------------------------------------------------------------------------
// Advanced controller settings
// ---------------------------------------------------------------------------

export const firstCardDoorSchema = z.object({
  enabled: z.boolean(),
  start: hhmmSchema,
  end: hhmmSchema,
  activeMode: z.number().int().min(0).max(2),
  inactiveMode: z.number().int().min(0).max(3),
  weekdays: weekdaysSchema,
})

/** One relay of the UT0311-01A alarm expansion board (see protocol ExpansionRelay). */
export const expansionRelaySchema = z.object({
  active: z.boolean(),
  /** 0-3 = door 1-4, 16 = burglar alarm (ARM) */
  source: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(16)]),
  /** 1 timed, 2 timed + until reset, 3 until reset, 4 any signal, 5 all signals */
  mode: z.number().int().min(1).max(5),
  /** bitmask: 0x01 threat, 0x02 open too long, 0x04 forced open, 0x08 forced lock, 0x10 invalid card, 0x20 fire */
  events: z.number().int().min(0).max(0x3f),
  /** bitmask of the signals for modes 4/5 */
  signals: z.number().int().min(0).max(0xff),
  /** output duration in seconds */
  duration: z.number().int().min(0).max(6553),
})
export type ExpansionRelaySettings = z.infer<typeof expansionRelaySchema>

export const expansionBoardSchema = z.object({
  /** The board is connected: only then its configuration is sent to the controller. */
  installed: z.boolean(),
  relays: z.array(expansionRelaySchema).length(4),
  /** Seconds after which an open door raises "open too long". */
  doorOpenTooLong: z.number().int().min(1).max(6553),
  /** Duress code for the keypad; null = not sent. */
  duressCode: pinSchema.nullable(),
  /** "Door open too long" raises an alarm (vendor "Activate Open Too Long Warn", firmware V6.58+). */
  openTooLongAlarm: z.boolean().default(false),
  /** "Invalid card" alarm only after 3 invalid swipes (vendor "Activate Invalid 3 Cards Warn", V8.96+). */
  invalidCardAlarmAfter3: z.boolean().default(false),
  /** The duress code counts only after a registered card (vendor "Threat Code Valid After Card Swipe"). */
  duressAfterCard: z.boolean().default(false),
})
export type ExpansionBoardSettings = z.infer<typeof expansionBoardSchema>

/** Vendor defaults: relay N follows door N on threat, open too long, forced open and fire, for 10 s. */
export const DEFAULT_EXPANSION_BOARD: ExpansionBoardSettings = {
  installed: false,
  relays: ([0, 1, 2, 3] as const).map((source) => ({
    active: false,
    source,
    mode: 1,
    events: 0x27,
    signals: 0,
    duration: 10,
  })),
  doorOpenTooLong: 25,
  duressCode: null,
  openTooLongAlarm: false,
  invalidCardAlarmAfter3: false,
  duressAfterCard: false,
}

/** A byte of the parameter table that differs from what UHPPOTE Desk writes. */
export interface ParameterMismatchDto {
  index: number
  expected: number
  actual: number
}

/** GET /controllers/:id/expansion-board: the configuration stored in the controller. */
export interface ExpansionBoardReadDto {
  relays: ExpansionRelaySettings[]
  doorOpenTooLong: number
  duressCode: number
  openTooLongAlarm: boolean
  invalidCardAlarmAfter3: boolean
  duressAfterCard: boolean
  /** Alarm types handled by the controller (parameter 32). */
  alarmEvents: number
  recordAlarmEvents: boolean
  /** Differences from the saved configuration; null when the board is not marked as connected. */
  mismatches: ParameterMismatchDto[] | null
}

/** Check after writing the expansion board: null `verified` = the table could not be read back. */
export interface ExpansionVerificationDto {
  verified: boolean | null
  mismatches: ParameterMismatchDto[]
  error?: string
}

/** Reader and door options written to the parameter table (see protocol ControllerOptions). */
export const controllerOptionsSchema = z.object({
  /** Written to the controller only when true (controllers configured elsewhere are not touched). */
  managed: z.boolean(),
  fourTimesNormalOpen: z.object({
    readers: z.array(z.boolean()).length(4),
    /** 0 = every user, 2-15 = users of this time profile */
    timeProfile: z
      .number()
      .int()
      .min(0)
      .max(15)
      .refine((v) => v !== 1),
  }),
  silentInvalidCard: z.boolean(),
  /** even number of seconds, 0 = off */
  swipeGapSeconds: z
    .number()
    .int()
    .min(0)
    .max(600)
    .refine((v) => v % 2 === 0),
  doorAsSwitch: z.array(z.boolean()).length(4),
  /** cards needed per door: 0 = off, 2-10 */
  multiCard: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(10)
        .refine((v) => v !== 1),
    )
    .length(4),
})
export type ControllerOptionsSettings = z.infer<typeof controllerOptionsSchema>

export const DEFAULT_CONTROLLER_OPTIONS_SETTINGS: ControllerOptionsSettings = {
  managed: false,
  fourTimesNormalOpen: { readers: [false, false, false, false], timeProfile: 0 },
  silentInvalidCard: false,
  swipeGapSeconds: 0,
  doorAsSwitch: [false, false, false, false],
  multiCard: [0, 0, 0, 0],
}

/** GET /controllers/:id/controller-options: the options stored in the controller. */
export interface ControllerOptionsReadDto extends Omit<ControllerOptionsSettings, 'managed'> {
  /** Differences from the saved options; null when they are not managed by UHPPOTE Desk. */
  mismatches: ParameterMismatchDto[] | null
}

/** GET /presence: who is inside now, from the last swipe on entry/exit doors. */
export interface PresenceDto {
  since: string
  inside: {
    personId: number
    name: string
    department: string | null
    card: number
    /** Plate of the vehicle, when the last entry or exit was read by a plate reader (card 0). */
    plate: string | null
    door: string
    timestamp: string
  }[]
  /** Active people with a card whose last swipe in the period was an exit. */
  leftCount: number
  /** Doors counted: entry and exit. */
  entryDoors: number
  exitDoors: number
}

export const controllerSettingsSchema = z.object({
  interlock: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(8)]),
  antipassback: z.number().int().min(0).max(4),
  keypads: z.array(z.boolean()).length(4),
  passcodes: z.array(z.array(pinSchema).max(4)).length(4),
  firstCard: z.array(firstCardDoorSchema.nullable()).length(4),
  recordSpecialEvents: z.boolean(),
  pcControl: z.boolean(),
  listenerInterval: z.number().int().min(0).max(255),
  expansionBoard: expansionBoardSchema.default(() => structuredClone(DEFAULT_EXPANSION_BOARD)),
  controllerOptions: controllerOptionsSchema.default(() => structuredClone(DEFAULT_CONTROLLER_OPTIONS_SETTINGS)),
})
export type ControllerSettings = z.infer<typeof controllerSettingsSchema>

// ---------------------------------------------------------------------------
// Events and attendance
// ---------------------------------------------------------------------------

export const eventQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  controllerId: z.coerce.number().int().optional(),
  door: z.coerce.number().int().optional(),
  personId: z.coerce.number().int().optional(),
  card: z.coerce.number().int().optional(),
  granted: z.enum(['true', 'false']).optional(),
  type: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
})

export const shiftInputSchema = z.object({
  name: z.string().min(1).max(100),
  startTime: hhmmSchema,
  endTime: hhmmSchema,
  breakMinutes: z.number().int().min(0).max(600).default(60),
  toleranceMinutes: z.number().int().min(0).max(240).default(10),
  weekdays: weekdaysSchema,
})

export const holidayInputSchema = z.object({ date: dateSchema, name: z.string().min(1).max(100) })

export const leaveInputSchema = z
  .object({
    personId: z.number().int(),
    fromDate: dateSchema,
    toDate: dateSchema,
    type: z.enum(['ferie', 'permesso', 'malattia', 'trasferta', 'altro']),
    notes: z.string().max(500).default(''),
  })
  .refine((l) => l.fromDate <= l.toDate, { message: 'Invalid range', path: ['toDate'] })

export const manualPunchInputSchema = z.object({
  personId: z.number().int(),
  timestamp: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/),
  direction: z.union([z.literal(1), z.literal(2)]),
  reason: z.string().min(1).max(200),
})

export const attendanceQuerySchema = z.object({
  from: dateSchema,
  to: dateSchema,
  personId: z.coerce.number().int().optional(),
  departmentId: z.coerce.number().int().optional(),
})

// ---------------------------------------------------------------------------
// Output DTOs (types)
// ---------------------------------------------------------------------------

export interface OperatorDto {
  id: number
  username: string
  displayName: string
  role: Role
  active: boolean
  mustChangePassword: boolean
  zoneIds: number[]
  lastLoginAt: string | null
  /** Two-factor authentication active. */
  totpEnabled: boolean
}

export interface ControllerDto {
  id: number
  serial: number
  name: string
  host: string | null
  port: number
  transport: 'udp' | 'tcp'
  zoneId: number | null
  enabled: boolean
  firmware: string | null
  lastSeenAt: string | null
  lastCollectedIndex: number
  online: boolean
  doors: DoorDto[]
}

export interface DoorDto {
  id: number
  controllerId: number
  door: number
  name: string
  active: boolean
  attendance: boolean
  presence: DoorPresence
  mode: number
  delay: number
}

export interface PersonDto {
  id: number
  code: string
  firstName: string
  lastName: string
  departmentId: number | null
  departmentName: string | null
  email: string
  phone: string
  notes: string
  pin: number
  validFrom: string
  validTo: string
  active: boolean
  shiftId: number | null
  hasPhoto: boolean
  cards: CardDto[]
}

export interface CardDto {
  id: number
  number: number
  personId: number | null
  personName: string | null
  status: 'active' | 'lost' | 'disabled'
  createdAt: string
}

export interface EventDto {
  id: number
  controllerId: number
  controllerName: string
  index: number
  type: number
  granted: boolean
  door: number
  doorName: string | null
  direction: number
  card: number
  personId: number | null
  personName: string | null
  timestamp: string | null
  reason: number
  receivedAt: string
}

/** Card swipes counted as granted/denied. */
export interface AccessCounts {
  granted: number
  denied: number
}

/** Aggregated card swipes for the dashboard charts (local time). */
export interface EventStatsDto {
  /** Last 7 days including today, oldest first ('YYYY-MM-DD'). */
  daily: (AccessCounts & { date: string })[]
  /** Last 24 hours including the current one, oldest first ('YYYY-MM-DD HH'). */
  hourly: (AccessCounts & { hour: string })[]
  /** Last 7 days, per door, busiest first. */
  byDoor: (AccessCounts & { controllerId: number; controllerName: string; door: number; doorName: string | null })[]
  /** Last 28 days: granted swipes per weekday (0 = Monday) and hour. */
  weekHours: { weekday: number; hour: number; count: number }[]
}

export interface DoorLiveState {
  door: number
  open: boolean
  button: boolean
  unlocked: boolean
}

export interface ControllerLiveState {
  controllerId: number
  online: boolean
  lastSeenAt: string | null
  controllerTime: string | null
  driftSeconds: number | null
  doors: DoorLiveState[]
  forceLock: boolean
  fireAlarm: boolean
  /** UT0311-01A expansion board (vendor status); null when the controller has none. */
  expansion: { outputs: [boolean, boolean, boolean, boolean]; fireInput: boolean } | null
  systemError: number
  /** Last communication error, in English (MQTT, webhooks); `lastErrorInfo` is the translatable form. */
  lastError: string | null
  lastErrorInfo: ErrorInfo | null
}

export type WsMessage =
  | { type: 'event'; event: EventDto }
  | { type: 'status'; state: ControllerLiveState }
  | {
      type: 'sync'
      controllerId: number
      status: 'running' | 'ok' | 'error'
      code: string
      params?: Record<string, string | number>
    }
  | { type: 'rule'; ruleId: number; name: string; severity: RuleSeverity; text: string; at: string }

export interface SyncDiffDto {
  controllerId: number
  toAdd: number[]
  toUpdate: number[]
  toDelete: number[]
  unchanged: number
  controllerCards: number
}

export interface AttendanceDayDto {
  personId: number
  personName: string
  date: string
  status:
    | 'presente'
    | 'assente'
    | 'festivo'
    | 'riposo'
    | 'ferie'
    | 'permesso'
    | 'malattia'
    | 'trasferta'
    | 'altro'
    | 'anomalia'
  firstIn: string | null
  lastOut: string | null
  punches: { time: string; direction: number | null; source: 'controller' | 'manuale' }[]
  workedMinutes: number
  expectedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  overtimeMinutes: number
  /** anomaly codes (translated under codes.anomaly) */
  anomalies: ('singlePunch' | 'oddPunches')[]
}

// ---------------------------------------------------------------------------
// Outgoing webhooks
// ---------------------------------------------------------------------------

export const webhookInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'Only http:// and https:// URLs'),
  enabled: z.boolean().default(true),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  /** Only events of these doors (empty = all). */
  doorIds: z.array(z.number().int().positive()).default([]),
  /** Extra request headers, e.g. Authorization. */
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/, 'Invalid header name'), z.string().max(2000)).default({}),
})

export interface WebhookDto {
  id: number
  name: string
  url: string
  enabled: boolean
  events: WebhookEvent[]
  doorIds: number[]
  headers: Record<string, string>
  /** Key of the HMAC-SHA256 signature (X-UHPPOTE-Signature header). */
  secret: string
  createdAt: string
  lastDelivery: { at: string; ok: boolean; statusCode: number | null; error: string | null } | null
}

export interface WebhookDeliveryDto {
  id: number
  webhookId: number
  deliveryId: string
  event: string
  at: string
  ok: boolean
  statusCode: number | null
  error: string | null
  durationMs: number
  attempts: number
  payload: string
}

/** Body of every webhook request. */
export interface WebhookPayload {
  id: string
  type: WebhookEvent | 'webhook.test' | 'rule.triggered'
  occurredAt: string
  controller: { id: number; serial: number; name: string } | null
  door: { id: number; number: number; name: string } | null
  data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// API tokens (machine-to-machine access)
// ---------------------------------------------------------------------------

export const apiTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  access: z.enum(TOKEN_ACCESS),
  /** Allowed zones (sub-zones included); empty = all. */
  zoneIds: z.array(z.number().int().positive()).default([]),
  /** Doors that may be opened; empty = all (within the zones). */
  doorIds: z.array(z.number().int().positive()).default([]),
  /** Last valid day (inclusive); null = no expiry. */
  expiresAt: dateSchema.nullable().default(null),
  active: z.boolean().default(true),
})

export interface ApiTokenDto {
  id: number
  name: string
  /** First characters of the token, to recognise it (the token itself is shown only once). */
  prefix: string
  access: TokenAccess
  zoneIds: number[]
  doorIds: number[]
  expiresAt: string | null
  active: boolean
  createdAt: string
  createdBy: string | null
  lastUsedAt: string | null
  lastUsedIp: string | null
}

// ---------------------------------------------------------------------------
// Guest passes (door opening from a link, without card or app)
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD HH:mm' (local time). */
export const dateTimeMinutesSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/, 'Invalid date and time (YYYY-MM-DD HH:mm)')

/** PIN a guest types in the link page: 4 to 8 digits. */
export const guestPinSchema = z.string().regex(/^\d{4,8}$/, 'The PIN must have 4 to 8 digits')

export const guestPassInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    note: z.string().trim().max(500).default(''),
    doorIds: z.array(z.number().int().positive()).min(1),
    /** First and last moment of validity ('YYYY-MM-DD HH:mm'; `validTo` excluded). */
    validFrom: dateTimeMinutesSchema,
    validTo: dateTimeMinutesSchema,
    /** Days of the week (Monday first) and daily window within the validity; null times = all day. */
    weekdays: weekdaysSchema.default([true, true, true, true, true, true, true]),
    timeFrom: hhmmSchema.nullable().default(null),
    timeTo: hhmmSchema.nullable().default(null),
    /** Maximum number of openings; null = unlimited. */
    maxOpens: z.number().int().min(1).max(10_000).nullable().default(null),
    /** The link works only on the first phone that opens a door with it. */
    bindDevice: z.boolean().default(true),
    /** New PIN; null = no PIN; omitted when editing = keep the current one. */
    pin: guestPinSchema.nullable().optional(),
    /** Plates of the guest's vehicle: plate readers open the doors of the pass for them. */
    plates: z
      .array(z.lazy(() => plateTextSchema))
      .max(5)
      .default([]),
  })
  .refine((g) => g.validFrom < g.validTo, { message: 'The start must precede the end', path: ['validTo'] })
  .refine((g) => (g.timeFrom === null) === (g.timeTo === null), {
    message: 'Set both times or neither',
    path: ['timeTo'],
  })
export type GuestPassInput = z.infer<typeof guestPassInputSchema>

export interface GuestPassDto {
  id: number
  name: string
  note: string
  doorIds: number[]
  validFrom: string
  validTo: string
  weekdays: boolean[]
  timeFrom: string | null
  timeTo: string | null
  maxOpens: number | null
  bindDevice: boolean
  hasPin: boolean
  /** Bound to the phone that first used it (with `bindDevice`). */
  boundAt: string | null
  /** Too many wrong PINs: the link is blocked until an operator unlocks it. */
  locked: boolean
  revokedAt: string | null
  createdBy: string
  createdAt: string
  /** Successful openings, and the last one. */
  opens: number
  lastOpenAt: string | null
  status: GuestStatus
  plates: string[]
}

/** A new link: returned only when the pass is created or its link regenerated. */
export interface GuestLinkDto {
  pass: GuestPassDto
  /** The secret part of the link. */
  token: string
  /** Full address to send to the guest. */
  link: string
}

export interface GuestOpenDto {
  id: number
  at: string
  doorId: number | null
  doorName: string | null
  outcome: GuestOutcome
  ip: string | null
}

/** What the guest sees in the link page. */
export interface GuestViewDto {
  name: string
  doors: { id: number; name: string }[]
  validFrom: string
  validTo: string
  weekdays: boolean[]
  timeFrom: string | null
  timeTo: string | null
  /** Openings left; null = unlimited. */
  opensLeft: number | null
  status: GuestStatus
  /** The PIN must be typed (not needed on the phone the link is already bound to). */
  pinRequired: boolean
  /** The link is bound to another phone: it cannot be used from this one. */
  otherDevice: boolean
}

export const guestOpenSchema = z.object({ pin: guestPinSchema.optional() })
export const guestTokenParam = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) })

// ---------------------------------------------------------------------------
// Licence plates (plate readers such as AgentDVR open doors for known vehicles)
// ---------------------------------------------------------------------------

/** A plate as typed: normalised to upper-case letters and digits. */
export const plateTextSchema = z
  .string()
  .transform(normalizePlate)
  .pipe(z.string().min(MIN_PLATE_LENGTH, `At least ${MIN_PLATE_LENGTH} letters or digits`).max(12))

export const plateInputSchema = z.object({
  plate: plateTextSchema,
  personId: z.number().int().positive(),
  note: z.string().trim().max(200).default(''),
})

export interface PlateDto {
  id: number
  plate: string
  /** Owner: a person, or a guest pass. */
  personId: number | null
  personName: string | null
  guestPassId: number | null
  guestName: string | null
  note: string
  createdAt: string
}

export const plateReaderInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Door opened for authorised plates. */
  doorId: z.number().int().positive(),
  /** Still image of the camera taken at every reading (e.g. AgentDVR grab.jpg); empty = no photo. */
  snapshotUrl: z.union([z.literal(''), z.url({ protocol: /^https?$/ })]).default(''),
  /** After an opening, readings of this camera are ignored for these seconds (the car is still there). */
  debounceSeconds: z.number().int().min(0).max(600).default(30),
  /** Off = readings are only recorded, the door is never opened (to test a new camera). */
  openDoor: z.boolean().default(true),
  enabled: z.boolean().default(true),
})
export type PlateReaderInput = z.infer<typeof plateReaderInputSchema>

export interface PlateReaderDto extends PlateReaderInput {
  id: number
  /** First characters of the key, to recognise it (the key is shown only when created). */
  keyPrefix: string
  lastReadAt: string | null
  createdAt: string
}

/** A new reader key: returned only when the reader is created or its key regenerated. */
export interface PlateReaderKeyDto {
  reader: PlateReaderDto
  key: string
}

export interface PlateReadDto {
  id: number
  at: string
  readerId: number | null
  readerName: string
  doorId: number | null
  doorName: string | null
  /** What the reader sent, unchanged. */
  raw: string
  /** The plate the outcome refers to (the matching reading, or the first one). */
  plate: string
  plateId: number | null
  personId: number | null
  guestPassId: number | null
  ownerName: string | null
  outcome: PlateOutcome
  /** The door was opened (granted readings with the reader in "record only" mode are not). */
  opened: boolean
  hasPhoto: boolean
}

export const plateReadQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  outcome: z.enum(['granted', 'denied']).optional(),
  search: z.string().trim().max(50).optional(),
  readerId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})

// ---------------------------------------------------------------------------
// Notifications (Telegram, email, ntfy, Gotify)
// ---------------------------------------------------------------------------

const httpUrlSchema = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Only http:// and https:// URLs')

export const telegramConfigSchema = z.object({
  type: z.literal('telegram'),
  botToken: z.string().trim().min(1).max(200),
  /** Numeric chat id (negative for groups) or @channelname. */
  chatId: z
    .string()
    .trim()
    .regex(/^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/, 'Numeric chat id or @channel'),
  /** "Open door" button under the notifications of a door. */
  openButton: z.boolean().default(false),
  /** Telegram user ids allowed to press the button. */
  allowedUserIds: z.array(z.number().int().positive()).default([]),
})

export const emailConfigSchema = z.object({
  type: z.literal('email'),
  host: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65535).default(587),
  /** true = TLS from the start (port 465); false = STARTTLS when offered (587, 25). */
  secure: z.boolean().default(false),
  username: z.string().max(200).default(''),
  password: z.string().max(500).default(''),
  from: z.string().trim().min(3).max(200),
  to: z.array(z.string().trim().email()).min(1).max(20),
})

export const ntfyConfigSchema = z.object({
  type: z.literal('ntfy'),
  serverUrl: httpUrlSchema.default('https://ntfy.sh'),
  topic: z
    .string()
    .trim()
    .regex(/^[-_A-Za-z0-9]{1,64}$/, 'Letters, digits, - and _ only'),
  /** Access token (tk_…), or username and password. */
  token: z.string().max(200).default(''),
  username: z.string().max(200).default(''),
  password: z.string().max(500).default(''),
})

export const gotifyConfigSchema = z.object({
  type: z.literal('gotify'),
  serverUrl: httpUrlSchema,
  appToken: z.string().trim().min(1).max(200),
})

export const notificationConfigSchema = z.discriminatedUnion('type', [
  telegramConfigSchema,
  emailConfigSchema,
  ntfyConfigSchema,
  gotifyConfigSchema,
])
export type NotificationConfig = z.infer<typeof notificationConfigSchema>

export const notificationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    events: z.array(z.enum(WEBHOOK_EVENTS)).default([]),
    /** Only events of these doors (empty = all). */
    doorIds: z.array(z.number().int().positive()).default([]),
    language: z
      .string()
      .refine((l): l is Language => LANGUAGES.some((x) => x.code === l), 'Unknown language')
      .default('en'),
    /** Daily report: who came in and the anomalies of the last 24 hours. */
    dailyReport: z.boolean().default(false),
    reportHour: z.number().int().min(0).max(23).default(20),
    config: notificationConfigSchema,
  })
  .refine((n) => n.events.length > 0 || n.dailyReport, {
    message: 'Choose at least one event or the daily report',
    path: ['events'],
  })
  .refine((n) => n.config.type !== 'telegram' || !n.config.openButton || n.config.allowedUserIds.length > 0, {
    message: 'The open button needs at least one allowed Telegram user id',
    path: ['config', 'allowedUserIds'],
  })

export interface NotificationChannelDto {
  id: number
  name: string
  enabled: boolean
  events: WebhookEvent[]
  doorIds: number[]
  language: Language
  dailyReport: boolean
  reportHour: number
  /** Passwords and tokens are replaced by SECRET_MASK. */
  config: NotificationConfig
  createdAt: string
  lastSentAt: string | null
  lastError: string | null
  lastReportDate: string | null
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

export const anomalySettingsSchema = z.object({
  /** Days of history that make up each person's habits. */
  baselineDays: z.number().int().min(7).max(365).default(60),
  /** Accesses needed before a person's habits are used; with fewer, only the night window applies. */
  minSamples: z.number().int().min(3).max(500).default(10),
  /** Minutes from the nearest usual access time beyond which an access is unusual. */
  toleranceMinutes: z.number().int().min(15).max(720).default(90),
  /** Night window, used for people without enough history. */
  nightStart: hhmmSchema.default('22:00'),
  nightEnd: hhmmSchema.default('06:00'),
  /** Denied attempts with the same card (or at the same door) within the window that make a burst. */
  deniedCount: z.number().int().min(2).max(50).default(3),
  deniedWindowMinutes: z.number().int().min(1).max(1440).default(10),
  /** Days without a granted access after which an active card is inactive. */
  inactiveDays: z.number().int().min(14).max(1095).default(90),
})
export type AnomalySettings = z.infer<typeof anomalySettingsSchema>

export const anomalyPeriodSchema = z.object({ from: dateSchema, to: dateSchema })

/** hour = far from the usual times; day = non-working day never used before; night = night access without enough history. */
export type UnusualKind = 'hour' | 'day' | 'night'

export interface UnusualAccessDto {
  eventId: number
  personId: number
  personName: string | null
  timestamp: string
  controllerId: number
  controllerName: string
  doorName: string | null
  door: number
  kind: UnusualKind
  /** Usual time window of the person (5th–95th percentile), when known. */
  usualFrom: string | null
  usualTo: string | null
  samples: number
}

export interface DeniedBurstDto {
  card: number | null
  personId: number | null
  personName: string | null
  doors: string[]
  /** The doors of the attempts, as controller id and door number. */
  doorRefs: { controllerId: number; door: number }[]
  count: number
  first: string
  last: string
  reasons: number[]
}

export interface InactiveCardDto {
  cardId: number
  number: number
  personId: number | null
  personName: string | null
  personActive: boolean | null
  /** Last granted access; null = never used. */
  lastUsedAt: string | null
  createdAt: string
  daysInactive: number
}

// ---------------------------------------------------------------------------
// Automation rules
// ---------------------------------------------------------------------------

export const ruleTriggerSchema = z.object({
  /** An integration event, or DOOR_OPEN_FOR (door open longer than `seconds`). */
  type: z.enum([...WEBHOOK_EVENTS, DOOR_OPEN_FOR]),
  seconds: z.number().int().min(10).max(86_400).default(120),
})

export const ruleConditionsSchema = z
  .object({
    /** Only these doors (empty = all). */
    doorIds: z.array(z.number().int().positive()).default([]),
    /** Only accesses of these people or cards (empty = anyone). */
    personIds: z.array(z.number().int().positive()).default([]),
    cards: z.array(z.number().int().positive()).default([]),
    /** Time window, may cross midnight; null = any time. */
    timeFrom: hhmmSchema.nullable().default(null),
    timeTo: hhmmSchema.nullable().default(null),
    /** Monday first. */
    weekdays: z.array(z.boolean()).length(7).default([true, true, true, true, true, true, true]),
  })
  .refine((c) => (c.timeFrom === null) === (c.timeTo === null), { message: 'Set both times or none', path: ['timeTo'] })

export const ruleActionsSchema = z.object({
  /** Notification channels that receive the message. */
  channelIds: z.array(z.number().int().positive()).default([]),
  /** Webhooks that receive a `rule.triggered` request. */
  webhookIds: z.array(z.number().int().positive()).default([]),
  /** Doors to open. */
  openDoorIds: z.array(z.number().int().positive()).default([]),
})

export const ruleInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  severity: z.enum(RULE_SEVERITIES).default('warning'),
  /** Language of the automatic texts (event description, reason, duration). */
  language: z
    .string()
    .refine((l): l is Language => LANGUAGES.some((x) => x.code === l), 'Unknown language')
    .default('en'),
  trigger: ruleTriggerSchema,
  conditions: ruleConditionsSchema.default({
    doorIds: [],
    personIds: [],
    cards: [],
    timeFrom: null,
    timeTo: null,
    weekdays: [true, true, true, true, true, true, true],
  }),
  actions: ruleActionsSchema.default({ channelIds: [], webhookIds: [], openDoorIds: [] }),
  /** Message text with placeholders {person} {card} {door} {controller} {time} {date} {reason} {duration}; empty = automatic. */
  message: z.string().max(500).default(''),
  /** Minimum seconds between two firings of the rule. */
  cooldownSeconds: z.number().int().min(0).max(86_400).default(0),
})
export type RuleInput = z.infer<typeof ruleInputSchema>

export interface RuleDto extends RuleInput {
  id: number
  createdAt: string
  lastFiredAt: string | null
  fireCount: number
}

export interface RuleRunDto {
  id: number
  ruleId: number
  at: string
  text: string
  /** Actions that failed. */
  errors: string[]
}

// ---------------------------------------------------------------------------
// Mobile app (PWA): remembered devices, fingerprint/Face ID, push notifications
// ---------------------------------------------------------------------------

export const mobileSettingsSchema = z.object({
  /** press = hold the button; biometric = fingerprint/Face ID on remembered devices. */
  openConfirmation: z.enum(OPEN_CONFIRMATIONS).default('press'),
  /** Login duration of remembered devices without fingerprint/Face ID (devices with it never expire). */
  sessionDays: z
    .number()
    .int()
    .refine((d) => (MOBILE_SESSION_DAYS as readonly number[]).includes(d), 'Choose 30, 60, 90, 120, 150 or 180 days')
    .default(90),
})
export type MobileSettings = z.infer<typeof mobileSettingsSchema>

export interface DeviceDto {
  id: number
  operatorId: number
  operatorName: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  lastIp: string | null
  biometric: boolean
  push: boolean
  /** null = no expiry (fingerprint/Face ID registered). */
  expiresAt: string | null
}

export interface PushPreferencesDto {
  events: WebhookEvent[]
  doorIds: number[]
  /** Also the firings of automation rules. */
  rules: boolean
  language: Language
  lastSentAt: string | null
  lastError: string | null
}

/** What the mobile app needs: settings, this device, its push subscription. */
export interface MobileConfigDto {
  openConfirmation: OpenConfirmation
  sessionDays: number
  vapidPublicKey: string
  /** null when logged in without "remember this device". */
  device:
    | (Pick<DeviceDto, 'id' | 'name' | 'createdAt' | 'biometric' | 'expiresAt'> & { push: PushPreferencesDto | null })
    | null
}

export interface MobileDoorDto {
  id: number
  controllerId: number
  controllerName: string
  door: number
  name: string
  /** The user may open it (role, zones, door restrictions). */
  canOpen: boolean
}

export const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  }),
  events: z.array(z.enum(WEBHOOK_EVENTS)).default(['access.denied', 'alarm', 'controller.offline']),
  doorIds: z.array(z.number().int().positive()).default([]),
  rules: z.boolean().default(true),
  language: z
    .string()
    .refine((l): l is Language => LANGUAGES.some((x) => x.code === l), 'Unknown language')
    .default('en'),
})

/** Body of a push message (read by the service worker). */
export interface PushPayload {
  title: string
  body: string
  tag: string
  url: string
  /** Door of the event, with the "open" action when the user may open it. */
  door: { id: number; name: string } | null
  canOpen: boolean
  confirmation: OpenConfirmation
  texts: { open: string; opened: string; failed: string }
}
