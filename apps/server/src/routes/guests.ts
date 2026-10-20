import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  guestOpenSchema,
  guestPassInputSchema,
  guestTokenParam,
  idParam,
  type GuestLinkDto,
  type GuestPassDto,
} from '@uhppote-desk/shared'
import { HttpError, requireRole, type SessionUser } from '../auth/auth.js'
import type { AppContext } from '../context.js'
import { newGuestToken } from '../services/guests.js'
import { canOpenDoor } from './mobile.js'

/** Cookie that identifies the guest's browser, to bind a link to the first phone that uses it. */
export const GUEST_DEVICE_COOKIE = 'uhd_guest'
const GUEST_COOKIE_DAYS = 400

/**
 * Guest passes. Operators manage the passes of the doors they may open themselves; the guest side
 * (`/guest/:token`) needs no login: the secret link is the credential.
 */
export function registerGuestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const operator = { preHandler: requireRole('operator') }

  /** Administrators see every pass; operators those whose doors they may all open. */
  const manageable = (user: SessionUser, p: Pick<GuestPassDto, 'doorIds'>) =>
    user.role === 'admin' || p.doorIds.every((id) => !ctx.controllers.door(id) || canOpenDoor(ctx, user, id))

  const existing = (req: FastifyRequest): GuestPassDto => {
    const { id } = idParam.parse(req.params)
    const p = ctx.guests.get(id)
    if (!p || !manageable(req.user!, p)) throw new HttpError(404, 'notFound')
    return p
  }

  const assertDoors = (user: SessionUser, doorIds: number[]) => {
    for (const id of doorIds) {
      if (!ctx.controllers.door(id)) throw new HttpError(404, 'doorNotFound')
      if (!canOpenDoor(ctx, user, id)) throw new HttpError(403, 'doorForbidden')
    }
  }

  /** Address of the link: PUBLIC_URL, otherwise the page the operator is using. */
  const linkOf = (req: FastifyRequest, token: string) => {
    const origin = ctx.config.publicUrl ?? req.headers.origin ?? `${req.protocol}://${req.host}`
    return `${origin.replace(/\/+$/, '')}/g/${token}`
  }

  /** Audit details: never the PIN. */
  const details = ({ pin, ...rest }: Record<string, unknown>) => ({
    ...rest,
    pin: pin === undefined ? undefined : !!pin,
  })

  app.get('/guests', operator, async (req) => ctx.guests.list().filter((p) => manageable(req.user!, p)))

  app.post('/guests', operator, async (req): Promise<GuestLinkDto> => {
    const b = guestPassInputSchema.parse(req.body)
    assertDoors(req.user!, b.doorIds)
    const { pass, token } = await ctx.guests.create(b, req.user!.username)
    ctx.audit.log(req.user, 'create-guest', `guest:${pass.id}`, details(b))
    return { pass, token, link: linkOf(req, token) }
  })

  app.put('/guests/:id', operator, async (req) => {
    const p = existing(req)
    const b = guestPassInputSchema.parse(req.body)
    assertDoors(req.user!, b.doorIds)
    await ctx.guests.update(p.id, b)
    ctx.audit.log(req.user, 'update-guest', `guest:${p.id}`, details(b))
    return ctx.guests.get(p.id)
  })

  app.post('/guests/:id/link', operator, async (req): Promise<GuestLinkDto> => {
    const p = existing(req)
    const token = ctx.guests.newLink(p.id)
    ctx.audit.log(req.user, 'guest-new-link', `guest:${p.id}`, { name: p.name })
    return { pass: ctx.guests.get(p.id)!, token, link: linkOf(req, token) }
  })

  app.post('/guests/:id/unbind', operator, async (req) => {
    const p = existing(req)
    ctx.guests.unbind(p.id)
    ctx.audit.log(req.user, 'guest-unbind', `guest:${p.id}`, { name: p.name })
    return ctx.guests.get(p.id)
  })

  app.post('/guests/:id/revoke', operator, async (req) => {
    const p = existing(req)
    ctx.guests.revoke(p.id)
    ctx.audit.log(req.user, 'revoke-guest', `guest:${p.id}`, { name: p.name })
    return ctx.guests.get(p.id)
  })

  app.delete('/guests/:id', operator, async (req) => {
    const p = existing(req)
    ctx.guests.delete(p.id)
    ctx.audit.log(req.user, 'delete-guest', `guest:${p.id}`, { name: p.name })
    return { ok: true }
  })

  app.get('/guests/:id/opens', operator, async (req) => ctx.guests.opens(existing(req).id))

  // --- the guest side: no login -----------------------------------------------------------------------

  /** The secret of this browser, created on its first visit. */
  const deviceSecret = (req: FastifyRequest, reply: FastifyReply): string => {
    const current = req.cookies[GUEST_DEVICE_COOKIE]
    if (current && /^[A-Za-z0-9_-]{22}$/.test(current)) return current
    const secret = newGuestToken()
    void reply.setCookie(GUEST_DEVICE_COOKIE, secret, {
      path: '/api/guest',
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.config.secureCookies,
      maxAge: GUEST_COOKIE_DAYS * 86_400,
    })
    return secret
  }

  /** Nothing of the guest side may be cached, nor leak the link through the Referer. */
  const guestHeaders = (reply: FastifyReply) =>
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer')

  app.get('/guest/:token', async (req, reply) => {
    guestHeaders(reply)
    const { token } = guestTokenParam.parse(req.params)
    return ctx.guests.view(token, deviceSecret(req, reply), req.ip)
  })

  app.post('/guest/:token/doors/:doorId/open', async (req, reply) => {
    guestHeaders(reply)
    const { token, doorId } = guestTokenParam.extend({ doorId: z.coerce.number().int().positive() }).parse(req.params)
    const { pin } = guestOpenSchema.parse(req.body ?? {})
    const { pass, door } = await ctx.guests.authorize(token, doorId, deviceSecret(req, reply), pin, req.ip)
    try {
      await ctx.gateway.run(
        { id: null, username: `guest:${pass.name}` },
        door.controllerId,
        'guest-open-door',
        { door: door.door, name: door.name, guest: pass.id },
        (client, t) => client.openDoor(t, door.door),
      )
    } catch (err) {
      ctx.guests.record(pass, door, 'error', req.ip)
      throw err
    }
    ctx.guests.record(pass, door, 'ok', req.ip)
    return { ok: true }
  })
}
