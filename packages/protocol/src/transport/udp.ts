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
  /** Local IP to bind the sockets to (default 0.0.0.0). On multi-NIC hosts give the IP towards the controller. */
  bindAddress: string
  timeoutMs: number
  logger?: Logger | undefined
}

/** Ports the client socket must never use (it would receive its own broadcast as a reply). */
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
        code: 'protocol.socketOpen',
        params: { address: bindAddress, detail: (err as Error).message },
      })
    }
    if (RESERVED_PORTS.has(sock.address().port)) {
      // Keep the "bad" socket open until the next attempt so the same port is not assigned again.
      setTimeout(() => sock.close(), 100)
      continue
    }
    if (broadcast) sock.setBroadcast(true)
    return sock
  }
  throw new TransportError('the operating system keeps assigning port 60000 to the client socket', {
    code: 'protocol.socketPort',
    params: {},
  })
}

function socketError(err: Error): TransportError {
  return new TransportError(`UDP socket error: ${err.message}`, {
    cause: err,
    code: 'protocol.socketError',
    params: { detail: err.message },
  })
}

function sendError(what: string, dest: { host: string; port: number }, err: Error): TransportError {
  return new TransportError(`${what} to ${dest.host}:${dest.port} failed: ${err.message}`, {
    cause: err,
    code: 'protocol.sendFailed',
    params: { target: `${dest.host}:${dest.port}`, detail: err.message },
  })
}

function closeQuietly(sock: dgram.Socket): void {
  try {
    sock.close()
  } catch {
    // already closed
  }
}

/**
 * Sends a packet and waits for the first valid reply that satisfies `accept`.
 * If `expectReply` is false (e.g. Set IP) it resolves with null right after sending.
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
        reject(socketError(err))
      })

      log?.debug?.(`UDP → ${dest.host}:${dest.port}\n${hexdump(packet)}`)
      sock.send(packet, dest.port, dest.host, (err) => {
        if (err) {
          if (timer) clearTimeout(timer)
          reject(sendError('UDP send', dest, err))
        } else if (!expectReply) {
          resolve(null)
        }
      })
    })
  } finally {
    closeQuietly(sock)
  }
}

/** Broadcasts and collects all valid replies within the timeout. */
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
      sock.on('error', (err) => reject(socketError(err)))
      log?.debug?.(`UDP ⇉ ${dest.host}:${dest.port}\n${hexdump(packet)}`)
      sock.send(packet, dest.port, dest.host, (err) => {
        if (err) reject(sendError('broadcast', dest, err))
        else setTimeout(resolve, opts.timeoutMs)
      })
    })
  } finally {
    closeQuietly(sock)
  }
  return replies
}
