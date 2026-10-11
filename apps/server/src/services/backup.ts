import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '@uhppote-desk/protocol'
import type { Db } from '../db/database.js'

/** Backup giornaliero del database SQLite con rotazione. */
export class BackupService {
  private timer: NodeJS.Timeout | null = null
  private lastDay = ''

  constructor(
    private readonly db: Db,
    private readonly dir: string,
    private readonly opts: { hour: number; keep: number; logger?: Logger | undefined },
  ) {}

  start(): void {
    if (this.opts.hour < 0) return
    this.timer = setInterval(() => {
      const now = new Date()
      const day = now.toISOString().slice(0, 10)
      if (now.getHours() === this.opts.hour && day !== this.lastDay) {
        this.lastDay = day
        try {
          this.run()
        } catch (err) {
          this.opts.logger?.error?.(`backup failed: ${(err as Error).message}`)
        }
      }
    }, 60_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  run(): string {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const file = path.join(this.dir, `uhppote-desk-${stamp}.sqlite`)
    this.db.backup(file)
    this.rotate()
    this.opts.logger?.info?.(`backup created: ${file}`)
    return file
  }

  list(): { name: string; size: number; createdAt: string }[] {
    if (!fs.existsSync(this.dir)) return []
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.sqlite'))
      .map((name) => {
        const st = fs.statSync(path.join(this.dir, name))
        return { name, size: st.size, createdAt: st.mtime.toISOString() }
      })
      .sort((a, b) => b.name.localeCompare(a.name))
  }

  private rotate(): void {
    for (const old of this.list().slice(this.opts.keep)) fs.rmSync(path.join(this.dir, old.name))
  }
}
