import type { Logger } from '@uhppote-desk/protocol'
import { parseEndpoint } from '@uhppote-desk/protocol'
import type { ControllerRepo } from '../db/repos.js'
import type { ControllerGateway } from '../gateway/gateway.js'
import { localDateTime, parseLocal } from '../util/time.js'
import type { EventService } from './events.js'

/**
 * Monitoraggio periodico dei controller:
 * - polling dello status (online/offline, stato porte);
 * - al passaggio offline→online: lettura firmware, verifica listener, raccolta eventi;
 * - controllo e correzione della deriva oraria.
 */
export class HealthService {
  private timer: NodeJS.Timeout | null = null
  private readonly lastTimeCheck = new Map<number, number>()
  private busy = false

  constructor(
    private readonly gateway: ControllerGateway,
    private readonly controllers: ControllerRepo,
    private readonly events: EventService,
    private readonly opts: {
      intervalSec: number
      timeSyncThresholdSec: number
      listenerPublic: string | null
      listenerInterval: (controllerId: number) => number
      logger?: Logger | undefined
    },
  ) {}

  start(): void {
    if (this.timer) return
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.opts.intervalSec * 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await Promise.all(this.controllers.list().filter((c) => c.enabled).map((c) => this.check(c.id)))
    } finally {
      this.busy = false
    }
  }

  async check(controllerId: number): Promise<void> {
    const hub = this.gateway.hub
    const wasOnline = hub.state(controllerId).online
    try {
      const status = await this.gateway.run(null, controllerId, 'health', null, (client, t) => client.getStatus(t), { audit: false })
      this.events.onStatus(status)
      if (!wasOnline) await this.onBackOnline(controllerId)
      await this.checkTime(controllerId)
    } catch (err) {
      if (wasOnline) this.opts.logger?.warn?.(`controller ${controllerId} offline: ${(err as Error).message}`)
      hub.patch(controllerId, { online: false, lastError: (err as Error).message })
    }
  }

  private async onBackOnline(controllerId: number): Promise<void> {
    const c = this.controllers.get(controllerId)!
    this.opts.logger?.info?.(`controller ${c.serial} online`)
    await this.gateway.run(null, controllerId, 'health', null, async (client, t) => {
      const info = await client.getController(t)
      this.controllers.markSeen(c.id, localDateTime(), info.version)
      await this.ensureListener(controllerId)
    }, { audit: false })
    this.lastTimeCheck.delete(controllerId)
    await this.events.collect(controllerId)
  }

  /** Programma il listener del controller verso questo server, se configurato e diverso. */
  async ensureListener(controllerId: number): Promise<boolean> {
    if (!this.opts.listenerPublic) return false
    const { host, port } = parseEndpoint(this.opts.listenerPublic, 60001)
    const interval = this.opts.listenerInterval(controllerId)
    return this.gateway.run(null, controllerId, 'set-listener', { host, port, interval }, async (client, t) => {
      const current = await client.getListener(t)
      if (current.address === host && current.port === port && current.interval === interval) return false
      await client.setListener(t, { address: host, port, interval })
      this.opts.logger?.info?.(`listener del controller ${t.id} impostato su ${host}:${port}`)
      return true
    })
  }

  /** Verifica la deriva oraria (al massimo una volta all'ora) e la corregge oltre la soglia. */
  private async checkTime(controllerId: number): Promise<void> {
    const last = this.lastTimeCheck.get(controllerId) ?? 0
    if (Date.now() - last < 3600_000) return
    this.lastTimeCheck.set(controllerId, Date.now())
    const drift = await this.measureDrift(controllerId)
    if (drift !== null && this.opts.timeSyncThresholdSec > 0 && Math.abs(drift) > this.opts.timeSyncThresholdSec) {
      await this.syncTime(controllerId, null)
    }
  }

  async measureDrift(controllerId: number): Promise<number | null> {
    const time = await this.gateway.run(null, controllerId, 'get-time', null, (client, t) => client.getTime(t), { audit: false })
    const drift = time ? Math.round((parseLocal(time).getTime() - Date.now()) / 1000) : null
    this.gateway.hub.patch(controllerId, { controllerTime: time, driftSeconds: drift })
    return drift
  }

  async syncTime(controllerId: number, actor: { id: number; username: string } | null): Promise<string | null> {
    const now = localDateTime()
    const result = await this.gateway.run(actor, controllerId, 'set-time', { time: now }, (client, t) => client.setTime(t, now))
    this.gateway.hub.patch(controllerId, { controllerTime: result, driftSeconds: 0 })
    return result
  }
}
