import fs from 'node:fs'
import type { Logger } from '@uhppote-desk/protocol'
import { buildApp } from './app.js'

// optional configuration from a .env file (development); variables already set take precedence
const envFile = process.env.ENV_FILE ?? '.env'
if (fs.existsSync(envFile)) process.loadEnvFile(envFile)
import { loadConfig } from './config.js'
import { createContext } from './context.js'

const level = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
const levels = ['debug', 'info', 'warn', 'error']
const enabled = (l: string) => levels.indexOf(l) >= levels.indexOf(level)
const stamp = () => new Date().toISOString()

const logger: Logger = {
  debug: enabled('debug') ? (m) => console.debug(`${stamp()} DEBUG ${m}`) : () => undefined,
  info: enabled('info') ? (m) => console.info(`${stamp()} INFO  ${m}`) : () => undefined,
  warn: enabled('warn') ? (m) => console.warn(`${stamp()} WARN  ${m}`) : () => undefined,
  error: (m) => console.error(`${stamp()} ERROR ${m}`),
}

async function main(): Promise<void> {
  const config = loadConfig()
  const ctx = createContext(config, logger)

  const admin = await ctx.auth.bootstrap(config.initialAdminPassword)
  if (admin.created) {
    logger.warn!(
      admin.password
        ? `Created user 'admin' with temporary password: ${admin.password} (must be changed at first login)`
        : `Created user 'admin' with the password from INITIAL_ADMIN_PASSWORD (must be changed at first login)`,
    )
  }

  const app = await buildApp(ctx, { logger: level === 'debug' })

  try {
    const addr = await ctx.eventService.startListener()
    logger.info!(`UHPPOTE event listener listening on ${addr.address}:${addr.port}`)
  } catch (err) {
    logger.error!(`cannot start the event listener: ${(err as Error).message} — events will be collected by polling only`)
  }
  if (!config.uhppote.listenerPublic) {
    logger.warn!('UHPPOTE_LISTENER_PUBLIC not set: the controllers\' event listener will not be configured automatically')
  }

  ctx.health.start()
  ctx.backup.start()
  const collectTimer = setInterval(() => {
    for (const c of ctx.controllers.list().filter((x) => x.enabled && ctx.hub.state(x.id).online)) {
      ctx.eventService.collect(c.id).catch((err) => logger.warn!(`event collection ${c.serial}: ${(err as Error).message}`))
    }
    ctx.auth.purgeExpired()
  }, config.collectIntervalSec * 1000)

  await app.listen({ port: config.httpPort, host: config.httpHost })
  logger.info!(`UHPPOTE Desk listening on http://${config.httpHost}:${config.httpPort} (data: ${config.dataDir})`)

  const shutdown = async (signal: string) => {
    logger.info!(`received ${signal}, shutting down…`)
    clearInterval(collectTimer)
    ctx.health.stop()
    ctx.backup.stop()
    await ctx.eventService.stopListener()
    await app.close()
    ctx.db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.error!(`startup failed: ${(err as Error).stack ?? err}`)
  process.exit(1)
})
