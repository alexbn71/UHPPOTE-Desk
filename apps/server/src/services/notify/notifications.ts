import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Logger } from '@uhppote-desk/protocol'
import { translator } from '@uhppote-desk/shared'
import type { NotificationChannel, NotificationRepo } from '../../db/notifications.js'
import type { ControllerRepo, EventRepo } from '../../db/repos.js'
import type { ControllerGateway } from '../../gateway/gateway.js'
import type { AnomalyService } from '../anomalies.js'
import { localDate, localDateTime } from '../../util/time.js'
import { matchesDoors, type IntegrationEvent, type IntegrationEvents } from '../integrationEvents.js'
import { sendMessage, type TelegramConfig } from './channels.js'
import { eventMessage, reportMessage, testMessage, type NotifyMessage } from './messages.js'
import { TelegramBot, type TelegramUpdate } from './telegramBot.js'

/** How long a Telegram "open door" button stays valid. */
const OPEN_BUTTON_TTL_SEC = 15 * 60
/** Messages waiting per channel beyond which new ones are dropped. */
const MAX_QUEUE = 200

export interface SendResult {
  ok: boolean
  error: string | null
}

/**
 * Notifications on Telegram, email, ntfy and Gotify: event messages, daily reports,
 * and the Telegram bot (open-door buttons, /id command).
 */
export class NotificationService {
  private readonly queues = new Map<number, { tail: Promise<void>; pending: number }>()
  private readonly bots = new Map<string, TelegramBot>()
  private readonly onEvent = (ev: IntegrationEvent) => this.dispatch(ev)
  private reportTimer: NodeJS.Timeout | null = null
  private readonly opts: { telegramApi: string; timeoutMs: number; retryDelayMs: number; logger?: Logger | undefined }

  constructor(
    private readonly repo: NotificationRepo,
    private readonly bus: IntegrationEvents,
    private readonly deps: {
      controllers: ControllerRepo
      events: EventRepo
      gateway: ControllerGateway
      anomalies: AnomalyService
    },
    opts: { telegramApi?: string; timeoutMs?: number; retryDelayMs?: number; logger?: Logger | undefined } = {},
  ) {
    this.opts = {
      telegramApi: opts.telegramApi ?? 'https://api.telegram.org',
      timeoutMs: opts.timeoutMs ?? 15_000,
      retryDelayMs: opts.retryDelayMs ?? 5000,
      logger: opts.logger,
    }
  }

  start(): void {
    this.bus.on('event', this.onEvent)
    this.bus.start()
    this.refresh()
    if (!this.reportTimer) {
      this.reportTimer = setInterval(() => void this.tickReports(), 60_000)
      this.reportTimer.unref()
    }
  }

  stop(): void {
    this.bus.off('event', this.onEvent)
    if (this.reportTimer) clearInterval(this.reportTimer)
    this.reportTimer = null
    for (const bot of this.bots.values()) bot.stop()
    this.bots.clear()
  }

  /** Starts/stops the Telegram bots after channels changed. */
  refresh(): void {
    const tokens = new Set(
      this.repo
        .list()
        .filter((c) => c.enabled && c.config.type === 'telegram')
        .map((c) => (c.config as TelegramConfig).botToken),
    )
    for (const [token, bot] of this.bots) {
      if (!tokens.has(token)) {
        bot.stop()
        this.bots.delete(token)
      }
    }
    for (const token of tokens) {
      if (this.bots.has(token)) continue
      const bot = new TelegramBot(token, this.opts.telegramApi, (u, b) => this.onTelegramUpdate(u, b), this.opts.logger)
      this.bots.set(token, bot)
      bot.start()
    }
  }

  /** Waits until every queued message has been sent (tests). */
  async idle(): Promise<void> {
    while ([...this.queues.values()].some((q) => q.pending > 0)) {
      await Promise.all([...this.queues.values()].map((q) => q.tail))
    }
  }

  async test(channelId: number): Promise<SendResult> {
    const c = this.repo.get(channelId)
    if (!c) return { ok: false, error: 'not found' }
    return this.send(c, testMessage(c.language))
  }

