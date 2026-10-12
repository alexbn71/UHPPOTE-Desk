/**
 * Protocol code sets shared by server and web. Human-readable labels live in the
 * translations (`i18n/*`, keys under `codes.*`).
 */

/** Reasons that indicate an alarm/anomaly to highlight in the monitor. */
export const ALARM_REASONS = new Set([34, 37, 38, 39, 40, 41, 42, 43])

/** Reason codes that have a dedicated label. */
export const KNOWN_REASONS = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 18, 20, 23, 24, 25, 28, 29, 31, 32, 33, 34, 37, 38, 39, 40, 41, 42, 43, 44, 45] as const

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
