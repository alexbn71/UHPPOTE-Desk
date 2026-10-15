import type { FastifyRequest } from 'fastify'
import { normalizeLanguage, translateError, translator, type Language } from '@uhppote-desk/shared'

/** Language of a request: `?lang=` parameter, otherwise the browser's Accept-Language, otherwise English. */
export function requestLanguage(req: FastifyRequest): Language {
  const q = (req.query as { lang?: unknown } | undefined)?.lang
  return normalizeLanguage(q ?? req.headers['accept-language'])
}

export function requestTranslator(req: FastifyRequest) {
  return translator(requestLanguage(req))
}

/** Text of an error in the language of the request (controller errors are translated, others keep their text). */
export function requestErrorText(req: FastifyRequest, err: unknown): string {
  return translateError(requestLanguage(req), err)
}
