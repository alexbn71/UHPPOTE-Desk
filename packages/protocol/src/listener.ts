import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { decodeListenerEvent, type ControllerStatus } from './codec/messages.js'
import { TransportError } from './errors.js'
import { hexdump, type Logger } from './logger.js'
import { parseEndpoint } from './client.js'

export interface ListenerEvents {
  /** Event/status received from a controller. */
  status: [status: ControllerStatus, from: { address: string; port: number }]
  /** Packet received but not recognised. */
  invalid: [packet: Buffer, from: { address: string; port: number }]
  error: [err: Error]
  listening: [address: { address: string; port: number }]
}

/**
 * UDP server receiving the events sent by the controllers (configured with setListener).
 * Also accepts the SOM 0x19 packets of firmware v6.62.
 */
export class EventListener extends EventEmitter<ListenerEvents> {
  private socket: dgram.Socket | null = null

  constructor(
    private readonly listen: string = '0.0.0.0:60001',
    private readonly logger?: Logger,
  ) {
    super()
  }

  get address(): { address: string; port: number } | null {
    if (!this.socket) return null
    const a = this.socket.address()
    return { address: a.address, port: a.port }
  }

  start(): Promise<{ address: string; port: number }> {
    if (this.socket) return Promise.resolve(this.address!)
    const { host, port } = parseEndpoint(this.listen, 60001)
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = sock

    sock.on('message', (msg, rinfo) => {
      const from = { address: rinfo.address, port: rinfo.port }
      this.logger?.debug?.(`EVENT ← ${rinfo.address}:${rinfo.port}\n${hexdump(msg)}`)
      const status = decodeListenerEvent(msg)
      if (status) this.emit('status', status, from)
      else this.emit('invalid', msg, from)
    })

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        this.socket = null
        sock.close()
        reject(new TransportError(`cannot listen on ${host}:${port}: ${err.message}`, { cause: err }))
      }
      sock.once('error', onError)
      sock.bind({ address: host, port }, () => {
        sock.off('error', onError)
        sock.on('error', (err) => this.emit('error', err))
        const a = this.address!
        this.emit('listening', a)
        resolve(a)
      })
    })
  }

  async stop(): Promise<void> {
    const sock = this.socket
    this.socket = null
    if (sock) await new Promise<void>((resolve) => sock.close(() => resolve()))
  }
}
