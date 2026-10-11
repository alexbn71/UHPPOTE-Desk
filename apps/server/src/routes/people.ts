import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { isValidWiegand26 } from '@uhppote-desk/protocol'
import {
  bulkPermissionsSchema,
  cardInputSchema,
  departmentInputSchema,
  idParam,
  personInputSchema,
  personPermissionsSchema,
  replaceCardSchema,
  translate,
} from '@uhppote-desk/shared'
import { HttpError, requireRole } from '../auth/auth.js'
import type { AppContext } from '../context.js'
import { parseCsv } from '../util/csv.js'
import { addDays, localDate, localDateTime } from '../util/time.js'

/** Error on one row of a CSV import; `code` is a key under `errors.*`. */
class ImportRowError extends Error {
  constructor(
    readonly code: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(translate('en', `errors.${code}`, params))
  }
}

export function registerPeopleRoutes(app: FastifyInstance, ctx: AppContext): void {
  const viewer = { preHandler: requireRole('viewer') }
  const operator = { preHandler: requireRole('operator') }

  /** Propaga ai controller le modifiche di una persona; gli errori non bloccano il salvataggio. */
  const push = async (actor: Parameters<typeof ctx.sync.pushPerson>[0], personId: number | null, removed: number[] = []) => {
    const results = await ctx.sync.pushPerson(actor, personId, removed)
    return results.filter((r) => r.error).map((r) => ({ controllerId: r.controllerId, error: r.error! }))
  }

  // --- reparti ---------------------------------------------------------------

  app.get('/departments', viewer, async () => ctx.departments.list())
  app.post('/departments', operator, async (req) => {
    const b = departmentInputSchema.parse(req.body)
    const id = ctx.departments.create(b.name, b.parentId)
    ctx.audit.log(req.user, 'create-department', `department:${id}`, b)
    return { id }
  })
  app.put('/departments/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = departmentInputSchema.parse(req.body)
    ctx.departments.update(id, b.name, b.parentId)
    ctx.audit.log(req.user, 'update-department', `department:${id}`, b)
    return { ok: true }
  })
  app.delete('/departments/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    ctx.departments.delete(id)
    ctx.audit.log(req.user, 'delete-department', `department:${id}`)
    return { ok: true }
  })

  // --- persone ---------------------------------------------------------------

  app.get('/people', viewer, async (req) => {
    const q = z
      .object({
        search: z.string().optional(),
        departmentId: z.coerce.number().int().optional(),
        active: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query)
    return ctx.people.list({ search: q.search, departmentId: q.departmentId, active: q.active === undefined ? undefined : q.active === 'true' })
  })

  app.get('/people/:id', viewer, async (req) => {
    const { id } = idParam.parse(req.params)
    const p = ctx.people.get(id)
    if (!p) throw new HttpError(404, 'personNotFound')
    return { ...p, permissions: ctx.people.permissions(id) }
  })

  app.post('/people', operator, async (req) => {
    const b = personInputSchema.parse(req.body)
    const id = ctx.people.create(b)
    ctx.audit.log(req.user, 'create-person', `person:${id}`, { code: b.code, name: `${b.lastName} ${b.firstName}` })
    return { id }
  })

  app.put('/people/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = personInputSchema.parse(req.body)
    if (!ctx.people.update(id, b)) throw new HttpError(404, 'personNotFound')
    ctx.audit.log(req.user, 'update-person', `person:${id}`, { code: b.code, active: b.active, validFrom: b.validFrom, validTo: b.validTo })
    return { ok: true, pushErrors: await push(req.user, id) }
  })

  app.delete('/people/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const p = ctx.people.get(id)
    if (!p) throw new HttpError(404, 'personNotFound')
    const cards = p.cards.map((c) => c.number)
    ctx.db.tx(() => {
      for (const c of p.cards) ctx.people.deleteCard(c.id)
      ctx.people.delete(id)
    })
    ctx.audit.log(req.user, 'delete-person', `person:${id}`, { code: p.code, cards })
    return { ok: true, pushErrors: await push(req.user, null, cards) }
  })

  app.put('/people/:id/photo', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const file = await req.file()
    if (!file) throw new HttpError(400, 'noFile')
    if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) throw new HttpError(400, 'unsupportedImage')
    ctx.people.setPhoto(id, await file.toBuffer(), file.mimetype)
    return { ok: true }
  })

  app.delete('/people/:id/photo', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    ctx.people.setPhoto(id, null, null)
    return { ok: true }
  })

  app.get('/people/:id/photo', viewer, async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const photo = ctx.people.photo(id)
    if (!photo) throw new HttpError(404, 'noPhoto')
    return reply.header('Cache-Control', 'private, max-age=60').type(photo.type).send(photo.data)
  })

  // --- permessi --------------------------------------------------------------

  app.get('/permissions', viewer, async () => ctx.people.permissions())

  app.put('/people/:id/permissions', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = personPermissionsSchema.parse(req.body)
    if (!ctx.people.get(id)) throw new HttpError(404, 'personNotFound')
    ctx.people.setPermissions(id, b.permissions)
    ctx.audit.log(req.user, 'set-permissions', `person:${id}`, b.permissions)
    return { ok: true, pushErrors: await push(req.user, id) }
  })

  app.post('/permissions/bulk', operator, async (req) => {
    const b = bulkPermissionsSchema.parse(req.body)
    ctx.db.tx(() => {
      for (const p of b.personIds) {
        for (const d of b.doorIds) {
          if (b.action === 'grant') ctx.people.grant(p, d, b.profileId)
          else ctx.people.revoke(p, d)
        }
      }
    })
    ctx.audit.log(req.user, `bulk-${b.action}`, null, b)
    const errors = []
    for (const p of b.personIds) errors.push(...(await push(req.user, p)))
    return { ok: true, pushErrors: errors }
  })

  // --- tessere ---------------------------------------------------------------

  app.get('/cards', viewer, async (req) => {
    const q = z.object({ unassigned: z.enum(['true', 'false']).optional(), search: z.string().optional() }).parse(req.query)
    return ctx.people.cards({ unassigned: q.unassigned === 'true', ...(q.search ? { search: q.search } : {}) })
  })

  /** Tessere passate di recente e non registrate (per l'acquisizione da lettore). */
  app.get('/cards/unknown', operator, async (req) => {
    const q = z.object({ minutes: z.coerce.number().int().min(1).max(1440).default(10) }).parse(req.query)
    return ctx.events.latestUnknownCards(localDateTime(new Date(Date.now() - q.minutes * 60_000)))
  })

  app.post('/cards', operator, async (req) => {
    const b = cardInputSchema.parse(req.body)
    if (!isValidWiegand26(b.number)) throw new HttpError(400, 'invalidWiegand')
    const id = ctx.people.createCard(b.number, b.personId, b.status)
    ctx.audit.log(req.user, 'create-card', `card:${b.number}`, b)
    return { id, pushErrors: b.personId ? await push(req.user, b.personId) : [] }
  })

  app.put('/cards/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = cardInputSchema.parse(req.body)
    const old = ctx.people.card(id)
    if (!old) throw new HttpError(404, 'cardNotFound')
    if (old.number !== b.number) throw new HttpError(400, 'cardNumberImmutable')
    ctx.people.updateCard(id, b.personId, b.status)
    ctx.audit.log(req.user, 'update-card', `card:${b.number}`, b)
    // tessera disattivata o non più assegnata: va rimossa; altrimenti segue i permessi del (nuovo) titolare
    const removed = b.status !== 'active' || b.personId === null ? [b.number] : []
    return { ok: true, pushErrors: await push(req.user, b.personId, removed) }
  })

  app.delete('/cards/:id', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const card = ctx.people.card(id)
    if (!card) throw new HttpError(404, 'cardNotFound')
    ctx.people.deleteCard(id)
    ctx.audit.log(req.user, 'delete-card', `card:${card.number}`)
    return { ok: true, pushErrors: await push(req.user, null, [card.number]) }
  })

  /** Tessera smarrita: la vecchia viene marcata "lost" e rimossa dai controller, la nuova assegnata alla stessa persona. */
  app.post('/cards/:id/replace', operator, async (req) => {
    const { id } = idParam.parse(req.params)
    const b = replaceCardSchema.parse(req.body)
    const old = ctx.people.card(id)
    if (!old) throw new HttpError(404, 'cardNotFound')
    if (!isValidWiegand26(b.newNumber)) throw new HttpError(400, 'invalidWiegand')
    const newId = ctx.db.tx(() => {
      ctx.people.updateCard(id, old.personId, 'lost')
      return ctx.people.createCard(b.newNumber, old.personId, 'active')
    })
    ctx.audit.log(req.user, 'replace-card', `card:${old.number}`, { newNumber: b.newNumber, personId: old.personId })
    return { id: newId, pushErrors: await push(req.user, old.personId, [old.number]) }
  })

  // --- import CSV --------------------------------------------------------------

  /**
   * Import anagrafica: colonne (con intestazione) matricola; cognome; nome; tessera; reparto.
   * Il reparto può essere un percorso separato da "\" (es. "Vendite\Estero"), come nel software originale.
   */
  app.post('/people/import', operator, async (req) => {
    const file = await req.file()
    if (!file) throw new HttpError(400, 'noFile')
    const rows = parseCsv((await file.toBuffer()).toString('utf8'))
    if (rows.length < 2) throw new HttpError(400, 'emptyFile')
    const header = rows[0]!.map((h) => h.trim().toLowerCase())
    const col = (...names: string[]) => header.findIndex((h) => names.includes(h))
    const cCode = col('matricola', 'codice', 'code', 'consumer no', 'user no')
    const cLast = col('cognome', 'lastname', 'last name', 'name', 'nome completo')
    const cFirst = col('nome', 'firstname', 'first name')
    const cCard = col('tessera', 'card', 'card id', 'card number')
    const cDept = col('reparto', 'department', 'dipartimento')
    if (cCode < 0 || cLast < 0) throw new HttpError(400, 'missingColumns')

    const report = { created: 0, updated: 0, cards: 0, errors: [] as { row: number; error: string; code?: string; params?: Record<string, string | number> }[] }
    const today = localDate()
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]!
      const get = (c: number) => (c >= 0 ? (r[c] ?? '').trim() : '')
      try {
        ctx.db.tx(() => {
          const code = get(cCode)
          if (!code) throw new ImportRowError('importEmptyCode')
          const departmentId = get(cDept) ? ctx.departments.ensurePath(get(cDept)) : null
          const existing = ctx.people.getByCode(code)
          const data = {
            code,
            lastName: get(cLast) || code,
            firstName: cFirst >= 0 && cFirst !== cLast ? get(cFirst) : '',
            departmentId,
            email: existing?.email ?? '',
            phone: existing?.phone ?? '',
            notes: existing?.notes ?? '',
            pin: existing?.pin ?? 0,
            validFrom: existing?.validFrom ?? today,
            validTo: existing?.validTo ?? addDays(today, 365 * 10),
            active: existing?.active ?? true,
            shiftId: existing?.shiftId ?? null,
          }
          let personId: number
          if (existing) {
            ctx.people.update(existing.id, data)
            personId = existing.id
            report.updated++
          } else {
            personId = ctx.people.create(data)
            report.created++
          }
          const cardRaw = get(cCard)
          if (cardRaw) {
            const number = Number(cardRaw)
            if (!Number.isInteger(number) || !isValidWiegand26(number)) throw new ImportRowError('importInvalidCard', { card: cardRaw })
            const card = ctx.people.cardByNumber(number)
            if (!card) {
              ctx.people.createCard(number, personId)
              report.cards++
            } else if (card.personId !== personId) {
              throw new ImportRowError('importCardTaken', { card: number, person: card.personName ?? '?' })
            }
          }
        })
      } catch (err) {
        report.errors.push(
          err instanceof ImportRowError
            ? { row: i + 1, error: err.message, code: err.code, params: err.params }
            : { row: i + 1, error: (err as Error).message },
        )
      }
    }
    ctx.audit.log(req.user, 'import-people', null, { created: report.created, updated: report.updated, cards: report.cards, errors: report.errors.length })
    return report
  })
}
