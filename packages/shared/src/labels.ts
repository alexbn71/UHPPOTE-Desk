/**
 * Protocol code sets shared by server and web. Human-readable labels live in the
 * translations (`i18n/*`, keys under `codes.*`).
 */

/** Reasons that indicate an alarm/anomaly to highlight in the monitor. */
export const ALARM_REASONS = new Set([34, 37, 38, 39, 40, 41, 42, 43])

/** Reason codes that have a dedicated label. */
export const KNOWN_REASONS = [
  1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 18, 20, 23, 24, 25, 28, 29, 31, 32, 33, 34, 37, 38, 39, 40, 41, 42, 43,
  44, 45,
] as const

export const DOOR_MODES = [1, 2, 3] as const
export const FIRST_CARD_MODES = [0, 1, 2, 3] as const
export const INTERLOCK_MODES = [0, 1, 2, 3, 4, 8] as const
export const ANTIPASSBACK_MODES = [0, 1, 2, 3, 4] as const
export const TASK_TYPES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const
export const ROLES = ['admin', 'operator', 'viewer'] as const
export const LEAVE_TYPES = ['ferie', 'permesso', 'malattia', 'trasferta', 'altro'] as const

/** Event types that outgoing webhooks can subscribe to (labels under `codes.webhookEvent`, with `.` → `_`). */
export const WEBHOOK_EVENTS = [
  'access.granted',
  'access.denied',
  'door.event',
  'alarm',
  'door.opened',
  'door.closed',
  'controller.online',
  'controller.offline',
  'anomaly.unusual_time',
  'anomaly.repeated_denied',
  'guest.opened',
  'guest.refused',
] as const
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]

/**
 * Access levels of API tokens (labels under `codes.tokenAccess`):
 * read = read-only; doors = read-only plus door opening; operator / admin = like the operator roles.
 */
export const TOKEN_ACCESS = ['read', 'doors', 'operator', 'admin'] as const
export type TokenAccess = (typeof TOKEN_ACCESS)[number]

/** Notification channel types (labels under `codes.notificationType`). */
export const NOTIFICATION_TYPES = ['telegram', 'email', 'ntfy', 'gotify'] as const
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

/** Placeholder returned instead of stored passwords and tokens; sent back unchanged it keeps the stored value. */
export const SECRET_MASK = '••••••••'

/** Severity of an automation rule: sets the notification priority; alarms are also shown in the app (labels under `codes.ruleSeverity`). */
export const RULE_SEVERITIES = ['info', 'warning', 'alarm'] as const
export type RuleSeverity = (typeof RULE_SEVERITIES)[number]

/** Rule trigger fired when a door stays open longer than the configured seconds. */
export const DOOR_OPEN_FOR = 'door.open_for'

/** How mobile-app users confirm a door opening (labels under `codes.openConfirmation`). */
export const OPEN_CONFIRMATIONS = ['press', 'biometric'] as const
export type OpenConfirmation = (typeof OPEN_CONFIRMATIONS)[number]

/** Login duration of remembered devices without fingerprint/Face ID (days). */
export const MOBILE_SESSION_DAYS = [30, 60, 90, 120, 150, 180] as const

/** State of a guest pass now (labels under `codes.guestStatus`). */
export const GUEST_STATUSES = ['active', 'notYet', 'outsideHours', 'expired', 'used', 'locked', 'revoked'] as const
export type GuestStatus = (typeof GUEST_STATUSES)[number]

/**
 * Outcome of a door opening attempted with a guest link (labels under `codes.guestOutcome`):
 * ok, controller error, link used on another phone, wrong PIN, or the pass not usable now (its status).
 */
export const GUEST_OUTCOMES = [
  'ok',
  'error',
  'otherDevice',
  'wrongPin',
  'notYet',
  'outsideHours',
  'expired',
  'used',
  'locked',
  'revoked',
] as const
export type GuestOutcome = (typeof GUEST_OUTCOMES)[number]
