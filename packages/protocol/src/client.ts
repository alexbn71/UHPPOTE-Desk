import { CONTROLLER_PORT, FunctionCode as F, EventType, type AntiPassback, type Interlock } from './codec/constants.js'
import {
  DELETED_CARD,
  decode,
  encode,
  type Card,
  type ControllerEvent,
  type ControllerInfo,
  type ControllerStatus,
  type DoorControl,
  type FirstCardConfig,
  type ListenerConfig,
  type OkResponse,
  type Quad,
  type Task,
  type TimeProfile,
} from './codec/messages.js'
import type { DateTimeString } from './codec/bytes.js'
import { EventOverwrittenError, NotFoundError, OperationFailedError, TimeoutError, TransportError } from './errors.js'
import type { Logger } from './logger.js'
import { tcpExchange } from './transport/tcp.js'
import { udpBroadcast, udpExchange, type Endpoint } from './transport/udp.js'

export type Transport = 'udp' | 'tcp'

/** Indirizzamento di un controller. Senza `host` la richiesta va in broadcast. */
export interface ControllerTarget {
  id: number
  host?: string | null | undefined
  port?: number | undefined
  transport?: Transport | undefined
}

export interface ClientOptions {
  /** IP locale per i socket (default 0.0.0.0). */
  bindAddress?: string
  /** Indirizzo di broadcast 'ip[:porta]' (default 255.255.255.255:60000). Preferire il broadcast di subnet. */
  broadcast?: string
  /** Timeout per richiesta in ms (default 2500). */
  timeoutMs?: number
  /** Tentativi aggiuntivi sulle operazioni idempotenti in caso di timeout (default 1). */
  retries?: number
  logger?: Logger
  /** Hook invocato dopo ogni richiesta (per metriche/audit). */
  onRequest?: (info: RequestInfo) => void
}

export interface RequestInfo {
  controller: number
  functionCode: number
  operation: string
  durationMs: number
  attempts: number
  error?: Error
}

export type CardSlot =
  | { state: 'card'; card: Card }
  | { state: 'deleted' }
  /** nessun record a quell'indice (oltre la fine della tabella) */
  | { state: 'empty' }

export function parseEndpoint(s: string, defaultPort = CONTROLLER_PORT): Endpoint {
  const m = /^(.*?)(?::(\d+))?$/.exec(s.trim())
  const host = m?.[1] ?? s
  const port = m?.[2] ? Number(m[2]) : defaultPort
  return { host, port }
}

/**
 * Client ad alto livello per i controller UHPPOTE.
 * - una richiesta alla volta per controller (coda seriale);
 * - unicast se il target ha `host`, altrimenti broadcast;
 * - UDP (default) o TCP;
 * - retry solo per operazioni idempotenti.
 */
export class UhppoteClient {
  readonly bindAddress: string
  readonly broadcast: Endpoint
  readonly timeoutMs: number
  readonly retries: number
  private readonly logger: Logger | undefined
  private readonly onRequest: ((info: RequestInfo) => void) | undefined
  private readonly queues = new Map<number, Promise<unknown>>()

  constructor(opts: ClientOptions = {}) {
    this.bindAddress = opts.bindAddress ?? '0.0.0.0'
    this.broadcast = parseEndpoint(opts.broadcast ?? '255.255.255.255:60000')
    this.timeoutMs = opts.timeoutMs ?? 2500
    this.retries = opts.retries ?? 1
    this.logger = opts.logger
    this.onRequest = opts.onRequest
  }

  // -------------------------------------------------------------------------
  // Infrastruttura
  // -------------------------------------------------------------------------

  private enqueue<T>(controller: number, job: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(controller) ?? Promise.resolve()
    const next = prev.then(job, job)
    const tail = next.catch(() => undefined)
    this.queues.set(controller, tail)
    void tail.then(() => {
      if (this.queues.get(controller) === tail) this.queues.delete(controller)
    })
    return next
  }

