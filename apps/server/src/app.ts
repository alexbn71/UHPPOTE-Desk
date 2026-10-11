import fs from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import { ZodError } from 'zod'
import { CodecError, NotFoundError, TimeoutError, UhppoteError } from '@uhppote-desk/protocol'
import { HttpError, SESSION_COOKIE } from './auth/auth.js'
import type { AppContext } from './context.js'
import { registerAttendanceRoutes } from './routes/attendance.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerControllerRoutes } from './routes/controllers.js'
import { registerEventRoutes } from './routes/events.js'
import { registerPeopleRoutes } from './routes/people.js'
import { registerScheduleRoutes } from './routes/schedule.js'
import { registerSystemRoutes } from './routes/system.js'

export async function buildApp(ctx: AppContext, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  })

  await app.register(cookie)
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } })
  await app.register(websocket)

  app.decorateRequest('user', null)
  app.addHook('onRequest', async (req) => {
    req.user = ctx.auth.resolve(req.cookies[SESSION_COOKIE])
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'Dati non validi', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) })
    }
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message })
    if (err instanceof TimeoutError) return reply.status(504).send({ error: `Controller non raggiungibile: ${err.message}` })
    if (err instanceof CodecError) return reply.status(400).send({ error: err.message })
    if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message })
    if (err instanceof UhppoteError) return reply.status(502).send({ error: err.message })
    const e = err as Error & { statusCode?: number; code?: string }
    if (e.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(e.message)) {
      return reply.status(409).send({ error: 'Elemento già esistente (valore duplicato)' })
    }
    if (e.code === 'ERR_SQLITE_ERROR' && /FOREIGN KEY constraint failed/.test(e.message)) {
      return reply.status(409).send({ error: "Impossibile completare l'operazione: l'elemento è in uso" })
    }
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message })
    req.log.error(err)
    ctx.logger.error?.(`errore non gestito su ${req.method} ${req.url}: ${e.stack ?? e.message}`)
    return reply.status(500).send({ error: 'Errore interno del server' })
  })

  await app.register(
    async (api) => {
      registerAuthRoutes(api, ctx)
      registerControllerRoutes(api, ctx)
      registerPeopleRoutes(api, ctx)
      registerScheduleRoutes(api, ctx)
      registerEventRoutes(api, ctx)
      registerAttendanceRoutes(api, ctx)
      registerSystemRoutes(api, ctx)
    },
    { prefix: '/api' },
  )

  // Frontend (build Vite) servito dallo stesso processo in produzione
  const webDir = ctx.config.webDir
  if (webDir && fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Risorsa non trovata' })
      return reply.sendFile('index.html')
    })
  }

  return app
}
