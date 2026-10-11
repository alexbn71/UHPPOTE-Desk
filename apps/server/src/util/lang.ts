import type { FastifyRequest } from 'fastify'
import { normalizeLanguage, translator, type Language } from '@uhppote-desk/shared'

/** Language of a request: `?lang=` parameter, otherwise the browser's Accept-Language, otherwise English. */
export function requestLanguage(req: FastifyRequest): Language {
  const q = (req.query as { lang?: unknown } | undefined)?.lang
  return normalizeLanguage(q ?? req.headers['accept-language'])
}

export function requestTranslator(req: FastifyRequest) {
  return translator(requestLanguage(req))
}
