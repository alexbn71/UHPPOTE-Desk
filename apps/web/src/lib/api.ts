import { notifications } from '@mantine/notifications'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message)
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} }
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
    const err = data as { error?: string; issues?: { path: string; message: string }[] } | undefined
    const detail = err?.issues?.length ? `: ${err.issues.map((i) => `${i.path} ${i.message}`).join('; ')}` : ''
    throw new ApiError(res.status, (err?.error ?? `Errore ${res.status}`) + detail, err?.issues)
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
  notifications.show({ color: 'red', title: 'Errore', message: err instanceof Error ? err.message : String(err), autoClose: 8000 })
}

export function notifyOk(message: string): void {
  notifications.show({ color: 'green', message, autoClose: 3000 })
}

/** Mostra gli avvisi di propagazione ai controller (salvataggio riuscito ma controller non aggiornato). */
export function notifyPush(result: { pushErrors?: { controllerId: number; error: string }[]; pushError?: string | null }, controllerName?: (id: number) => string): void {
  const errors = result.pushErrors ?? (result.pushError ? [{ controllerId: 0, error: result.pushError }] : [])
  if (errors.length === 0) return
  notifications.show({
    color: 'orange',
    title: 'Salvato, ma non inviato a tutti i controller',
    message: errors.map((e) => `${e.controllerId && controllerName ? controllerName(e.controllerId) + ': ' : ''}${e.error}`).join('\n') +
      '\nVerrà allineato con la prossima sincronizzazione.',
    autoClose: 12000,
  })
}

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v))
  const str = s.toString()
  return str ? `?${str}` : ''
}
