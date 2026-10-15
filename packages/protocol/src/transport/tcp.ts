import net from 'node:net'
import { TimeoutError, TransportError } from '../errors.js'
import { PACKET_SIZE } from '../codec/constants.js'
import { validatePacket } from '../codec/messages.js'
import type { Logger } from '../logger.js'
import { hexdump } from '../logger.js'
import type { Endpoint } from './udp.js'

export interface TcpOptions {
  bindAddress: string
  timeoutMs: number
  logger?: Logger | undefined
}

/**
 * Single TCP connection: sends a 64-byte packet and waits for a 64-byte reply.
 * Supported by recent firmware on the same port 60000.
 */
export async function tcpExchange(
  opts: TcpOptions,
  dest: Endpoint,
  packet: Buffer,
  accept: (reply: Buffer) => boolean,
  expectReply = true,
): Promise<Buffer | null> {
  const controller = packet.readUInt32LE(4)
  const fc = packet[1]!
  const log = opts.logger

  return new Promise<Buffer | null>((resolve, reject) => {
    const sock = new net.Socket()
    let pending = Buffer.alloc(0)
    let settled = false

    const finish = (err: Error | null, value: Buffer | null = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      if (err) reject(err)
      else resolve(value)
    }

    const timer = setTimeout(() => finish(new TimeoutError(controller, fc, opts.timeoutMs)), opts.timeoutMs)

    sock.on('error', (err) =>
      finish(
        new TransportError(`TCP error towards ${dest.host}:${dest.port}: ${err.message}`, {
          cause: err,
          code: 'protocol.sendFailed',
          params: { target: `${dest.host}:${dest.port}`, detail: err.message },
        }),
      ),
    )

    sock.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= PACKET_SIZE) {
        const msg = pending.subarray(0, PACKET_SIZE)
        pending = pending.subarray(PACKET_SIZE)
        log?.debug?.(`TCP ← ${dest.host}:${dest.port}\n${hexdump(msg)}`)
        if (validatePacket(msg) && accept(msg)) {
          finish(null, Buffer.from(msg))
          return
        }
      }
    })

    const connectOpts: net.TcpNetConnectOpts = { host: dest.host, port: dest.port }
    if (opts.bindAddress && opts.bindAddress !== '0.0.0.0') connectOpts.localAddress = opts.bindAddress

    sock.connect(connectOpts, () => {
      log?.debug?.(`TCP → ${dest.host}:${dest.port}\n${hexdump(packet)}`)
      sock.write(packet, (err) => {
        if (err)
          finish(
            new TransportError(`TCP write failed: ${err.message}`, {
              cause: err,
              code: 'protocol.sendFailed',
              params: { target: `${dest.host}:${dest.port}`, detail: err.message },
            }),
          )
        else if (!expectReply) finish(null, null)
      })
    })
  })
}
