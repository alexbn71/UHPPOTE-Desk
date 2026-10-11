import fs from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import websocket from '@fastify/websocket'
import { ZodError } from 'zod'
import { CodecError, NotFoundError, TimeoutError, UhppoteError } from '@uhppote-desk/protocol'
import { translate } from '@uhppote-desk/shared'
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

  /** Error body: English `error` text plus a translatable `code` (errors.*) and its `params`. */
  const fail = (status: number, code: string, params: Record<string, string | number> = {}, extra: object = {}) => ({
    status,
    body: { error: translate('en', `errors.${code}`, params), code, params, ...extra },
  })

  app.setErrorHandler((err, req, reply) => {
    const send = (r: ReturnType<typeof fail>) => reply.status(r.status).send(r.body)
    if (err instanceof ZodError) {
      return send(fail(400, 'invalidData', {}, { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }))
    }
    if (err instanceof HttpError) return send(fail(err.statusCode, err.code, err.params))
    if (err instanceof TimeoutError) return send(fail(504, 'controllerUnreachable', { detail: err.message }))
    if (err instanceof CodecError) return send(fail(400, 'controllerError', { detail: err.message }))
    if (err instanceof NotFoundError) return send(fail(404, 'controllerError', { detail: err.message }))
    if (err instanceof UhppoteError) return send(fail(502, 'controllerError', { detail: err.message }))
    const e = err as Error & { statusCode?: number; code?: string }
    if (e.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(e.message)) return send(fail(409, 'duplicate'))
    if (e.code === 'ERR_SQLITE_ERROR' && /FOREIGN KEY constraint failed/.test(e.message)) return send(fail(409, 'inUse'))
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: e.message, code: e.statusCode === 404 ? 'notFound' : 'generic', params: { status: e.statusCode } })
    }
    req.log.error(err)
    ctx.logger.error?.(`unhandled error on ${req.method} ${req.url}: ${e.stack ?? e.message}`)
    return send(fail(500, 'internal'))
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

  // Frontend (Vite build) served by the same process in production
  const webDir = ctx.config.webDir
  if (webDir && fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: translate('en', 'errors.notFound'), code: 'notFound', params: {} })
      return reply.sendFile('index.html')
    })
  }

  return app
}
