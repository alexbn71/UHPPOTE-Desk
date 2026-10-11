import os from 'node:os'
import type { FastifyInstance } from 'fastify'
import { requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'

export const APP_VERSION = '0.1.0'

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }
  const admin = { preHandler: requireRole('admin') }

  /** Health check per Docker/monitoraggio (nessuna autenticazione). */
  app.get('/health', async () => ({ status: 'ok', version: APP_VERSION }))

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
        (addrs ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address, netmask: a.netmask })),
      ),
      uhppote: {
        bindAddress: ctx.config.uhppote.bindAddress,
        broadcast: ctx.config.uhppote.broadcast,
        listen: ctx.config.uhppote.listen,
        listenerPublic: ctx.config.uhppote.listenerPublic,
        timeoutMs: ctx.config.uhppote.timeoutMs,
      },
      counts,
    }
  })

  app.get('/system/backups', admin, async () => ctx.backup.list())

  app.post('/system/backups', admin, async (req) => {
    const file = ctx.backup.run()
    ctx.audit.log(req.user, 'backup', null, { file })
    return { ok: true }
  })
}
