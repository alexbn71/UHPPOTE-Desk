/**
 * SQL migrations in order. Each entry is applied only once (schema_migrations table).
 * Do not change migrations that have been released: append new ones at the end.
 */
export const migrations: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'schema iniziale',
    sql: /* sql */ `
      CREATE TABLE zones (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id INTEGER REFERENCES zones(id) ON DELETE CASCADE
      );

      CREATE TABLE controllers (
        id INTEGER PRIMARY KEY,
        serial INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        host TEXT,
        port INTEGER NOT NULL DEFAULT 60000,
        transport TEXT NOT NULL DEFAULT 'udp' CHECK (transport IN ('udp', 'tcp')),
        zone_id INTEGER REFERENCES zones(id) ON DELETE SET NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        firmware TEXT,
        last_seen_at TEXT,
        last_collected_index INTEGER NOT NULL DEFAULT 0,
        event_epoch INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE doors (
        id INTEGER PRIMARY KEY,
        controller_id INTEGER NOT NULL REFERENCES controllers(id) ON DELETE CASCADE,
        door INTEGER NOT NULL CHECK (door BETWEEN 1 AND 4),
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        attendance INTEGER NOT NULL DEFAULT 0,
        mode INTEGER NOT NULL DEFAULT 3 CHECK (mode IN (1, 2, 3)),
        delay INTEGER NOT NULL DEFAULT 5 CHECK (delay BETWEEN 0 AND 255),
        UNIQUE (controller_id, door)
      );

      CREATE TABLE controller_settings (
        controller_id INTEGER PRIMARY KEY REFERENCES controllers(id) ON DELETE CASCADE,
        settings TEXT NOT NULL
      );

      CREATE TABLE departments (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id INTEGER REFERENCES departments(id) ON DELETE CASCADE
      );

      CREATE TABLE shifts (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        break_minutes INTEGER NOT NULL DEFAULT 60,
        tolerance_minutes INTEGER NOT NULL DEFAULT 10,
        weekdays TEXT NOT NULL DEFAULT '1111100'
      );

      CREATE TABLE people (
        id INTEGER PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        first_name TEXT NOT NULL DEFAULT '',
        last_name TEXT NOT NULL,
        department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
        email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        pin INTEGER NOT NULL DEFAULT 0 CHECK (pin BETWEEN 0 AND 999999),
        valid_from TEXT NOT NULL,
        valid_to TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
        photo BLOB,
        photo_type TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE cards (
        id INTEGER PRIMARY KEY,
        number INTEGER NOT NULL UNIQUE,
        person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lost', 'disabled')),
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE INDEX cards_person ON cards(person_id);

      CREATE TABLE time_profiles (
        id INTEGER PRIMARY KEY CHECK (id BETWEEN 2 AND 254),
        name TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT NOT NULL,
        weekdays TEXT NOT NULL,
        segments TEXT NOT NULL,
        linked_to INTEGER
      );

      CREATE TABLE permissions (
        person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        door_id INTEGER NOT NULL REFERENCES doors(id) ON DELETE CASCADE,
        profile_id INTEGER REFERENCES time_profiles(id) ON DELETE RESTRICT,
        first_card INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (person_id, door_id)
      );

      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY,
        controller_id INTEGER NOT NULL REFERENCES controllers(id) ON DELETE CASCADE,
        door INTEGER NOT NULL CHECK (door BETWEEN 1 AND 4),
        task INTEGER NOT NULL CHECK (task BETWEEN 0 AND 12),
        valid_from TEXT NOT NULL,
        valid_to TEXT NOT NULL,
        weekdays TEXT NOT NULL,
        start_time TEXT NOT NULL,
        more_cards INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        controller_id INTEGER NOT NULL REFERENCES controllers(id) ON DELETE CASCADE,
        epoch INTEGER NOT NULL DEFAULT 0,
        idx INTEGER NOT NULL,
        type INTEGER NOT NULL,
        granted INTEGER NOT NULL,
        door INTEGER NOT NULL,
        direction INTEGER NOT NULL,
        card INTEGER NOT NULL,
        person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
        timestamp TEXT,
        reason INTEGER NOT NULL,
        received_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE (controller_id, epoch, idx)
      );
      CREATE INDEX events_timestamp ON events(timestamp);
      CREATE INDEX events_person ON events(person_id, timestamp);
      CREATE INDEX events_card ON events(card);

      CREATE TABLE holidays (
        date TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );

      CREATE TABLE leaves (
        id INTEGER PRIMARY KEY,
        person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        from_date TEXT NOT NULL,
        to_date TEXT NOT NULL,
        type TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE manual_punches (
        id INTEGER PRIMARY KEY,
        person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL,
        direction INTEGER NOT NULL,
        reason TEXT NOT NULL,
        operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE operators (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
        active INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        last_login_at TEXT
      );

      CREATE TABLE operator_zones (
        operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
        zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
        PRIMARY KEY (operator_id, zone_id)
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL,
        operator_name TEXT,
        action TEXT NOT NULL,
        target TEXT,
        details TEXT,
        outcome TEXT NOT NULL DEFAULT 'ok',
        error TEXT
      );
      CREATE INDEX audit_at ON audit_log(at);

      CREATE TABLE sync_runs (
        id INTEGER PRIMARY KEY,
        controller_id INTEGER NOT NULL REFERENCES controllers(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        summary TEXT,
        operator_id INTEGER REFERENCES operators(id) ON DELETE SET NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'outgoing webhooks',
    sql: /* sql */ `
      CREATE TABLE webhooks (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        events TEXT NOT NULL,
        door_ids TEXT NOT NULL DEFAULT '[]',
        headers TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE webhook_deliveries (
        id INTEGER PRIMARY KEY,
        webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL,
        event TEXT NOT NULL,
        at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        ok INTEGER NOT NULL,
        status_code INTEGER,
        error TEXT,
        duration_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX webhook_deliveries_hook ON webhook_deliveries(webhook_id, id);
    `,
  },
  {
    id: 3,
    name: 'api tokens',
    sql: /* sql */ `
      CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        prefix TEXT NOT NULL,
        access TEXT NOT NULL CHECK (access IN ('read', 'doors', 'operator', 'admin')),
        zone_ids TEXT NOT NULL DEFAULT '[]',
        door_ids TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        created_by TEXT,
        last_used_at TEXT,
        last_used_ip TEXT
      );
    `,
  },
  {
    id: 4,
    name: 'notification channels',
    sql: /* sql */ `
      CREATE TABLE notification_channels (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('telegram', 'email', 'ntfy', 'gotify')),
        enabled INTEGER NOT NULL DEFAULT 1,
        events TEXT NOT NULL DEFAULT '[]',
        door_ids TEXT NOT NULL DEFAULT '[]',
        language TEXT NOT NULL DEFAULT 'en',
        config TEXT NOT NULL,
        daily_report INTEGER NOT NULL DEFAULT 0,
        report_hour INTEGER NOT NULL DEFAULT 20 CHECK (report_hour BETWEEN 0 AND 23),
        last_report_date TEXT,
        last_sent_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
    `,
  },
]
