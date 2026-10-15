import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { idParam, taskInputSchema, timeProfileInputSchema } from '@uhppote-desk/shared'
import { HttpError, requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'
import { requestErrorText } from '../util/lang.js'

export function registerScheduleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }
  const admin = { preHandler: requireRole('admin') }

  /** Sends the time profiles to all active controllers; returns the errors per controller. */
  const pushProfilesEverywhere = async (req: FastifyRequest) => {
    const errors: { controllerId: number; error: string }[] = []
    for (const c of ctx.controllers.list().filter((x) => x.enabled)) {
      try {
        await ctx.sync.pushTimeProfiles(req.user, c.id)
      } catch (err) {
        errors.push({ controllerId: c.id, error: requestErrorText(req, err) })
      }
    }
    return errors
  }

  // --- time profiles ---------------------------------------------------------

  app.get('/time-profiles', viewer, async () => ctx.schedule.profiles())

  app.put('/time-profiles/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = timeProfileInputSchema.parse({ ...(req.body as object), id })
    if (b.validFrom > b.validTo) throw new HttpError(400, 'dateOrder')
    for (const s of b.segments) if (s.start >= s.end) throw new HttpError(400, 'invalidSegment', { start: s.start, end: s.end })
    if (b.linkedTo !== null) {
      if (b.linkedTo === id) throw new HttpError(400, 'selfLink')
      if (!ctx.schedule.profile(b.linkedTo)) throw new HttpError(400, 'linkedMissing', { id: b.linkedTo })
    }
    ctx.schedule.saveProfile(b)
    ctx.audit.log(req.user, 'save-time-profile', `profile:${id}`, b)
    return { ok: true, pushErrors: await pushProfilesEverywhere(req) }
  })

  app.delete('/time-profiles/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const used = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM permissions WHERE profile_id = ?', [id])!.n
    if (used > 0) throw new HttpError(409, 'profileInUse', { n: used })
    const linked = ctx.schedule.profiles().filter((p) => p.linkedTo === id)
    if (linked.length) throw new HttpError(409, 'profileLinked', { ids: linked.map((p) => p.id).join(', ') })
    ctx.schedule.deleteProfile(id)
    ctx.audit.log(req.user, 'delete-time-profile', `profile:${id}`)
    return { ok: true, pushErrors: await pushProfilesEverywhere(req) }
  })

  app.post('/time-profiles/push', admin, async (req) => ({ pushErrors: await pushProfilesEverywhere(req) }))

  // --- task ------------------------------------------------------------------

  app.get('/tasks', viewer, async (req) => {
    const q = z.object({ controllerId: z.coerce.number().int().optional() }).parse(req.query)
    return ctx.schedule.tasks(q.controllerId)
  })

  const pushTasks = async (req: FastifyRequest, controllerId: number) => {
    try {
      await ctx.sync.pushTasks(req.user, controllerId)
      return null
    } catch (err) {
      return requestErrorText(req, err)
    }
  }

  app.post('/tasks', admin, async (req) => {
    const b = taskInputSchema.parse(req.body)
    ctx.gateway.controller(b.controllerId)
    const id = ctx.schedule.saveTask(b)
    ctx.audit.log(req.user, 'create-task', `task:${id}`, b)
    return { id, pushError: await pushTasks(req, b.controllerId) }
  })

  app.put('/tasks/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = taskInputSchema.parse(req.body)
    const old = ctx.schedule.tasks().find((t) => t.id === id)
    if (!old) throw new HttpError(404, 'taskNotFound')
    ctx.schedule.saveTask(b, id)
    ctx.audit.log(req.user, 'update-task', `task:${id}`, b)
    const errors = [await pushTasks(req, b.controllerId)]
    if (old.controllerId !== b.controllerId) errors.push(await pushTasks(req, old.controllerId))
    return { ok: true, pushError: errors.filter(Boolean).join('; ') || null }
  })

  app.delete('/tasks/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const old = ctx.schedule.tasks().find((t) => t.id === id)
    if (!old) throw new HttpError(404, 'taskNotFound')
    ctx.schedule.deleteTask(id)
    ctx.audit.log(req.user, 'delete-task', `task:${id}`)
    return { ok: true, pushError: await pushTasks(req, old.controllerId) }
  })
}
