import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'

export const APP_VERSION = '1.2.5'

/**
 * Entry bundle of the web build being served (e.g. `index-Dj_MWMRy.js`): it changes at every build, unlike
 * APP_VERSION, so a page opened before an update can tell that it runs an old copy. null without a web build.
 */
export function webBuild(webDir: string | null | undefined): string | null {
  if (!webDir) return null
  try {
    return /\/assets\/(index-[\w-]+\.js)/.exec(fs.readFileSync(path.join(webDir, 'index.html'), 'utf8'))?.[1] ?? null
  } catch {
    return null
  }
}

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }
  const admin = { preHandler: requireRole('admin') }

  /** Health check for Docker/monitoring (no authentication). */
  app.get('/health', async () => ({ status: 'ok', version: APP_VERSION, build: webBuild(ctx.config.webDir) }))

  app.get('/system/info', viewer, async () => {
    const counts = ctx.db.get<{ people: number; cards: number; events: number; controllers: number }>(
      `SELECT (SELECT COUNT(*) FROM people) AS people, (SELECT COUNT(*) FROM cards) AS cards,
              (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM controllers) AS controllers`,
    )
    return {
      version: APP_VERSION,
      node: process.version,
      hostname: os.hostname(),
      uptimeSec: Math.round(process.uptime()),
      interfaces: Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
        (addrs ?? [])
          .filter((a) => a.family === 'IPv4' && !a.internal)
          .map((a) => ({ name, address: a.address, netmask: a.netmask })),
      ),
      uhppote: {
        bindAddress: ctx.config.uhppote.bindAddress,
        broadcast: ctx.config.uhppote.broadcast,
        listen: ctx.config.uhppote.listen,
        listenerPublic: ctx.config.uhppote.listenerPublic,
        timeoutMs: ctx.config.uhppote.timeoutMs,
      },
      counts,
      mqtt: ctx.mqtt?.status() ?? {
        enabled: false,
        connected: false,
        broker: null,
        baseTopic: null,
        doorControl: false,
      },
    }
  })

  app.get('/system/backups', admin, async () => ctx.backup.list())

  app.post('/system/backups', admin, async (req) => {
    const file = ctx.backup.run()
    ctx.audit.log(req.user, 'backup', null, { file })
    return { ok: true }
  })
}
