import { z } from 'zod'

// ---------------------------------------------------------------------------
// Primitive
// ---------------------------------------------------------------------------

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data non valida (AAAA-MM-GG)')
export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Ora non valida (HH:mm)')
export const ipv4Schema = z.ipv4({ message: 'Indirizzo IPv4 non valido' })
export const weekdaysSchema = z.array(z.boolean()).length(7)
export const doorNumberSchema = z.number().int().min(1).max(4)
export const pinSchema = z.number().int().min(0).max(999999)
export const cardNumberSchema = z
  .number()
  .int()
  .min(1)
  .max(4294967294)
export const roleSchema = z.enum(['admin', 'operator', 'viewer'])
export type Role = z.infer<typeof roleSchema>
export const idParam = z.object({ id: z.coerce.number().int().positive() })

// ---------------------------------------------------------------------------
// Autenticazione e operatori
// ---------------------------------------------------------------------------

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'La password deve avere almeno 8 caratteri'),
})

export const operatorInputSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(50)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Solo lettere, numeri, punto, trattino e underscore'),
  displayName: z.string().min(1).max(100),
  role: roleSchema,
  active: z.boolean().default(true),
  password: z.string().min(8).optional(),
  zoneIds: z.array(z.number().int()).default([]),
})

// ---------------------------------------------------------------------------
// Struttura
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

export const doorInputSchema = z.object({
  name: z.string().min(1).max(100),
  active: z.boolean(),
  attendance: z.boolean(),
  mode: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  delay: z.number().int().min(0).max(255),
})

export const setIpSchema = z.object({
  address: ipv4Schema,
  netmask: ipv4Schema,
  gateway: ipv4Schema,
})

// ---------------------------------------------------------------------------
// Persone, tessere, permessi
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
  .refine((p) => p.validFrom <= p.validTo, { message: 'La data di inizio deve precedere la data di fine', path: ['validTo'] })

export const cardInputSchema = z.object({
  number: cardNumberSchema,
  personId: z.number().int().nullable(),
  status: z.enum(['active', 'lost', 'disabled']).default('active'),
})

export const replaceCardSchema = z.object({
  newNumber: cardNumberSchema,
})

/** Permesso: profileId null = sempre; firstCard opzionale. */
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
// Fasce orarie e task
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
// Impostazioni avanzate del controller
// ---------------------------------------------------------------------------

export const firstCardDoorSchema = z.object({
  enabled: z.boolean(),
  start: hhmmSchema,
  end: hhmmSchema,
  activeMode: z.number().int().min(0).max(2),
  inactiveMode: z.number().int().min(0).max(3),
  weekdays: weekdaysSchema,
})

export const controllerSettingsSchema = z.object({
  interlock: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(8)]),
  antipassback: z.number().int().min(0).max(4),
  keypads: z.array(z.boolean()).length(4),
  passcodes: z.array(z.array(pinSchema).max(4)).length(4),
  firstCard: z.array(firstCardDoorSchema.nullable()).length(4),
  recordSpecialEvents: z.boolean(),
  pcControl: z.boolean(),
  listenerInterval: z.number().int().min(0).max(255),
})
export type ControllerSettings = z.infer<typeof controllerSettingsSchema>

// ---------------------------------------------------------------------------
// Eventi e presenze
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
  .refine((l) => l.fromDate <= l.toDate, { message: 'Intervallo non valido', path: ['toDate'] })

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
// DTO in uscita (tipi)
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
  systemError: number
  lastError: string | null
}

export type WsMessage =
  | { type: 'event'; event: EventDto }
  | { type: 'status'; state: ControllerLiveState }
  | { type: 'sync'; controllerId: number; status: string; message: string }

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
  status: 'presente' | 'assente' | 'festivo' | 'riposo' | 'ferie' | 'permesso' | 'malattia' | 'trasferta' | 'altro' | 'anomalia'
  firstIn: string | null
  lastOut: string | null
  punches: { time: string; direction: number | null; source: 'controller' | 'manuale' }[]
  workedMinutes: number
  expectedMinutes: number
  lateMinutes: number
  earlyLeaveMinutes: number
  overtimeMinutes: number
  anomalies: string[]
}
