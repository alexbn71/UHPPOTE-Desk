import path from 'node:path'
import type { Logger } from '@uhppote-desk/protocol'
import { AuthService } from './auth/auth.js'
import { DeviceService } from './auth/devices.js'
import { ApiTokenService } from './auth/tokens.js'
import type { AppConfig } from './config.js'
import { AuditLog } from './db/audit.js'
import { Db } from './db/database.js'
import { NotificationRepo } from './db/notifications.js'
import { RuleRepo } from './db/rules.js'
import { WebhookRepo } from './db/webhooks.js'
import { ControllerRepo, EventRepo, PeopleRepo, ScheduleRepo, TreeRepo } from './db/repos.js'
import { ControllerGateway, LiveHub } from './gateway/gateway.js'
import { BackupService } from './services/backup.js'
import { EventService } from './services/events.js'
import { GuestService } from './services/guests.js'
import { PlateService } from './services/plates.js'
import { HealthService } from './services/health.js'
import { MqttService } from './services/mqtt.js'
import { SyncService } from './services/sync.js'
import { AnomalyService } from './services/anomalies.js'
import { IntegrationEvents } from './services/integrationEvents.js'
import { NotificationService } from './services/notify/notifications.js'
import { MobileService } from './services/mobile.js'
import { PushService } from './services/push.js'
import { RuleEngine } from './services/rules.js'
import { WebhookService } from './services/webhooks.js'
import { APP_VERSION } from './routes/system.js'

/** All the application dependencies (injectable in tests). */
export interface AppContext {
  config: AppConfig
  db: Db
  audit: AuditLog
  auth: AuthService
  tokens: ApiTokenService
  devices: DeviceService
  mobile: MobileService
  push: PushService
  guests: GuestService
  plates: PlateService
  zones: TreeRepo
  departments: TreeRepo
  controllers: ControllerRepo
  people: PeopleRepo
  schedule: ScheduleRepo
  events: EventRepo
  hub: LiveHub
  gateway: ControllerGateway
  eventService: EventService
  health: HealthService
  sync: SyncService
  backup: BackupService
  /** MQTT bridge to Home Assistant; null when MQTT_URL is not set. */
  mqtt: MqttService | null
  integrationEvents: IntegrationEvents
  anomalies: AnomalyService
  webhooks: WebhookRepo
  webhookService: WebhookService
  notifications: NotificationRepo
  notificationService: NotificationService
  rules: RuleRepo
  ruleEngine: RuleEngine
  logger: Logger
}

export function createContext(config: AppConfig, logger: Logger, dbFile?: string): AppContext {
  const db = new Db(dbFile ?? path.join(config.dataDir, 'uhppote-desk.sqlite'))
  db.migrate()
  const audit = new AuditLog(db)
  const controllers = new ControllerRepo(db)
  const people = new PeopleRepo(db)
  const schedule = new ScheduleRepo(db)
  const events = new EventRepo(db)
  const hub = new LiveHub()
  const webhooks = new WebhookRepo(db)
  const anomalies = new AnomalyService(db, events)
  const integrationEvents = new IntegrationEvents(controllers, hub, logger, anomalies)
  const notifications = new NotificationRepo(db)
  const rules = new RuleRepo(db)
  const mobile = new MobileService(db)
  const auth = new AuthService(db, config.sessionHours, config.admin2faBypass ?? false)
  const zones = new TreeRepo(db, 'zones')
  const protoLogger: Logger = config.uhppote.debug
    ? logger
    : { warn: logger.warn, error: logger.error, info: logger.info }
  const gateway = new ControllerGateway(controllers, audit, hub, { ...config.uhppote, logger: protoLogger })
  const eventService = new EventService(gateway, controllers, events, {
    listen: config.uhppote.listen,
    initialBackfill: config.initialBackfill,
    logger,
  })
  const sync = new SyncService(db, gateway, controllers, people, schedule, logger)
  const health = new HealthService(gateway, controllers, eventService, {
    intervalSec: config.healthIntervalSec,
    timeSyncThresholdSec: config.timeSyncThresholdSec,
    listenerPublic: config.uhppote.listenerPublic,
    listenerInterval: (id) => controllers.settings(id).listenerInterval,
    afterBackOnline: (id) => sync.restoreIfEmpty(id),
    logger,
  })
  const guests = new GuestService(db, controllers, integrationEvents)
  const plates = new PlateService(
    db,
    { controllers, schedule, gateway, guests, bus: integrationEvents },
    { photoDir: path.join(config.dataDir, 'plates'), photoDays: config.platePhotoDays ?? 30, logger },
  )
  const ctx: Omit<AppContext, 'ruleEngine'> & { ruleEngine?: RuleEngine } = {
    config,
    db,
    audit,
    auth,
    devices: new DeviceService(db, () => mobile.settings()),
    mobile,
    push: new PushService(
      db,
      integrationEvents,
      hub,
      { mobile, auth, controllers, zones, publicUrl: config.publicUrl },
      logger,
    ),
    tokens: new ApiTokenService(db),
    guests,
    plates,
    zones,
    departments: new TreeRepo(db, 'departments'),
    controllers,
    people,
    schedule,
    events,
    hub,
    gateway,
    eventService,
    health,
    sync,
    backup: new BackupService(db, path.join(config.dataDir, 'backups'), {
      hour: config.backupHour,
      keep: config.backupKeep,
      logger,
    }),
    mqtt: config.mqtt ? new MqttService(config.mqtt, controllers, gateway, { version: APP_VERSION, logger }) : null,
    webhooks,
    integrationEvents,
    anomalies,
    webhookService: new WebhookService(webhooks, integrationEvents, { version: APP_VERSION, logger }),
    notifications,
    notificationService: new NotificationService(
      notifications,
      integrationEvents,
      { controllers, events, gateway, anomalies },
      { logger },
    ),
    rules,
    logger,
  }
  ctx.ruleEngine = new RuleEngine(
    rules,
    integrationEvents,
    { controllers, gateway, notifications: () => ctx.notificationService, webhooks: () => ctx.webhookService },
    logger,
  )
  return ctx as AppContext
}
