import path from 'node:path'
import type { Logger } from '@uhppote-desk/protocol'
import { AuthService } from './auth/auth.js'
import type { AppConfig } from './config.js'
import { AuditLog } from './db/audit.js'
import { Db } from './db/database.js'
import { ControllerRepo, EventRepo, PeopleRepo, ScheduleRepo, TreeRepo } from './db/repos.js'
import { ControllerGateway, LiveHub } from './gateway/gateway.js'
import { BackupService } from './services/backup.js'
import { EventService } from './services/events.js'
import { HealthService } from './services/health.js'
import { SyncService } from './services/sync.js'

/** All the application dependencies (injectable in tests). */
export interface AppContext {
  config: AppConfig
  db: Db
  audit: AuditLog
  auth: AuthService
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
  const protoLogger: Logger = config.uhppote.debug ? logger : { warn: logger.warn, error: logger.error, info: logger.info }
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
  return {
    config,
    db,
    audit,
    auth: new AuthService(db, config.sessionHours),
    zones: new TreeRepo(db, 'zones'),
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
    backup: new BackupService(db, path.join(config.dataDir, 'backups'), { hour: config.backupHour, keep: config.backupKeep, logger }),
    logger,
  }
}