  private async exchange(
    target: ControllerTarget,
    operation: string,
    packet: Buffer,
    opts: { idempotent: boolean; expectReply?: boolean },
  ): Promise<Buffer | null> {
    const expectReply = opts.expectReply ?? true
    const fc = packet[1]!
    const accept = (reply: Buffer) => reply[1] === fc && reply.readUInt32LE(4) === target.id
    const attemptsMax = opts.idempotent ? 1 + this.retries : 1

    return this.enqueue(target.id, async () => {
      const started = Date.now()
      let attempts = 0
      let lastError: Error | undefined
      while (attempts < attemptsMax) {
        attempts++
        try {
          const reply = await this.send(target, packet, accept, expectReply)
          this.onRequest?.({ controller: target.id, functionCode: fc, operation, durationMs: Date.now() - started, attempts })
          return reply
        } catch (err) {
          lastError = err as Error
          if (!(err instanceof TimeoutError)) break
          this.logger?.warn?.(`timeout '${operation}' su ${target.id} (tentativo ${attempts}/${attemptsMax})`)
        }
      }
      this.onRequest?.({
        controller: target.id,
        functionCode: fc,
        operation,
        durationMs: Date.now() - started,
        attempts,
        error: lastError!,
      })
      throw lastError!
    })
  }

  private send(
    target: ControllerTarget,
    packet: Buffer,
    accept: (b: Buffer) => boolean,
    expectReply: boolean,
  ): Promise<Buffer | null> {
    const common = { bindAddress: this.bindAddress, timeoutMs: this.timeoutMs, logger: this.logger }
    if (target.host) {
      const dest = { host: target.host, port: target.port ?? CONTROLLER_PORT }
      if (target.transport === 'tcp') return tcpExchange(common, dest, packet, accept, expectReply)
      return udpExchange(common, dest, packet, accept, expectReply, false)
    }
    if (target.transport === 'tcp') {
      return Promise.reject(new TransportError(`TCP richiede l'indirizzo IP del controller ${target.id}`))
    }
    return udpExchange(common, this.broadcast, packet, accept, expectReply, true)
  }

  private async call<T>(
    target: ControllerTarget,
    operation: string,
    packet: Buffer,
    decoder: (b: Buffer) => T,
    idempotent: boolean,
  ): Promise<T> {
    const reply = await this.exchange(target, operation, packet, { idempotent })
    return decoder(reply!)
  }

  private async callOk(
    target: ControllerTarget,
    operation: string,
    packet: Buffer,
    decoder: (b: Buffer) => OkResponse,
    idempotent: boolean,
  ): Promise<void> {
    const r = await this.call(target, operation, packet, decoder, idempotent)
    if (!r.ok) throw new OperationFailedError(target.id, operation)
  }

  // -------------------------------------------------------------------------
  // Dispositivo e rete
  // -------------------------------------------------------------------------

  /** Ricerca tutti i controller raggiungibili via broadcast (attende l'intero timeout). */
  async discover(broadcast?: string): Promise<ControllerInfo[]> {
    const dest = broadcast ? parseEndpoint(broadcast) : this.broadcast
    const replies = await udpBroadcast(
      { bindAddress: this.bindAddress, timeoutMs: this.timeoutMs, logger: this.logger },
      dest,
      encode.getController(0),
      (b) => b[1] === F.GetController,
    )
    const seen = new Map<number, ControllerInfo>()
    for (const r of replies) {
      const info = decode.getController(r)
      seen.set(info.controller, info)
    }
    return [...seen.values()].sort((a, b) => a.controller - b.controller)
  }

  getController(t: ControllerTarget): Promise<ControllerInfo> {
    return this.call(t, 'get-controller', encode.getController(t.id), decode.getController, true)
  }

  /** Il controller NON risponde a questo comando: verificare poi con getController sul nuovo IP. */
  async setIPv4(t: ControllerTarget, address: string, netmask: string, gateway: string): Promise<void> {
    await this.exchange(t, 'set-ipv4', encode.setIPv4(t.id, address, netmask, gateway), {
      idempotent: false,
      expectReply: false,
    })
  }

  async getTime(t: ControllerTarget): Promise<DateTimeString | null> {
    return (await this.call(t, 'get-time', encode.getTime(t.id), decode.getTime, true)).datetime
  }

  async setTime(t: ControllerTarget, datetime: DateTimeString): Promise<DateTimeString | null> {
    return (await this.call(t, 'set-time', encode.setTime(t.id, datetime), decode.setTime, true)).datetime
  }

  async getListener(t: ControllerTarget): Promise<ListenerConfig> {
    const { address, port, interval } = await this.call(t, 'get-listener', encode.getListener(t.id), decode.getListener, true)
    return { address, port, interval }
  }