  /** Sends the daily report now (the last 24 hours). */
  async sendReport(channelId: number, now = new Date()): Promise<SendResult> {
    const c = this.repo.get(channelId)
    if (!c) return { ok: false, error: 'not found' }
    return this.send(c, this.buildReport(c, now))
  }

  /** Sends the reports due at this hour (once a day per channel). */
  async tickReports(now = new Date()): Promise<void> {
    const today = localDate(now)
    for (const c of this.repo.list()) {
      if (!c.enabled || !c.dailyReport || c.reportHour !== now.getHours() || c.lastReportDate === today) continue
      this.repo.setReportDate(c.id, today)
      const r = await this.send(c, this.buildReport(c, now))
      if (!r.ok) this.opts.logger?.warn?.(`notification "${c.name}": daily report not sent: ${r.error}`)
    }
  }

  private buildReport(c: NotificationChannel, now: Date): NotifyMessage {
    const to = localDateTime(now)
    const from = localDateTime(new Date(now.getTime() - 24 * 3600_000))
    const doors = this.deps.controllers.doors()
    const allowed = c.doorIds.length > 0 ? new Set(c.doorIds) : null
    const events = this.deps.events
      .query({ from, to, limit: 5000, offset: 0 })
      .rows.filter(
        (e) =>
          !allowed || doors.some((d) => allowed.has(d.id) && d.controllerId === e.controllerId && d.door === e.door),
      )
    const controllers = this.deps.controllers.list().filter((x) => x.enabled)
    const offline = controllers
      .filter((x) => !this.deps.gateway.hub.state(x.id).online)
      .filter((x) => !allowed || doors.some((d) => allowed.has(d.id) && d.controllerId === x.id))
      .map((x) => x.name)
    const inDoors = (controllerId: number, door: number) =>
      !allowed || doors.some((d) => allowed.has(d.id) && d.controllerId === controllerId && d.door === door)
    const unusual = this.deps.anomalies.unusualAccesses(from, to).filter((u) => inDoors(u.controllerId, u.door))
    const bursts = this.deps.anomalies
      .deniedBursts(from, to)
      .filter((b) => b.doorRefs.some((r) => inDoors(r.controllerId, r.door)))
    return reportMessage({ from, to, events, offline, unusual, bursts }, c.language)
  }

  // --- event notifications ------------------------------------------------------

  private dispatch(ev: IntegrationEvent): void {
    try {
      for (const c of this.repo.list()) {
        if (!c.enabled || !c.events.includes(ev.type)) continue
        if (!matchesDoors(c.doorIds, ev, () => this.bus.controllerDoorIds(ev.controller.id))) continue
        this.enqueue(c.id, eventMessage(ev, c.language))
      }
    } catch (err) {
      this.opts.logger?.error?.(`notifications: ${(err as Error).message}`)
    }
  }

  private enqueue(channelId: number, m: NotifyMessage): void {
    let q = this.queues.get(channelId)
    if (!q) {
      q = { tail: Promise.resolve(), pending: 0 }
      this.queues.set(channelId, q)
    }
    if (q.pending >= MAX_QUEUE) {
      this.opts.logger?.warn?.(`notification channel ${channelId}: ${q.pending} messages waiting, message dropped`)
      return
    }
    const queue = q
    queue.pending++
    queue.tail = queue.tail
      .then(async () => {
        const c = this.repo.get(channelId)
        if (!c?.enabled) return
        let r = await this.send(c, m)
        if (!r.ok) {
          await new Promise((res) => setTimeout(res, this.opts.retryDelayMs).unref())
          const again = this.repo.get(channelId)
          if (again?.enabled) r = await this.send(again, m)
          if (!r.ok) this.opts.logger?.warn?.(`notification "${c.name}" not sent: ${r.error}`)
        }
      })
      .catch((err: Error) => this.opts.logger?.error?.(`notifications: ${err.message}`))
      .finally(() => queue.pending--)
  }

