import { describe, expect, it } from 'vitest'
import {
  errorInfo,
  KNOWN_REASONS,
  LANGUAGES,
  normalizeLanguage,
  resources,
  translate,
  translateError,
  translator,
} from '../src/index.js'

function flatten(obj: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv)
  }
  return out
}

const placeholders = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()

const en = flatten(resources.en)

describe('translations', () => {
  for (const { code } of LANGUAGES) {
    const messages = flatten(resources[code])

    it(`${code}: same keys as English`, () => {
      expect([...messages.keys()].sort()).toEqual([...en.keys()].sort())
    })

    it(`${code}: same placeholders as English and no empty texts`, () => {
      for (const [key, text] of en) {
        const translated = messages.get(key)!
        expect(translated.trim(), key).not.toBe('')
        expect(placeholders(translated), key).toEqual(placeholders(text))
      }
    })

    it(`${code}: every known reason code has a label`, () => {
      for (const r of KNOWN_REASONS) expect(messages.has(`codes.reason.${r}`), `reason ${r}`).toBe(true)
    })
  }

  it('translate interpolates parameters and falls back to English, then to the key', () => {
    expect(translate('it', 'common.doorN', { n: 3 })).toBe('Porta 3')
    expect(translate('de', 'errors.invalidSegment', { start: '08:00', end: '07:00' })).toBe(
      'Ungültiges Intervall: 08:00-07:00',
    )
    expect(translate('fr', 'does.not.exist')).toBe('does.not.exist')
  })

  it('translator helpers for protocol codes', () => {
    const it = translator('it')
    expect(it.reason(44)).toBe('Apertura remota')
    expect(it.reason(99)).toBe('Motivo 99')
    expect(it.direction(2)).toBe('Uscita')
    expect(translator('es').attendanceStatus('presente')).toBe('Presente')
  })

  it('normalizeLanguage', () => {
    expect(normalizeLanguage('it-IT,it;q=0.9,en;q=0.8')).toBe('it')
    expect(normalizeLanguage('DE')).toBe('de')
    expect(normalizeLanguage('pt-BR')).toBe('en')
    expect(normalizeLanguage(undefined)).toBe('en')
  })
})

describe('translateError', () => {
  class CodedError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly params: Record<string, string | number>,
    ) {
      super(message)
    }
  }
  const timeout = new CodedError(
    'no reply from controller 405419896 (function 0x20) within 2500 ms',
    'protocol.timeout',
    {
      controller: 405419896,
      function: '0x20',
      timeoutMs: 2500,
    },
  )

  it('translates errors with a code', () => {
    expect(translateError('it', timeout)).toBe(
      'Nessuna risposta dal controller 405419896 entro 2500 ms (funzione 0x20)',
    )
    expect(translateError('en', timeout)).toBe('No reply from controller 405419896 within 2500 ms (function 0x20)')
  })

  it('accepts the stored form (ErrorInfo)', () => {
    expect(translateError('de', errorInfo(timeout))).toMatch(/^Keine Antwort von Controller 405419896/)
  })

  it('keeps the text of errors without a known code', () => {
    const system = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    expect(translateError('it', system)).toBe('connect ECONNREFUSED')
    expect(translateError('it', new CodedError('raw text', 'no.such.key', {}))).toBe('raw text')
    expect(translateError('it', 'plain string')).toBe('plain string')
  })
})
