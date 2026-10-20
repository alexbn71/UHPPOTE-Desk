import { notifications } from '@mantine/notifications'
import { normalizeLanguage, translateError, type ErrorInfo } from '@uhppote-desk/shared'
import i18n from '../i18n'

type Params = Record<string, string | number>

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly params?: Params,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message)
  }
}

/** Message of an error in the current language (server error codes are translated under errors.*). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const base = err.code
      ? i18n.t(`errors.${err.code}` as 'errors.generic', {
          ...err.params,
          status: err.status,
          defaultValue: err.message,
        })
      : err.message
    const detail = err.issues?.length ? `: ${err.issues.map((i) => `${i.path} ${i.message}`).join('; ')}` : ''
    return base + detail
  }
  return err instanceof Error ? err.message : String(err)
}

/** Text of a server-side error (e.g. the last error of a controller) in the current language. */
export function errorText(err: ErrorInfo | string): string {
  return translateError(normalizeLanguage(i18n.resolvedLanguage), err)
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: { 'Accept-Language': i18n.resolvedLanguage ?? 'en' },
  }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    ;(init.headers as Record<string, string>)['Content-Type'] = 'application/json'
  }
  const res = await fetch(`/api${url}`, init)
  if (res.status === 401 && !url.startsWith('/auth/')) {
    window.dispatchEvent(new Event('uhd:unauthorized'))
  }
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : undefined
  if (!res.ok) {
    const err = data as
      | { error?: string; code?: string; params?: Params; issues?: { path: string; message: string }[] }
      | undefined
    throw new ApiError(
      res.status,
      err?.error ?? `Error ${res.status}`,
      err?.code ?? (err?.error ? undefined : 'generic'),
      err?.params ?? { status: res.status },
      err?.issues,
    )
  }
  return data as T
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, file: File, method = 'POST') => {
    const fd = new FormData()
    fd.append('file', file)
    return request<T>(method, url, fd)
  },
}

export function notifyError(err: unknown): void {
  notifications.show({ color: 'red', title: i18n.t('errors.title'), message: errorMessage(err), autoClose: 8000 })
}

export function notifyOk(message: string): void {
  notifications.show({ color: 'green', message, autoClose: 3000 })
}

/** Warns when a change was saved but could not be sent to some controllers. */
export function notifyPush(
  result: { pushErrors?: { controllerId: number; error: string }[]; pushError?: string | null },
  controllerName?: (id: number) => string,
): void {
  const errors = result.pushErrors ?? (result.pushError ? [{ controllerId: 0, error: result.pushError }] : [])
  if (errors.length === 0) return
  notifications.show({
    color: 'orange',
    title: i18n.t('push.title'),
    message:
      errors
        .map((e) => `${e.controllerId && controllerName ? controllerName(e.controllerId) + ': ' : ''}${e.error}`)
        .join('\n') +
      '\n' +
      i18n.t('push.later'),
    autoClose: 12000,
  })
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v))
  const str = s.toString()
  return str ? `?${str}` : ''
}

/** Query string for downloads (CSV), including the current language. */
export function downloadQs(params: Record<string, string | number | boolean | null | undefined>): string {
  return qs({ ...params, lang: i18n.resolvedLanguage ?? 'en' })
}
