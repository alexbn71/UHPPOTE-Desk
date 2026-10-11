import dgram from 'node:dgram'
import { TimeoutError, TransportError } from '../errors.js'
import { validatePacket } from '../codec/messages.js'
import type { Logger } from '../logger.js'
import { hexdump } from '../logger.js'

export interface Endpoint {
  host: string
  port: number
}

export interface UdpOptions {
  /** IP locale su cui legare i socket (default 0.0.0.0). Su host multi-NIC indicare l'IP verso il controller. */
  bindAddress: string
  timeoutMs: number
  logger?: Logger | undefined
}

/** Porte che il socket client non deve mai usare (riceverebbe il proprio broadcast come risposta). */
const RESERVED_PORTS = new Set([60000])

async function openSocket(bindAddress: string, broadcast: boolean): Promise<dgram.Socket> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false })
    try {
      await new Promise<void>((resolve, reject) => {
        sock.once('error', reject)
        sock.bind({ address: bindAddress, port: 0 }, () => {
          sock.off('error', reject)
          resolve()
        })
      })
    } catch (err) {
      sock.close()
      throw new TransportError(`cannot open a UDP socket on ${bindAddress}: ${(err as Error).message}`, {
        cause: err,
      })
    }
    if (RESERVED_PORTS.has(sock.address().port)) {
      // Teniamo aperto il socket "cattivo" fino al prossimo tentativo per non farci riassegnare la stessa porta.
      setTimeout(() => sock.close(), 100)
      continue
    }
    if (broadcast) sock.setBroadcast(true)
    return sock
  }
  throw new TransportError('the operating system keeps assigning port 60000 to the client socket')
}

function closeQuietly(sock: dgram.Socket): void {
  try {
    sock.close()
  } catch {
    // già chiuso
  }
}

/**
 * Invia un pacchetto e attende la prima risposta valida che soddisfa `accept`.
 * Se `expectReply` è false (es. Set IP) risolve subito dopo l'invio con null.
 */
export async function udpExchange(
  opts: UdpOptions,
  dest: Endpoint,
  packet: Buffer,
  accept: (reply: Buffer) => boolean,
  expectReply = true,
  broadcast = false,
): Promise<Buffer | null> {
  const sock = await openSocket(opts.bindAddress, broadcast)
  const log = opts.logger
  const controller = packet.readUInt32LE(4)
  const fc = packet[1]!

  try {
    return await new Promise<Buffer | null>((resolve, reject) => {
      const timer = expectReply ? setTimeout(() => reject(new TimeoutError(controller, fc, opts.timeoutMs)), opts.timeoutMs) : null

      sock.on('message', (msg, rinfo) => {
        log?.debug?.(`UDP ← ${rinfo.address}:${rinfo.port}\n${hexdump(msg)}`)
        if (validatePacket(msg) && accept(msg)) {
          if (timer) clearTimeout(timer)
          resolve(msg)
        }
      })
      sock.on('error', (err) => {
        if (timer) clearTimeout(timer)
        reject(new TransportError(`UDP socket error: ${err.message}`, { cause: err }))
      })

      log?.debug?.(`UDP → ${dest.host}:${dest.port}\n${hexdump(packet)}`)
      sock.send(packet, dest.port, dest.host, (err) => {
        if (err) {
          if (timer) clearTimeout(timer)
          reject(new TransportError(`UDP send to ${dest.host}:${dest.port} failed: ${err.message}`, { cause: err }))
        } else if (!expectReply) {
          resolve(null)
        }
      })
    })
  } finally {
    closeQuietly(sock)
  }
}

/** Invia in broadcast e raccoglie tutte le risposte valide entro il timeout. */
export async function udpBroadcast(
  opts: UdpOptions,
  dest: Endpoint,
  packet: Buffer,
  accept: (reply: Buffer) => boolean,
): Promise<Buffer[]> {
  const sock = await openSocket(opts.bindAddress, true)
  const log = opts.logger
  const replies: Buffer[] = []

  try {
    await new Promise<void>((resolve, reject) => {
      sock.on('message', (msg, rinfo) => {
        log?.debug?.(`UDP ← ${rinfo.address}:${rinfo.port}\n${hexdump(msg)}`)
        if (validatePacket(msg) && accept(msg)) replies.push(msg)
      })
      sock.on('error', (err) => reject(new TransportError(`UDP socket error: ${err.message}`, { cause: err })))
      log?.debug?.(`UDP ⇉ ${dest.host}:${dest.port}\n${hexdump(packet)}`)
      sock.send(packet, dest.port, dest.host, (err) => {
        if (err) reject(new TransportError(`broadcast to ${dest.host}:${dest.port} failed: ${err.message}`, { cause: err }))
        else setTimeout(resolve, opts.timeoutMs)
      })
    })
  } finally {
    closeQuietly(sock)
  }
  return replies
}
