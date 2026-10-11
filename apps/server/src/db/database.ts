import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { migrations } from './migrations.js'

export type Params = Record<string, SQLInputValue> | SQLInputValue[]

/** Minimal node:sqlite wrapper with nestable transactions and typed helpers. */
export class Db {
  readonly raw: DatabaseSync
  private depth = 0

  /** Opens (and creates if missing) the SQLite database. */
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      this.raw = new DatabaseSync(file)
    } catch (err) {
      throw new Error(`cannot open the database ${file}: ${(err as Error).message} (check that the folder is writable)`, { cause: err })
    }
    this.raw.exec('PRAGMA journal_mode = WAL')
    this.raw.exec('PRAGMA foreign_keys = ON')
    this.raw.exec('PRAGMA busy_timeout = 5000')
  }

  migrate(): number[] {
    this.raw.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)')
    const applied = new Set(this.all<{ id: number }>('SELECT id FROM schema_migrations').map((r) => r.id))
    const done: number[] = []
    for (const m of migrations) {
      if (applied.has(m.id)) continue
      this.tx(() => {
        this.raw.exec(m.sql)
        this.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, datetime('now','localtime'))", [m.id, m.name])
      })
      done.push(m.id)
    }
    return done
  }

  all<T>(sql: string, params: Params = []): T[] {
    const st = this.raw.prepare(sql)
    return (Array.isArray(params) ? st.all(...params) : st.all(params)) as T[]
  }

  get<T>(sql: string, params: Params = []): T | undefined {
    const st = this.raw.prepare(sql)
    return (Array.isArray(params) ? st.get(...params) : st.get(params)) as T | undefined
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
    const st = this.raw.prepare(sql)
    const r = Array.isArray(params) ? st.run(...params) : st.run(params)
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  /** Runs fn in a transaction (or a savepoint when nested). */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth}`
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`)
    this.depth++
    try {
      const result = fn()
      this.depth--
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`)
      return result
    } catch (err) {
      this.depth--
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`)
      throw err
    }
  }

  /** Consistent copy of the database (VACUUM INTO). */
  backup(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (fs.existsSync(file)) fs.rmSync(file)
    this.raw.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
  }

  close(): void {
    this.raw.close()
  }
}

export const toBool = (v: unknown): boolean => v === 1 || v === true
export const fromBool = (v: boolean): number => (v ? 1 : 0)
export const weekdaysToString = (w: boolean[]): string => w.map((d) => (d ? '1' : '0')).join('')
export const weekdaysFromString = (s: string): boolean[] => [...s.padEnd(7, '0')].slice(0, 7).map((c) => c === '1')
