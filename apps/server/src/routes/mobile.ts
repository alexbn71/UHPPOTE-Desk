import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { RegistrationResponseJSON } from '@simplewebauthn/server'
import {
  idParam,
  mobileSettingsSchema,
  pushSubscribeSchema,
  type MobileConfigDto,
  type MobileDoorDto,
} from '@uhppote-desk/shared'
import { HttpError, requireRole, type SessionUser } from '../auth/auth.js'
import { canOperateController } from '../auth/zones.js'
import type { AppContext } from '../context.js'
import type { RelyingParty } from '../services/mobile.js'

/** Host and origin the browser sees: PUBLIC_URL when set, otherwise the request (X-Forwarded-* behind a proxy). */
export function relyingParty(ctx: AppContext, req: FastifyRequest): RelyingParty {
  if (ctx.config.publicUrl) {
    const u = new URL(ctx.config.publicUrl)
    return { rpID: u.hostname, origin: u.origin }
  }
  return { rpID: req.hostname, origin: `${req.protocol}://${req.host}` }
}

/** May the user open the door? Role, door restriction (API tokens), zones. */
export function canOpenDoor(ctx: AppContext, user: SessionUser, doorId: number): boolean {
  const door = ctx.controllers.door(doorId)
  const controller = door && ctx.controllers.get(door.controllerId)
  if (!user.canOpenDoors || !door?.active || !controller?.enabled) return false
  if (user.doorIds.length > 0 && !user.doorIds.includes(door.id)) return false
  return canOperateController(ctx.zones.list(), user, controller)
}

export function registerMobileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }
  const admin = { preHandler: requireRole('admin') }

  /** The remembered device of the request (push and fingerprint/Face ID need one). */
  const deviceOf = (req: FastifyRequest): number => {
    const id = req.user?.deviceId
    if (!id) throw new HttpError(400, 'deviceRequired')
    return id
  }

  app.get('/mobile/config', viewer, async (req): Promise<MobileConfigDto> => {
    const s = ctx.mobile.settings()
    const device = req.user!.deviceId ? ctx.devices.get(req.user!.deviceId) : undefined
    return {
      ...s,
      vapidPublicKey: ctx.mobile.vapidKeys().publicKey,
      device: device
        ? {
            id: device.id,
            name: device.name,
            createdAt: device.createdAt,
            biometric: device.biometric,
            expiresAt: device.expiresAt,
            push: ctx.push.preferences(device.id),
          }
        : null,
    }
  })

  /** Active doors, with the ones the user may open first. */
  app.get('/mobile/doors', viewer, async (req): Promise<MobileDoorDto[]> => {
    const controllers = new Map(ctx.controllers.list().map((c) => [c.id, c]))
    return ctx.controllers
      .doors()
      .filter((d) => d.active && controllers.get(d.controllerId)?.enabled)
      .map((d) => ({
        id: d.id,
        controllerId: d.controllerId,
        controllerName: controllers.get(d.controllerId)!.name,
        door: d.door,
        name: d.name,
        canOpen: canOpenDoor(ctx, req.user!, d.id),
      }))
      .sort((a, b) => Number(b.canOpen) - Number(a.canOpen) || a.name.localeCompare(b.name))
  })

  // --- fingerprint / Face ID ------------------------------------------------------------------------

  app.post('/mobile/biometric/options', viewer, async (req) => {
    const deviceId = deviceOf(req)
    return ctx.mobile.registrationOptions(relyingParty(ctx, req), deviceId, req.user!)
  })

  app.post('/mobile/biometric', viewer, async (req) => {
    const deviceId = deviceOf(req)
    const { response } = z
      .object({ response: z.custom<RegistrationResponseJSON>((v) => typeof v === 'object' && v !== null) })
      .parse(req.body)
    await ctx.mobile.verifyRegistration(relyingParty(ctx, req), deviceId, response)
    ctx.audit.log(req.user, 'register-biometric', `device:${deviceId}`)
    return { ok: true }
  })

  app.delete('/mobile/biometric', viewer, async (req) => {
    const deviceId = deviceOf(req)
    ctx.mobile.removeBiometric(deviceId)
    ctx.audit.log(req.user, 'remove-biometric', `device:${deviceId}`)
    return { ok: true }
  })

  /** Challenge for opening a door with fingerprint/Face ID. */
  app.post('/mobile/doors/:id/challenge', viewer, async (req) => {
    const { id } = idParam.parse(req.params)
    const deviceId = deviceOf(req)
    if (!canOpenDoor(ctx, req.user!, id)) throw new HttpError(403, 'forbidden')
    return ctx.mobile.openOptions(relyingParty(ctx, req), deviceId, id)
  })

  // --- push notifications ----------------------------------------------------------------------------

  app.put('/mobile/push', viewer, async (req) => {
    const deviceId = deviceOf(req)
    ctx.push.subscribe(deviceId, pushSubscribeSchema.parse(req.body))
    return ctx.push.preferences(deviceId)
  })

  app.delete('/mobile/push', viewer, async (req) => {
    ctx.push.unsubscribe(deviceOf(req))
    return { ok: true }
  })

  app.post('/mobile/push/test', viewer, async (req) => {
    const error = await ctx.push.test(deviceOf(req))
    return { ok: error === null, error }
  })

  // --- administration --------------------------------------------------------------------------------

  app.get('/mobile/settings', admin, async () => ctx.mobile.settings())

  app.put('/mobile/settings', admin, async (req) => {
    const s = mobileSettingsSchema.parse(req.body)
    ctx.mobile.saveSettings(s)
    ctx.audit.log(req.user, 'update-mobile-settings', null, s)
    return s
  })

  app.get('/mobile/devices', admin, async () => ctx.devices.list())

  app.delete('/mobile/devices/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const d = ctx.devices.get(id)
    if (!d) throw new HttpError(404, 'notFound')
    ctx.devices.revoke(id)
    ctx.audit.log(req.user, 'revoke-device', `device:${id}`, { operator: d.operatorName, name: d.name })
    return { ok: true }
  })
}
