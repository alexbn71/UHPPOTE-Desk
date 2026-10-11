import path from 'node:path'

export interface AppConfig {
  /** Porta HTTP dell'app web. */
  httpPort: number
  httpHost: string
  /** Directory dati (database SQLite, backup, foto). */
  dataDir: string
  /** Cookie di sessione con flag Secure (abilitare dietro HTTPS). */
  secureCookies: boolean
  sessionHours: number
  /** Password iniziale dell'utente admin (solo al primo avvio). */
  initialAdminPassword: string | null
  /** Directory con la build del frontend da servire (opzionale). */
  webDir: string | null
  uhppote: {
    /** IP locale per i socket verso i controller. */
    bindAddress: string
    /** Broadcast 'ip:porta' per la discovery. */
    broadcast: string
    /** Indirizzo 'ip:porta' su cui ricevere gli eventi. */
    listen: string
    /** IP:porta (raggiungibile dal controller) da programmare come listener; vuoto = non configurare automaticamente. */
    listenerPublic: string | null
    timeoutMs: number
    retries: number
    debug: boolean
  }
  /** Intervallo di polling dello stato controller (secondi). */
  healthIntervalSec: number
  /** Intervallo di raccolta eventi di sicurezza (secondi). */
  collectIntervalSec: number
  /** Deriva oraria oltre la quale l'ora del controller viene corretta (secondi; 0 = mai). */
  timeSyncThresholdSec: number
  /** Numero massimo di eventi storici scaricati al primo collegamento di un controller. */
  initialBackfill: number
  /** Ora del backup giornaliero (0-23; -1 = disattivato). */
  backupHour: number
  backupKeep: number
}

function env(name: string, fallback: string): string {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : v
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(env(name, String(fallback)), 10)
  if (Number.isNaN(v)) throw new Error(`variabile ${name} non numerica`)
  return v
}

function bool(name: string, fallback: boolean): boolean {
  return ['1', 'true', 'yes', 'on'].includes(env(name, String(fallback)).toLowerCase())
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(env('DATA_DIR', './data'))
  return {
    httpPort: int('HTTP_PORT', 8080),
    httpHost: env('HTTP_HOST', '0.0.0.0'),
    dataDir,
    secureCookies: bool('SECURE_COOKIES', false),
    sessionHours: int('SESSION_HOURS', 12),
    initialAdminPassword: process.env.INITIAL_ADMIN_PASSWORD || null,
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
  }
}
