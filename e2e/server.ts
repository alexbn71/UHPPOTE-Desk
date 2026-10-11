/**
 * Server per i test E2E: FakeController + backend con database nuovo + frontend compilato.
 * Espone /__sim/* (solo qui) per simulare azioni fisiche sul controller.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FakeController } from '@uhppote-desk/protocol/testing'
import { buildApp } from '../apps/server/src/app.js'
import { createContext } from '../apps/server/src/context.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhppote-desk-e2e-'))
const fake = new FakeController({ id: 405419896, host: '127.0.0.1', port: 60020 })
await fake.start()

const ctx = createContext(
  {
    httpPort: 8090,
    httpHost: '127.0.0.1',
    dataDir,
    secureCookies: false,
    sessionHours: 1,
    initialAdminPassword: 'admin-e2e-iniziale',
    webDir: path.resolve('apps/web/dist'),
    uhppote: {
      bindAddress: '127.0.0.1',
      broadcast: '127.0.0.1:60020',
      listen: '127.0.0.1:60021',
      listenerPublic: '127.0.0.1:60021',
      timeoutMs: 800,
      retries: 1,
      debug: false,
    },
    healthIntervalSec: 2,
    collectIntervalSec: 3600,
    timeSyncThresholdSec: 30,
    initialBackfill: 1000,
    backupHour: -1,
    backupKeep: 3,
  },
  { info: () => undefined, warn: () => undefined, error: (m) => console.error(m) },
)
await ctx.auth.bootstrap('admin-e2e-iniziale')
await ctx.eventService.startListener()
ctx.health.start()

const app = await buildApp(ctx)
app.post('/__sim/swipe', async (req) => {
  const { card, door } = req.body as { card: number; door: number }
  return fake.swipe(card, door)
})
app.get('/__sim/cards', async () => fake.cards)
await app.listen({ port: 8090, host: '127.0.0.1' })
console.log('server E2E pronto su http://127.0.0.1:8090')

const stop = async () => {
  ctx.health.stop()
  await ctx.eventService.stopListener()
  await app.close()
  await fake.stop()
  ctx.db.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
