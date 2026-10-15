import { de } from './de.js'
import { en, type Messages } from './en.js'
import { es } from './es.js'
import { fr } from './fr.js'
import { it } from './it.js'

export type { Messages } from './en.js'

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'it', label: 'Italiano' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
] as const

export type Language = (typeof LANGUAGES)[number]['code']
export const DEFAULT_LANGUAGE: Language = 'en'

export const resources: Record<Language, Messages> = { en, it, es, fr, de }

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && value in resources
}

/** Normalises 'it-IT', 'IT', undefined… to a supported language (fallback: English). */
export function normalizeLanguage(value: unknown): Language {
  const code = typeof value === 'string' ? value.slice(0, 2).toLowerCase() : ''
  return isLanguage(code) ? code : DEFAULT_LANGUAGE
}

function lookup(messages: unknown, key: string): string | undefined {
  let node: unknown = messages
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return typeof node === 'string' ? node : undefined
}

/**
 * Minimal translator (same {{param}} syntax as i18next), used by the server for exports.
 * Falls back to English, then to the key itself.
 */
export function translate(lang: Language, key: string, params: Record<string, string | number> = {}): string {
  const text = lookup(resources[lang], key) ?? lookup(resources.en, key) ?? key
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => (name in params ? String(params[name]) : `{{${name}}}`))
}

/** Error that can be shown in any language: `code` is a key below `errors.`, `params` its placeholders. */
export interface ErrorInfo {
  /** English text, used when there is no code or no translation for it. */
  message: string
  code?: string
  params?: Record<string, string | number>
}

/** Code and params of an error that carries them (controller and HTTP errors), otherwise just its text; an `ErrorInfo` is returned as is. */
export function errorInfo(err: unknown): ErrorInfo {
  if (!(err instanceof Error)) {
    const info = err as ErrorInfo | null
    return info !== null && typeof info === 'object' && typeof info.message === 'string' ? info : { message: String(err) }
  }
  const { code, params } = err as Error & { code?: unknown; params?: unknown }
  if (typeof code === 'string' && params !== null && typeof params === 'object') {
    return { message: err.message, code, params: params as Record<string, string | number> }
  }
  return { message: err.message }
}

/** Text of an error in a language; errors without a translatable code keep their own text. */
export function translateError(lang: Language, err: unknown): string {
  const info = errorInfo(err)
  return info.code && lookup(resources.en, `errors.${info.code}`) ? translate(lang, `errors.${info.code}`, info.params) : info.message
}

/** Translator bound to one language, with helpers for the protocol codes. */
export function translator(lang: Language) {
  const t = (key: string, params?: Record<string, string | number>) => translate(lang, key, params)
  return {
    t,
    error: (err: unknown) => translateError(lang, err),
    reason: (code: number) => (lookup(resources[lang], `codes.reason.${code}`) ? t(`codes.reason.${code}`) : t('codes.reason.unknown', { code })),
    eventType: (code: number) => t(`codes.eventType.${code}`),
    direction: (code: number) => (code === 1 || code === 2 ? t(`codes.direction.${code}`) : ''),
    attendanceStatus: (code: string) => t(`codes.attendanceStatus.${code}`),
    anomaly: (code: string) => t(`codes.anomaly.${code}`),
  }
}
