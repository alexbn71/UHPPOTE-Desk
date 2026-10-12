import type { Logger } from '@uhppote-desk/protocol'
import { telegramCall } from './channels.js'

export interface TelegramUser {
  id: number
  username?: string
  first_name?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: { chat: { id: number }; from?: TelegramUser; text?: string }
  callback_query?: { id: string; from: TelegramUser; data?: string; message?: { chat: { id: number } } }
}

/** Seconds a getUpdates request waits for updates (long polling). */
const POLL_SECONDS = 25

/**
 * Receives the updates of a bot by long polling (no public URL needed):
 * button presses and commands. One instance per bot token.
 */
export class TelegramBot {
  private abort: AbortController | null = null
  private offset = 0
  private conflictLogged = false

  constructor(
    readonly token: string,
    private readonly api: string,
    private readonly onUpdate: (u: TelegramUpdate, bot: TelegramBot) => Promise<void>,
    private readonly logger?: Logger,
  ) {}

  start(): void {
    if (this.abort) return
    this.abort = new AbortController()
    void this.loop(this.abort.signal)
  }

  stop(): void {
    this.abort?.abort()
    this.abort = null
  }

  call<T = unknown>(method: string, body: object): Promise<T> {
    return telegramCall<T>(this.api, this.token, method, body, 10_000)
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const updates = await telegramCall<TelegramUpdate[]>(
          this.api,
          this.token,
          'getUpdates',
          { offset: this.offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] },
          (POLL_SECONDS + 10) * 1000,
          signal,
        )
        this.conflictLogged = false
        for (const u of updates) {
          this.offset = u.update_id + 1
          await this.onUpdate(u, this).catch((err: Error) => this.logger?.warn?.(`Telegram: ${err.message}`))
        }
      } catch (err) {
        if (signal.aborted) return
        const msg = (err as Error).message
        // 409: another program reads this bot's updates (or a webhook is set)
        if (!/Conflict/i.test(msg) || !this.conflictLogged) this.logger?.warn?.(`Telegram bot: ${msg}`)
        if (/Conflict/i.test(msg)) this.conflictLogged = true
        await new Promise((r) => setTimeout(r, 5000).unref())
      }
    }
  }
}
