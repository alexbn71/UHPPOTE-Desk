import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  idParam,
  plateInputSchema,
  plateReadQuerySchema,
  plateReaderInputSchema,
  type PlateReaderKeyDto,
} from '@uhppote-desk/shared'
import { HttpError, requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'

/** What a plate reader sends: the key and the readings, in the query string (AgentDVR "Call URL") or a JSON body. */
const readSchema = z.object({
  key: z.string().max(200).optional(),
  plate: z.string().max(500).default(''),
})

/**
 * Licence plates and plate readers. People's plates are managed by operators, the readers by administrators;
 * the readers themselves call `/plates/read` and `/plates/agentdvr.csv` with their secret key (no login).
 */
export function registerPlateRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }
  const operator = { preHandler: requireRole('operator') }
  const admin = { preHandler: requireRole('admin') }

  // --- plates of people ---------------------------------------------------------------------------------

  app.get('/plates', viewer, async (req) => {
    const { personId } = z.object({ personId: z.coerce.number().int().positive().optional() }).parse(req.query)
    return ctx.plates.plates({ personId })
  })

  app.post('/plates', operator, async (req) => {
    const b = plateInputSchema.parse(req.body)
    if (!ctx.people.get(b.personId)) throw new HttpError(404, 'personNotFound')
    const plate = ctx.plates.addPlate(b.personId, b.plate, b.note)
    ctx.audit.log(req.user, 'create-plate', `plate:${plate.id}`, b)
    return plate
  })

  app.delete('/plates/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const p = ctx.plates.plate(id)
    // the plates of a guest are edited with the pass
    if (!p || p.personId === null) throw new HttpError(404, 'notFound')
    ctx.plates.deletePlate(id)
    ctx.audit.log(req.user, 'delete-plate', `plate:${id}`, { plate: p.plate, personId: p.personId })
    return { ok: true }
  })

  // --- readings -----------------------------------------------------------------------------------------

  app.get('/plates/reads', viewer, async (req) => ctx.plates.reads(plateReadQuerySchema.parse(req.query)))

  app.get('/plates/reads/:id/photo', viewer, async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const photo = ctx.plates.photo(id)
    if (!photo) throw new HttpError(404, 'noPhoto')
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=86400').send(photo)
  })

  // --- readers ------------------------------------------------------------------------------------------

  const existingReader = (req: FastifyRequest) => {
    const { id } = idParam.parse(req.params)
    const r = ctx.plates.reader(id)
    if (!r) throw new HttpError(404, 'notFound')
    return r
  }
  const assertDoor = (doorId: number) => {
    if (!ctx.controllers.door(doorId)) throw new HttpError(404, 'doorNotFound')
  }

  app.get('/plate-readers', admin, async () => ctx.plates.readers())

  /** The key is returned only here and by /key, once. */
  app.post('/plate-readers', admin, async (req): Promise<PlateReaderKeyDto> => {
    const b = plateReaderInputSchema.parse(req.body)
    assertDoor(b.doorId)
    const created = ctx.plates.createReader(b)
    ctx.audit.log(req.user, 'create-plate-reader', `plate-reader:${created.reader.id}`, {
      ...b,
      keyPrefix: created.reader.keyPrefix,
    })
    return created
  })

  app.put('/plate-readers/:id', admin, async (req) => {
    const r = existingReader(req)
    const b = plateReaderInputSchema.parse(req.body)
    assertDoor(b.doorId)
    ctx.plates.updateReader(r.id, b)
    ctx.audit.log(req.user, 'update-plate-reader', `plate-reader:${r.id}`, b)
    return ctx.plates.reader(r.id)
  })

  app.post('/plate-readers/:id/key', admin, async (req): Promise<PlateReaderKeyDto> => {
    const r = existingReader(req)
    const key = ctx.plates.newReaderKey(r.id)
    const reader = ctx.plates.reader(r.id)!
    ctx.audit.log(req.user, 'plate-reader-new-key', `plate-reader:${r.id}`, { keyPrefix: reader.keyPrefix })
    return { reader, key }
  })

  app.delete('/plate-readers/:id', admin, async (req) => {
    const r = existingReader(req)
    ctx.plates.deleteReader(r.id)
    ctx.audit.log(req.user, 'delete-plate-reader', `plate-reader:${r.id}`, { name: r.name })
    return { ok: true }
  })

  // --- called by the readers: the key is the credential ------------------------------------------------

  const keyOf = (req: FastifyRequest, bodyKey: string | undefined) => {
    const header = req.headers['x-reader-key']
    return typeof header === 'string' ? header : bodyKey
  }

  const read = async (req: FastifyRequest) => {
    const q = readSchema.parse({ ...(req.query as object), ...((req.body as object | undefined) ?? {}) })
    return ctx.plates.read(keyOf(req, q.key), q.plate, req.ip)
  }
  app.get('/plates/read', read)
  app.post('/plates/read', read)

  /** The known plates on one line, comma-separated: the "Plates" list of AgentDVR (reloaded periodically). */
  app.get('/plates/agentdvr.csv', async (req, reply) => {
    const q = readSchema.parse(req.query)
    ctx.plates.readerByKey(keyOf(req, q.key), req.ip)
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(ctx.plates.knownPlates().join(','))
  })
}
