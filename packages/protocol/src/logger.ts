/** Minimal logger compatible with pino/console. */
export interface Logger {
  debug?: (msg: string) => void
  info?: (msg: string) => void
  warn?: (msg: string) => void
  error?: (msg: string) => void
}

/** Hex dump of a packet in 16-byte rows (format similar to uhppoted-cli --debug). */
export function hexdump(buf: Buffer): string {
  const lines: string[] = []
  for (let i = 0; i < buf.length; i += 16) {
    const chunk = [...buf.subarray(i, i + 16)].map((b) => b.toString(16).padStart(2, '0'))
    lines.push(`  ${i.toString(16).padStart(8, '0')}  ${chunk.slice(0, 8).join(' ')}  ${chunk.slice(8).join(' ')}`)
  }
  return lines.join('\n')
}