  private async send(c: NotificationChannel, m: NotifyMessage): Promise<SendResult> {
    try {
      await sendMessage(c.config, m, {
        timeoutMs: this.opts.timeoutMs,
        telegramApi: this.opts.telegramApi,
        telegramButton: this.openButton(c, m),
      })
      this.repo.recordResult(c.id, localDateTime(), null)
      return { ok: true, error: null }
    } catch (err) {
      const e = err as Error & { cause?: { code?: string; message?: string } }
      const error = e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.cause?.message ?? e.message)
      this.repo.recordResult(c.id, localDateTime(), error)
      return { ok: false, error }
    }
  }

  // --- Telegram: open-door button -----------------------------------------------

  private openButton(c: NotificationChannel, m: NotifyMessage): { text: string; data: string } | undefined {
    if (c.config.type !== 'telegram' || !c.config.openButton || !m.door) return undefined
    const ts = Math.floor(Date.now() / 1000)
    const payload = `${c.id}:${m.door.id}:${ts}`
    return {
      text: translator(c.language).t('notify.openButton', { door: m.door.name }),
      data: `o:${payload}:${sign(c.config.botToken, payload)}`,
    }
  }

  private async onTelegramUpdate(u: TelegramUpdate, bot: TelegramBot): Promise<void> {
    const channels = this.repo
      .list()
      .filter((c) => c.enabled && c.config.type === 'telegram' && c.config.botToken === bot.token)
    if (u.message?.text && /^\/(start|id)\b/.test(u.message.text)) {
      const lang =
        channels.find((c) => (c.config as TelegramConfig).chatId === String(u.message!.chat.id))?.language ??
        channels[0]?.language ??
        'en'
      await bot.call('sendMessage', {
        chat_id: u.message.chat.id,
        text: translator(lang).t('notify.chatInfo', { chat: u.message.chat.id, user: u.message.from?.id ?? '?' }),
      })
      return
    }
    const q = u.callback_query
    if (!q?.data?.startsWith('o:')) return
    const answer = (text: string) =>
      bot.call('answerCallbackQuery', { callback_query_id: q.id, text, show_alert: true })

    const [, channelId, doorId, ts, sig] = q.data.split(':')
    const c = channels.find((x) => x.id === Number(channelId))
    const t = translator(c?.language ?? 'en')
    const cfg = c?.config as TelegramConfig | undefined
    const payload = `${channelId}:${doorId}:${ts}`
    if (!c || !cfg?.openButton || !sig || !safeEqual(sig, sign(cfg.botToken, payload)))
      return void (await answer(t.t('notify.openNotAllowed')))
    if (q.message && String(q.message.chat.id) !== cfg.chatId && !cfg.chatId.startsWith('@'))
      return void (await answer(t.t('notify.openNotAllowed')))
    if (!cfg.allowedUserIds.includes(q.from.id)) {
      this.opts.logger?.warn?.(`Telegram: user ${q.from.id} (${q.from.username ?? '?'}) is not allowed to open doors`)
      return void (await answer(t.t('notify.openNotAllowed')))
    }
    if (Date.now() / 1000 - Number(ts) > OPEN_BUTTON_TTL_SEC) return void (await answer(t.t('notify.openExpired')))

    const door = this.deps.controllers.door(Number(doorId))
    const controller = door && this.deps.controllers.get(door.controllerId)
    if (!door || !door.active || !controller?.enabled || (c.doorIds.length > 0 && !c.doorIds.includes(door.id))) {
      return void (await answer(t.t('notify.openNotAllowed')))
    }
    const user = q.from.username ? `@${q.from.username}` : (q.from.first_name ?? String(q.from.id))
    try {
      await this.deps.gateway.run(
        { id: null, username: `telegram:${q.from.username ?? q.from.id}` },
        controller.id,
        'open-door',
        { door: door.door, name: door.name, source: 'telegram', telegramUserId: q.from.id },
        (client, target) => client.openDoor(target, door.door),
      )
    } catch (err) {
      await answer(t.t('notify.openFailed', { door: door.name, error: (err as Error).message }))
      return
    }
    await answer(t.t('notify.openDone', { door: door.name }))
    await bot
      .call('sendMessage', { chat_id: cfg.chatId, text: `🔓 ${t.t('notify.opened', { door: door.name, user })}` })
      .catch(() => undefined)
  }
}

/** Short HMAC of the button data: buttons cannot be forged by a modified client. */
function sign(botToken: string, payload: string): string {
  return createHmac('sha256', botToken).update(payload).digest('base64url').slice(0, 16)
}

function safeEqual(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}
