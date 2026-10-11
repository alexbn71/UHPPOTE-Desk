import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ControllerDto } from '@uhppote-desk/shared'
import { controllerInputSchema, controllerSettingsSchema, doorInputSchema, idParam, ipv4Schema, setIpSchema, zoneInputSchema } from '@uhppote-desk/shared'
import { HttpError, requireRole, type SessionUser } from '../auth/auth.js'
import type { AppContext } from '../context.js'
import type { ControllerRecord } from '../db/repos.js'
import { localDateTime } from '../util/time.js'

/** Checks that the operator may command the controller (zone restriction, sub-zones included). */
export function assertZoneAccess(ctx: AppContext, user: SessionUser, c: ControllerRecord): void {
  if (user.role === 'admin' || user.zoneIds.length === 0) return
  const zones = ctx.zones.list()
  const allowed = new Set(user.zoneIds)
  let changed = true
  while (changed) {
    changed = false
    for (const z of zones) {
      if (z.parentId !== null && allowed.has(z.parentId) && !allowed.has(z.id)) {
        allowed.add(z.id)
        changed = true
      }
    }
  }
  if (c.zoneId === null || !allowed.has(c.zoneId)) throw new HttpError(403, 'zoneForbidden')
}

export function registerControllerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }
  const operator = { preHandler: requireRole('operator') }
  const admin = { preHandler: requireRole('admin') }

  const toDto = (c: ControllerRecord): ControllerDto => {
    const { eventEpoch: _epoch, ...rest } = c
    return { ...rest, online: ctx.hub.state(c.id).online, doors: ctx.controllers.doors(c.id) }
  }

  // --- zones -----------------------------------------------------------------

  app.get('/zones', viewer, async () => ctx.zones.list())
  app.post('/zones', admin, async (req) => {
    const b = zoneInputSchema.parse(req.body)
    const id = ctx.zones.create(b.name, b.parentId)
    ctx.audit.log(req.user, 'create-zone', `zone:${id}`, b)
    return { id }
  })
  app.put('/zones/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = zoneInputSchema.parse(req.body)
    ctx.zones.update(id, b.name, b.parentId)
    ctx.audit.log(req.user, 'update-zone', `zone:${id}`, b)
    return { ok: true }
  })
  app.delete('/zones/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    ctx.zones.delete(id)
    ctx.audit.log(req.user, 'delete-zone', `zone:${id}`)
    return { ok: true }
  })

  // --- controller ------------------------------------------------------------

  app.get('/controllers', viewer, async () => ctx.controllers.list().map(toDto))

  app.get('/controllers/live', viewer, async () => ctx.controllers.list().map((c) => ctx.hub.state(c.id)))

  app.get('/controllers/:id', viewer, async (req) => {
    const { id } = idParam.parse(req.params)
    return toDto(ctx.gateway.controller(id))
  })

  app.post('/controllers', admin, async (req) => {
    const b = controllerInputSchema.parse(req.body)
    const id = ctx.controllers.create(b)
    ctx.audit.log(req.user, 'create-controller', `controller:${b.serial}`, b)
    void ctx.health.check(id)
    return { id }
  })

  app.put('/controllers/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = controllerInputSchema.parse(req.body)
    ctx.controllers.update(id, b)
    ctx.audit.log(req.user, 'update-controller', `controller:${b.serial}`, b)
    void ctx.health.check(id)
    return { ok: true }
  })

  app.delete('/controllers/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const c = ctx.gateway.controller(id)
    ctx.controllers.delete(id)
    ctx.hub.remove(id)
    ctx.audit.log(req.user, 'delete-controller', `controller:${c.serial}`)
    return { ok: true }
  })

  /** Searches the network for controllers (broadcast). */
  app.get('/discover', admin, async (req) => {
    const q = z.object({ broadcast: z.string().optional() }).parse(req.query)
    const found = await ctx.audit.track(req.user, 'discover', null, q, () => ctx.gateway.client.discover(q.broadcast))
    return found.map((f) => ({ ...f, configured: ctx.controllers.getBySerial(f.controller)?.id ?? null }))
  })

  /** Sets the controller IP (the controller does not reply: check afterwards via discovery). */
  app.post('/controllers/:id/set-ip', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = setIpSchema.parse(req.body)
    const c = ctx.gateway.controller(id)
    await ctx.gateway.run(req.user, id, 'set-ip', b, async (client) => {
      // sent by broadcast: the controller may not be reachable by unicast with its current IP
      await client.setIPv4({ id: c.serial, transport: 'udp' }, b.address, b.netmask, b.gateway)
    })
    await new Promise((r) => setTimeout(r, 1500))
    const info = await ctx.gateway.client.getController({ id: c.serial, host: b.address, port: c.port }).catch(() => null)
    if (info) ctx.controllers.setHost(id, b.address)
    return { verified: !!info, info }
  })

  /** Full diagnostics (reads only). */
  app.get('/controllers/:id/info', viewer, async (req) => {
    const { id } = idParam.parse(req.params)
    return ctx.gateway.run(req.user, id, 'read-info', null, async (client, t) => {
      const device = await client.getController(t)
      const time = await client.getTime(t)
      const status = await client.getStatus(t)
      const listener = await client.getListener(t)
      const cards = await client.getCards(t)
      const eventIndex = await client.getEventIndex(t)
      const antipassback = await client.getAntiPassback(t)
      const doors = []
      for (let d = 1; d <= 4; d++) doors.push(await client.getDoorControl(t, d))
      ctx.controllers.markSeen(id, localDateTime(), device.version)
      return { device, time, status, listener, cards, eventIndex, antipassback, doors }
    }, { audit: false })
  })

  app.post('/controllers/:id/time-sync', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    assertZoneAccess(ctx, req.user!, ctx.gateway.controller(id))
    return { time: await ctx.health.syncTime(id, req.user) }
  })

  app.post('/controllers/:id/listener', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = z.object({ address: ipv4Schema, port: z.number().int().min(1).max(65535), interval: z.number().int().min(0).max(255) }).nullable().parse(req.body ?? null)
    if (!b) return { changed: await ctx.health.ensureListener(id) }
    await ctx.gateway.run(req.user, id, 'set-listener', b, (client, t) => client.setListener(t, b))
    return { changed: true }
  })

  app.post('/controllers/:id/collect', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    return ctx.eventService.collect(id)
  })

  app.post('/controllers/:id/restore-defaults', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body)
    const c = ctx.gateway.controller(id)
    if (confirm !== String(c.serial)) throw new HttpError(400, 'confirmSerial')
    const backupCards = await ctx.gateway.run(req.user, id, 'backup-cards', null, (client, t) => client.listCards(t), { audit: false })
    const backupFile = path.join(ctx.config.dataDir, 'backups', `cards-${c.serial}-${localDateTime().replace(/[ :]/g, '-')}.json`)
    fs.mkdirSync(path.dirname(backupFile), { recursive: true })
    fs.writeFileSync(backupFile, JSON.stringify({ controller: c.serial, savedAt: localDateTime(), cards: backupCards }, null, 2))
    await ctx.gateway.run(req.user, id, 'restore-default-parameters', { cardsBackedUp: backupCards.length, backupFile }, (client, t) =>
      client.restoreDefaultParameters(t),
    )
    return { ok: true, cardsBackup: backupCards, backupFile: path.basename(backupFile) }
  })

  // --- advanced settings -----------------------------------------------------

  app.get('/controllers/:id/settings', viewer, async (req) => {
    const { id } = idParam.parse(req.params)
    ctx.gateway.controller(id)
    return ctx.controllers.settings(id)
  })

  app.put('/controllers/:id/settings', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    ctx.gateway.controller(id)
    const s = controllerSettingsSchema.parse(req.body)
    ctx.controllers.saveSettings(id, s)
    ctx.audit.log(req.user, 'update-settings', `controller:${id}`, s)
    const push = (req.query as { push?: string }).push !== 'false'
    if (push) {
      await ctx.sync.pushSettings(req.user, id)
      await ctx.health.ensureListener(id)
    }
    return { ok: true, pushed: push }
  })

  // --- doors -----------------------------------------------------------------

  app.get('/doors', viewer, async () => ctx.controllers.doors())

  app.put('/doors/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = doorInputSchema.parse(req.body)
    const door = ctx.controllers.door(id)
    if (!door) throw new HttpError(404, 'doorNotFound')
    ctx.controllers.updateDoor(id, b)
    ctx.audit.log(req.user, 'update-door', `door:${id}`, b)
    let pushError: string | null = null
    if (door.mode !== b.mode || door.delay !== b.delay) {
      try {
        await ctx.sync.pushDoor(req.user, id)
      } catch (err) {
        pushError = (err as Error).message
      }
    }
    return { ok: true, pushError }
  })

  app.post('/doors/:id/open', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const door = ctx.controllers.door(id)
    if (!door) throw new HttpError(404, 'doorNotFound')
    assertZoneAccess(ctx, req.user!, ctx.gateway.controller(door.controllerId))
    await ctx.gateway.run(req.user, door.controllerId, 'open-door', { door: door.door, name: door.name }, (client, t) => client.openDoor(t, door.door))
    return { ok: true }
  })

  // --- synchronisation -------------------------------------------------------

  app.get('/controllers/:id/sync/diff', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const { _cards, ...diff } = await ctx.sync.diff(req.user, id)
    return diff
  })

  app.post('/controllers/:id/sync/cards', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    assertZoneAccess(ctx, req.user!, ctx.gateway.controller(id))
    return ctx.sync.syncCards(req.user, id)
  })

  app.post('/controllers/:id/sync/all', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    return ctx.sync.pushAll(req.user, id)
  })

  app.get('/controllers/:id/sync/history', viewer, async (req) => {
    const { id } = idParam.parse(req.params)
    return ctx.db.all(
      `SELECT s.id, s.kind, s.started_at AS startedAt, s.finished_at AS finishedAt, s.status, s.summary, o.username AS operator
       FROM sync_runs s LEFT JOIN operators o ON o.id = s.operator_id WHERE s.controller_id = ? ORDER BY s.id DESC LIMIT 50`,
      [id],
    )
  })
}