  setListener(t: ControllerTarget, listener: ListenerConfig): Promise<void> {
    return this.callOk(t, 'set-listener', encode.setListener(t.id, listener), decode.setListener, true)
  }

  // -------------------------------------------------------------------------
  // Porte
  // -------------------------------------------------------------------------

  async getDoorControl(t: ControllerTarget, door: number): Promise<DoorControl> {
    const { mode, delay } = await this.call(t, 'get-door-control', encode.getDoorControl(t.id, door), decode.getDoorControl, true)
    return { door, mode, delay }
  }

  async setDoorControl(t: ControllerTarget, control: DoorControl): Promise<DoorControl> {
    const r = await this.call(t, 'set-door-control', encode.setDoorControl(t.id, control), decode.setDoorControl, true)
    return { door: r.door, mode: r.mode, delay: r.delay }
  }

  setDoorPasscodes(t: ControllerTarget, door: number, passcodes: number[]): Promise<void> {
    return this.callOk(t, 'set-door-passcodes', encode.setDoorPasscodes(t.id, door, passcodes), decode.setDoorPasscodes, true)
  }

  /** Non idempotente: nessun retry automatico. */
  openDoor(t: ControllerTarget, door: number): Promise<void> {
    return this.callOk(t, 'open-door', encode.openDoor(t.id, door), decode.openDoor, false)
  }

  getStatus(t: ControllerTarget): Promise<ControllerStatus> {
    return this.call(t, 'get-status', encode.getStatus(t.id), decode.getStatus, true)
  }

  // -------------------------------------------------------------------------
  // Tessere
  // -------------------------------------------------------------------------

  async getCards(t: ControllerTarget): Promise<number> {
    return (await this.call(t, 'get-cards', encode.getCards(t.id), decode.getCards, true)).cards
  }

  /** null se la tessera non è presente sul controller. */
  async getCard(t: ControllerTarget, card: number): Promise<Card | null> {
    const r = await this.call(t, 'get-card', encode.getCard(t.id, card), decode.getCard, true)
    return r.card.card === 0 || r.card.card === DELETED_CARD ? null : r.card
  }

  async getCardAtIndex(t: ControllerTarget, index: number): Promise<CardSlot> {
    const r = await this.call(t, 'get-card-at-index', encode.getCardAtIndex(t.id, index), decode.getCardAtIndex, true)
    if (r.card.card === 0) return { state: 'empty' }
    if (r.card.card === DELETED_CARD) return { state: 'deleted' }
    return { state: 'card', card: r.card }
  }

  /**
   * Legge tutte le tessere memorizzate scorrendo gli indici (salta i record cancellati).
   * Si ferma quando ha trovato `getCards()` tessere o al primo slot vuoto.
   */
  async listCards(t: ControllerTarget, onProgress?: (found: number, total: number, index: number) => void): Promise<Card[]> {
    const total = await this.getCards(t)
    const cards: Card[] = []
    // limite di sicurezza: tabella tessere + record cancellati
    const maxIndex = Math.max(total, 1) + 100_000
    for (let index = 1; cards.length < total && index <= maxIndex; index++) {
      const slot = await this.getCardAtIndex(t, index)
      if (slot.state === 'empty') break
      if (slot.state === 'card') cards.push(slot.card)
      onProgress?.(cards.length, total, index)
    }
    return cards
  }

  /** Inserisce o sostituisce una tessera. */
  putCard(t: ControllerTarget, card: Card): Promise<void> {
    return this.callOk(t, 'put-card', encode.putCard(t.id, card), decode.putCard, true)
  }

  /** Restituisce false se la tessera non era presente. */
  async deleteCard(t: ControllerTarget, card: number): Promise<boolean> {
    return (await this.call(t, 'delete-card', encode.deleteCard(t.id, card), decode.deleteCard, true)).ok
  }

  deleteAllCards(t: ControllerTarget): Promise<void> {
    return this.callOk(t, 'delete-all-cards', encode.deleteAllCards(t.id), decode.deleteAllCards, true)
  }

  // -------------------------------------------------------------------------
  // Eventi
  // -------------------------------------------------------------------------

  /** Legge l'evento all'indice dato. Lancia NotFoundError / EventOverwrittenError. */
  async getEvent(t: ControllerTarget, index: number): Promise<ControllerEvent> {
    const { event } = await this.call(t, 'get-event', encode.getEvent(t.id, index), decode.getEvent, true)
    if (event.type === EventType.Overwritten) throw new EventOverwrittenError(t.id, index)
    if (event.index === 0) throw new NotFoundError(`evento ${index} non presente sul controller ${t.id}`)
    return event
  }

