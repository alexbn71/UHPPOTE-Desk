import path from 'node:path'
import { LANGUAGES, type Language } from '@uhppote-desk/shared'

export interface AppConfig {
  /** HTTP port of the web app. */
  httpPort: number
  httpHost: string
  /** Data directory (SQLite database, backups, photos). */
  dataDir: string
  /** Session cookie with the Secure flag (enable behind HTTPS). */
  secureCookies: boolean
  sessionHours: number
  /** Password of the `admin` user (ADMIN_PASSWORD); null = generated on first start. */
  adminPassword: string | null
  /** The deprecated INITIAL_ADMIN_PASSWORD variable was used instead of ADMIN_PASSWORD. */
  adminPasswordFromLegacyVariable: boolean
  /** Directory with the frontend build to serve (optional). */
  webDir: string | null
  uhppote: {
    /** Local IP for the sockets towards the controllers. */
    bindAddress: string
    /** Broadcast 'ip:port' for discovery. */
    broadcast: string
    /** 'ip:port' address on which events are received. */
    listen: string
    /** IP:port (reachable by the controller) to program as listener; empty = do not configure it automatically. */
    listenerPublic: string | null
    timeoutMs: number
    retries: number
    debug: boolean
  }
  /** Polling interval of the controller status (seconds). */
  healthIntervalSec: number
  /** Safety-net event collection interval (seconds). */
  collectIntervalSec: number
  /** Clock drift beyond which the controller time is corrected (seconds; 0 = never). */
  timeSyncThresholdSec: number
  /** Maximum number of past events downloaded the first time a controller is connected. */
  initialBackfill: number
  /** Hour of the daily backup (0-23; -1 = disabled). */
  backupHour: number
  backupKeep: number
  /** MQTT bridge (Home Assistant discovery); null = disabled. */
  mqtt: MqttConfig | null
  /** Public address of the app behind a reverse proxy (e.g. https://doors.example.com): fingerprint/Face ID and push use it. */
  publicUrl: string | null
}

export interface MqttConfig {
  /** Broker URL, e.g. mqtt://192.168.1.10:1883 or mqtts://broker:8883. */
  url: string
  username: string | null
  password: string | null
  /** Prefix of the topics published by the app. */
  baseTopic: string
  /** Home Assistant discovery prefix. */
  discoveryPrefix: string
  /** Whether doors may be opened by MQTT commands (the Home Assistant buttons). */
  doorControl: boolean
  /** Language of the entity names and event texts sent to Home Assistant. */
  language: Language
}

function env(name: string, fallback: string): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(env(name, String(fallback)), 10)
  if (Number.isNaN(v)) throw new Error(`variable ${name} is not a number`)
  return v
}

function bool(name: string, fallback: boolean): boolean {
  return ['1', 'true', 'yes', 'on'].includes(env(name, String(fallback)).toLowerCase())
}

function loadMqtt(): MqttConfig | null {
  const url = env('MQTT_URL', '')
  if (!url) return null
  const language = env('MQTT_LANGUAGE', 'en')
  if (!LANGUAGES.some((l) => l.code === language)) {
    throw new Error(`variable MQTT_LANGUAGE must be one of ${LANGUAGES.map((l) => l.code).join(', ')}`)
  }
  return {
    url,
    username: process.env.MQTT_USERNAME || null,
    password: process.env.MQTT_PASSWORD || null,
    baseTopic: env('MQTT_BASE_TOPIC', 'uhppote-desk').replace(/\/+$/, ''),
    discoveryPrefix: env('MQTT_DISCOVERY_PREFIX', 'homeassistant').replace(/\/+$/, ''),
    doorControl: bool('MQTT_DOOR_CONTROL', true),
    language: language as Language,
  }
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(env('DATA_DIR', './data'))
  return {
    httpPort: int('HTTP_PORT', 8080),
    httpHost: env('HTTP_HOST', '0.0.0.0'),
    dataDir,
    secureCookies: bool('SECURE_COOKIES', false),
    sessionHours: int('SESSION_HOURS', 12),
    adminPassword: process.env.ADMIN_PASSWORD || process.env.INITIAL_ADMIN_PASSWORD || null,
    adminPasswordFromLegacyVariable: !process.env.ADMIN_PASSWORD && !!process.env.INITIAL_ADMIN_PASSWORD,
    webDir: process.env.WEB_DIR ? path.resolve(process.env.WEB_DIR) : null,
    uhppote: {
      bindAddress: env('UHPPOTE_BIND_ADDR', '0.0.0.0'),
      broadcast: env('UHPPOTE_BROADCAST', '255.255.255.255:60000'),
      listen: env('UHPPOTE_LISTEN', '0.0.0.0:60001'),
      listenerPublic: process.env.UHPPOTE_LISTENER_PUBLIC || null,
      timeoutMs: int('UHPPOTE_TIMEOUT_MS', 2500),
      retries: int('UHPPOTE_RETRIES', 1),
      debug: bool('UHPPOTE_DEBUG', false),
    },
    healthIntervalSec: int('HEALTH_INTERVAL_SEC', 15),
    collectIntervalSec: int('COLLECT_INTERVAL_SEC', 300),
    timeSyncThresholdSec: int('TIME_SYNC_THRESHOLD_SEC', 30),
    initialBackfill: int('INITIAL_BACKFILL', 5000),
    backupHour: int('BACKUP_HOUR', 2),
    backupKeep: int('BACKUP_KEEP', 14),
    mqtt: loadMqtt(),
    publicUrl: process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/+$/, '') : null,
  }
}
