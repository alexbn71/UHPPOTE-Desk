import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { idParam, taskInputSchema, timeProfileInputSchema } from '@uhppote-desk/shared'
import { HttpError, requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'

export function registerScheduleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }
  const admin = { preHandler: requireRole('admin') }

  /** Invia le fasce orarie a tutti i controller attivi; restituisce gli errori per controller. */
  const pushProfilesEverywhere = async (actor: Parameters<typeof ctx.sync.pushTimeProfiles>[0]) => {
    const errors: { controllerId: number; error: string }[] = []
    for (const c of ctx.controllers.list().filter((x) => x.enabled)) {
      try {
        await ctx.sync.pushTimeProfiles(actor, c.id)
      } catch (err) {
        errors.push({ controllerId: c.id, error: (err as Error).message })
      }
    }
    return errors
  }

  // --- fasce orarie ----------------------------------------------------------

  app.get('/time-profiles', viewer, async () => ctx.schedule.profiles())

  app.put('/time-profiles/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = timeProfileInputSchema.parse({ ...(req.body as object), id })
    if (b.validFrom > b.validTo) throw new HttpError(400, 'La data di inizio deve precedere la data di fine')
    for (const s of b.segments) if (s.start >= s.end) throw new HttpError(400, `Segmento non valido: ${s.start}-${s.end}`)
    if (b.linkedTo !== null) {
      if (b.linkedTo === id) throw new HttpError(400, 'Un profilo non può essere collegato a sé stesso')
      if (!ctx.schedule.profile(b.linkedTo)) throw new HttpError(400, `Il profilo collegato ${b.linkedTo} non esiste`)
    }
    ctx.schedule.saveProfile(b)
    ctx.audit.log(req.user, 'save-time-profile', `profile:${id}`, b)
    return { ok: true, pushErrors: await pushProfilesEverywhere(req.user) }
  })

  app.delete('/time-profiles/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const used = ctx.db.get<{ n: number }>('SELECT COUNT(*) n FROM permissions WHERE profile_id = ?', [id])!.n
    if (used > 0) throw new HttpError(409, `Fascia oraria usata in ${used} permessi: rimuoverli prima di eliminarla`)
    const linked = ctx.schedule.profiles().filter((p) => p.linkedTo === id)
    if (linked.length) throw new HttpError(409, `Fascia oraria collegata da: ${linked.map((p) => p.id).join(', ')}`)
    ctx.schedule.deleteProfile(id)
    ctx.audit.log(req.user, 'delete-time-profile', `profile:${id}`)
    return { ok: true, pushErrors: await pushProfilesEverywhere(req.user) }
  })

  app.post('/time-profiles/push', admin, async (req) => ({ pushErrors: await pushProfilesEverywhere(req.user) }))

  // --- task ------------------------------------------------------------------

  app.get('/tasks', viewer, async (req) => {
    const q = z.object({ controllerId: z.coerce.number().int().optional() }).parse(req.query)
    return ctx.schedule.tasks(q.controllerId)
  })

  const pushTasks = async (actor: Parameters<typeof ctx.sync.pushTasks>[0], controllerId: number) => {
    try {
      await ctx.sync.pushTasks(actor, controllerId)
      return null
    } catch (err) {
      return (err as Error).message
    }
  }

  app.post('/tasks', admin, async (req) => {
    const b = taskInputSchema.parse(req.body)
    ctx.gateway.controller(b.controllerId)
    const id = ctx.schedule.saveTask(b)
    ctx.audit.log(req.user, 'create-task', `task:${id}`, b)
    return { id, pushError: await pushTasks(req.user, b.controllerId) }
  })

  app.put('/tasks/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = taskInputSchema.parse(req.body)
    const old = ctx.schedule.tasks().find((t) => t.id === id)
    if (!old) throw new HttpError(404, 'Task non trovato')
    ctx.schedule.saveTask(b, id)
    ctx.audit.log(req.user, 'update-task', `task:${id}`, b)
    const errors = [await pushTasks(req.user, b.controllerId)]
    if (old.controllerId !== b.controllerId) errors.push(await pushTasks(req.user, old.controllerId))
    return { ok: true, pushError: errors.filter(Boolean).join('; ') || null }
  })

  app.delete('/tasks/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params)
    const old = ctx.schedule.tasks().find((t) => t.id === id)
    if (!old) throw new HttpError(404, 'Task non trovato')
    ctx.schedule.deleteTask(id)
    ctx.audit.log(req.user, 'delete-task', `task:${id}`)
    return { ok: true, pushError: await pushTasks(req.user, old.controllerId) }
  })
}