  /** Indice dell'ultimo evento disponibile (dallo status). 0 se nessun evento. */
  async getLastEventIndex(t: ControllerTarget): Promise<number> {
    const s = await this.getStatus(t)
    return s.event?.index ?? 0
  }

  /** Segnalibro "ultimo evento scaricato" memorizzato nel controller. */
  async getEventIndex(t: ControllerTarget): Promise<number> {
    return (await this.call(t, 'get-event-index', encode.getEventIndex(t.id), decode.getEventIndex, true)).index
  }

  setEventIndex(t: ControllerTarget, index: number): Promise<void> {
    return this.callOk(t, 'set-event-index', encode.setEventIndex(t.id, index), decode.setEventIndex, true)
  }

  recordSpecialEvents(t: ControllerTarget, enabled: boolean): Promise<void> {
    return this.callOk(t, 'record-special-events', encode.recordSpecialEvents(t.id, enabled), decode.recordSpecialEvents, true)
  }

  // -------------------------------------------------------------------------
  // Profili orari e task
  // -------------------------------------------------------------------------

  async getTimeProfile(t: ControllerTarget, id: number): Promise<TimeProfile | null> {
    return (await this.call(t, 'get-time-profile', encode.getTimeProfile(t.id, id), decode.getTimeProfile, true)).profile
  }

  setTimeProfile(t: ControllerTarget, profile: TimeProfile): Promise<void> {
    return this.callOk(t, 'set-time-profile', encode.setTimeProfile(t.id, profile), decode.setTimeProfile, true)
  }

  clearTimeProfiles(t: ControllerTarget): Promise<void> {
    return this.callOk(t, 'clear-time-profiles', encode.clearTimeProfiles(t.id), decode.clearTimeProfiles, true)
  }

  /** Non idempotente (aggiunge un task ogni volta). Dopo l'inserimento chiamare refreshTaskList. */
  addTask(t: ControllerTarget, task: Task): Promise<void> {
    return this.callOk(t, 'add-task', encode.addTask(t.id, task), decode.addTask, false)
  }

  refreshTaskList(t: ControllerTarget): Promise<void> {
    return this.callOk(t, 'refresh-task-list', encode.refreshTaskList(t.id), decode.refreshTaskList, true)
  }

  clearTaskList(t: ControllerTarget): Promise<void> {
    return this.callOk(t, 'clear-task-list', encode.clearTaskList(t.id), decode.clearTaskList, true)
  }

  // -------------------------------------------------------------------------
  // Funzioni avanzate
  // -------------------------------------------------------------------------

  setPCControl(t: ControllerTarget, enabled: boolean): Promise<void> {
    return this.callOk(t, 'set-pc-control', encode.setPCControl(t.id, enabled), decode.setPCControl, true)
  }

  setInterlock(t: ControllerTarget, interlock: Interlock | number): Promise<void> {
    return this.callOk(t, 'set-interlock', encode.setInterlock(t.id, interlock), decode.setInterlock, true)
  }

  activateKeypads(t: ControllerTarget, readers: Quad<boolean>): Promise<void> {
    return this.callOk(t, 'activate-keypads', encode.activateKeypads(t.id, readers), decode.activateKeypads, true)
  }

  async getAntiPassback(t: ControllerTarget): Promise<number> {
    return (await this.call(t, 'get-antipassback', encode.getAntiPassback(t.id), decode.getAntiPassback, true)).antipassback
  }

  setAntiPassback(t: ControllerTarget, mode: AntiPassback | number): Promise<void> {
    return this.callOk(t, 'set-antipassback', encode.setAntiPassback(t.id, mode), decode.setAntiPassback, true)
  }

  setFirstCard(t: ControllerTarget, fc: FirstCardConfig): Promise<void> {
    return this.callOk(t, 'set-first-card', encode.setFirstCard(t.id, fc), decode.setFirstCard, true)
  }

  /** ATTENZIONE: azzera la configurazione del controller. */
  restoreDefaultParameters(t: ControllerTarget): Promise<void> {
    return this.callOk(t, 'restore-default-parameters', encode.restoreDefaultParameters(t.id), decode.restoreDefaultParameters, false)
  }
}
