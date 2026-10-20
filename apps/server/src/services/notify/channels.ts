import nodemailer from 'nodemailer'
import type { NotificationConfig } from '@uhppote-desk/shared'
import { plainText, type NotifyMessage } from './messages.js'

export type TelegramConfig = Extract<NotificationConfig, { type: 'telegram' }>
type EmailConfig = Extract<NotificationConfig, { type: 'email' }>
type NtfyConfig = Extract<NotificationConfig, { type: 'ntfy' }>
type GotifyConfig = Extract<NotificationConfig, { type: 'gotify' }>

export interface SendOptions {
  timeoutMs: number
  telegramApi: string
  /** Inline keyboard for Telegram (the "open door" button). */
  telegramButton?: { text: string; data: string } | undefined
}

/** Telegram limits for a message text and for a photo caption. */
const TELEGRAM_MAX = 4096
const TELEGRAM_CAPTION_MAX = 1024

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function telegramText(m: NotifyMessage, max = TELEGRAM_MAX): string {
  const body = m.lines
    .map((l, i) => (typeof l === 'string' ? escapeHtml(l) : `${i > 0 ? '\n' : ''}<b>${escapeHtml(l.heading)}</b>`))
    .join('\n')
  const text = `${m.emoji} <b>${escapeHtml(m.title)}</b>\n${body}`
  return text.length <= max ? text : `${text.slice(0, max - 2)}…`
}

/** Calls a Telegram Bot API method; throws with Telegram's description on failure. */
export async function telegramCall<T = unknown>(
  api: string,
  token: string,
  method: string,
  body: object,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const res = await fetch(`${api}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null
  if (!res.ok || !json?.ok) throw new Error(`Telegram ${method}: ${json?.description ?? `HTTP ${res.status}`}`)
  return json.result as T
}

/** Sends a photo with the message as caption (multipart upload). */
async function sendTelegramPhoto(c: TelegramConfig, m: NotifyMessage, photo: Buffer, o: SendOptions): Promise<void> {
  const form = new FormData()
  form.append('chat_id', c.chatId)
  form.append('caption', telegramText(m, TELEGRAM_CAPTION_MAX))
  form.append('parse_mode', 'HTML')
  form.append('photo', new Blob([new Uint8Array(photo)], { type: 'image/jpeg' }), 'photo.jpg')
  if (o.telegramButton)
    form.append(
      'reply_markup',
      JSON.stringify({ inline_keyboard: [[{ text: o.telegramButton.text, callback_data: o.telegramButton.data }]] }),
    )
  const res = await fetch(`${o.telegramApi}/bot${c.botToken}/sendPhoto`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(o.timeoutMs),
  })
  const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null
  if (!res.ok || !json?.ok) throw new Error(`Telegram sendPhoto: ${json?.description ?? `HTTP ${res.status}`}`)
}

async function sendTelegram(c: TelegramConfig, m: NotifyMessage, o: SendOptions): Promise<void> {
  if (m.photo) return sendTelegramPhoto(c, m, m.photo, o)
  await telegramCall(
    o.telegramApi,
    c.botToken,
    'sendMessage',
    {
      chat_id: c.chatId,
      text: telegramText(m),
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(o.telegramButton
        ? {
            reply_markup: {
              inline_keyboard: [[{ text: o.telegramButton.text, callback_data: o.telegramButton.data }]],
            },
          }
        : {}),
    },
    o.timeoutMs,
  )
}

async function sendEmail(c: EmailConfig, m: NotifyMessage, o: SendOptions): Promise<void> {
  const transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    ...(c.username ? { auth: { user: c.username, pass: c.password } } : {}),
    connectionTimeout: o.timeoutMs,
    greetingTimeout: o.timeoutMs,
    socketTimeout: o.timeoutMs,
  })
  try {
    await transport.sendMail({
      from: c.from,
      to: c.to,
      subject: `${m.emoji} ${m.title}`,
      text: plainText(m),
      ...(m.photo ? { attachments: [{ filename: 'photo.jpg', content: m.photo, contentType: 'image/jpeg' }] } : {}),
    })
  } finally {
    transport.close()
  }
}

async function postJson(url: string, headers: Record<string, string>, body: object, timeoutMs: number): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
}

async function sendNtfy(c: NtfyConfig, m: NotifyMessage, o: SendOptions): Promise<void> {
  const headers: Record<string, string> = {}
  if (c.token) headers.Authorization = `Bearer ${c.token}`
  else if (c.username) headers.Authorization = `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`
  // JSON publishing (POST to the server root) supports non-ASCII titles, unlike the Title header
  await postJson(
    c.serverUrl.replace(/\/+$/, ''),
    headers,
    { topic: c.topic, title: m.title, message: plainText(m), priority: m.priority, tags: m.tags },
    o.timeoutMs,
  )
}

async function sendGotify(c: GotifyConfig, m: NotifyMessage, o: SendOptions): Promise<void> {
  await postJson(
    `${c.serverUrl.replace(/\/+$/, '')}/message`,
    { 'X-Gotify-Key': c.appToken },
    { title: `${m.emoji} ${m.title}`, message: plainText(m), priority: m.priority * 2 },
    o.timeoutMs,
  )
}

/** Sends a message on a channel; throws on failure. */
export async function sendMessage(config: NotificationConfig, m: NotifyMessage, o: SendOptions): Promise<void> {
  switch (config.type) {
    case 'telegram':
      return sendTelegram(config, m, o)
    case 'email':
      return sendEmail(config, m, o)
    case 'ntfy':
      return sendNtfy(config, m, o)
    case 'gotify':
      return sendGotify(config, m, o)
  }
}
