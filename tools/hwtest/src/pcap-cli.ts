/**
 * Reads a Wireshark capture (.pcapng/.pcap) of UHPPOTE traffic and shows what was written to the controller
 * parameter table with 0xF2 — typically the vendor software configuring the expansion board.
 *
 *   npm run pcap -- capture.pcapng
 *   npm run pcap -- capture.pcapng --expected expansion.json     # compare with a configuration
 *   npm run pcap -- capture.pcapng --json report.json            # machine-readable output
 *
 * `--expected` takes the `expansionBoard` object of GET /api/controllers/:id/settings (or a protocol
 * ExpansionBoardConfig): the bytes UHPPOTE Desk would write are compared with the ones in the capture.
 * Needs tshark (installed with Wireshark); set TSHARK to its path if it is not in the default place.
 * Exit code 2 when the comparison finds missing or different bytes.
 */
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { analyse, readCapture, toConfig, type PcapAnalysis } from './pcap.js'

const hex2 = (n: number) => `0x${n.toString(16).padStart(2, '0')}`

function print(a: PcapAnalysis): void {
  console.log(`\n${a.packets} UHPPOTE packets`)
  console.log('\nFunctions (64-byte protocol):')
  for (const f of a.functions)
    console.log(`  ${f.code} ${f.name.padEnd(26)} requests ${f.requests}, replies ${f.replies}, events ${f.events}`)
  if (a.longPackets.length) {
    console.log('\nVendor long-packet protocol:')
    for (const l of a.longPackets) console.log(`  ${l.length} bytes, type ${l.type}, code ${l.code}: ${l.count}`)
  }
  console.log(`\nParameter writes (0xF2 and vendor long write): ${a.writes.length}`)
  for (const w of a.writes)
    console.log(
      `  frame ${w.frame} ${w.via}: [${w.index}] = ${hex2(w.value)} (${w.value})${w.ok === null ? ' — no reply' : w.ok ? '' : ' — REFUSED'}`,
    )
  if (a.lastRead) {
    console.log(`
Last parameter table read from the controller (frame ${a.lastRead.frame}, S/N ${a.lastRead.serial}):`)
    console.log(JSON.stringify({ ...a.lastRead.expansion, alarmEvents: a.lastRead.alarmEvents }, null, 2))
  }
  if (a.expansion) {
    console.log('\nExpansion board reconstructed from the capture:')
    console.log(JSON.stringify(a.expansion, null, 2))
  }
  if (a.comparison) {
    const c = a.comparison
    const same = !c.missing.length && !c.different.length && !c.extra.length
    console.log(`\nComparison with --expected: ${same ? 'IDENTICAL' : 'DIFFERENT'}`)
    for (const m of c.missing) console.log(`  missing   [${m.index}] = ${hex2(m.value)}`)
    for (const d of c.different)
      console.log(`  different [${d.index}] expected ${hex2(d.expected)}, captured ${hex2(d.captured)}`)
    for (const i of c.extra)
      console.log(`  extra     [${i}] = ${hex2(a.table[i]!)} (written by the capture, not by UHPPOTE Desk)`)
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      expected: { type: 'string' },
      json: { type: 'string' },
      tshark: { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  if (values.help || positionals.length !== 1) {
    console.log('Usage: npm run pcap -- <capture.pcapng> [--expected expansion.json] [--json out.json] [--tshark path]')
    process.exit(values.help ? 0 : 1)
  }
  const packets = await readCapture(positionals[0]!, values.tshark)
  const expected = values.expected ? toConfig(JSON.parse(fs.readFileSync(values.expected, 'utf8'))) : undefined
  const a = analyse(packets, expected)
  print(a)
  if (values.json) fs.writeFileSync(values.json, JSON.stringify(a, null, 2))
  if (a.comparison && (a.comparison.missing.length || a.comparison.different.length)) process.exitCode = 2
}

main().catch((err: Error) => {
  console.error(err.message)
  process.exit(1)
})
