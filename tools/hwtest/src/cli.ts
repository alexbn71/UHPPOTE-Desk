/**
 * Test suite on real hardware for UHPPOTE controllers.
 *
 *   npm run hw -- --serial 423187757 --ip 192.168.1.100 --level 0,1,2
 *   npm run hw -- --serial 423187757 --ip 192.168.1.100 --level 3 --user-card 10058400
 *   npm run hw -- --help
 */
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { parseArgs } from 'node:util'
import type { Driver, Options, PhysicalAction, Status } from './framework.js'
import { runSuite } from './runner.js'

const HELP = `
Usage: npm run hw -- --serial <S/N> [--ip <IP>] [options]

Levels (--level, e.g. 0,1,2 or 0-4; default 0,1):
  0  Network: interfaces, ping, broadcast discovery, unicast UDP, TCP, comparison with uhppoted-cli
  1  Read-only: device, time, status, listener, doors, cards, events, latency
  2  Safe writes with restore: time, listener+auto-send, test card, time profile 254, door delay, bookmark
  3  Guided physical tests: relays, granted/denied swipe, time profile, sensor, button, PIN
  4  Robustness: 100 requests, card load (--bulk), network unplugged, restart, burst of swipes
  5  Deployment: runs L0-L2 (to be started inside the container on the NAS)
  6  UT0311-01A expansion board: parameter table read, 0xF2 mapping check, configuration write verified by read-back,
     guided relay tests (forced open, open too long, invalid card, fire input; duress code with --destructive).
     WARNING: overwrites the expansion board configuration and leaves all its outputs inactive.
  7  Reader and door options: four swipes = normally open, silent reader, swipe gap, door as switch, multi-card
     (written with 0xF2, verified by read-back; the original bytes are restored exactly at the end).

Options:
  --serial <n>        controller serial number (required)
  --ip <addr>         controller IP (without it: broadcast only)
  --port <n>          controller port (default 60000)
  --tcp               use TCP instead of UDP
  --bind <addr>       local IP to use (default 0.0.0.0)
  --broadcast <a:p>   broadcast address (default 255.255.255.255:60000)
  --listen <a:p>      where to receive events (default 0.0.0.0:60001)
  --public-ip <addr>  IP of this PC as seen by the controller (default: detected)
  --timeout <ms>      timeout per request (default 2500)
  --test-card <n>     dummy card for the write tests (default 25565535)
  --user-card <n>     real card for the physical tests
  --bulk <n>          number of cards for the L4.2 load test
  --only <ids>        run only these tests (e.g. L1.2,L2.4)
  --cli <path>        path of uhppoted-cli for the L0.7 comparison
  --destructive       allow destructive tests
  --yes               answer "yes" automatically (non-physical levels only)
  --report <dir>      report folder (default reports/)
`

function parseLevels(s: string): number[] {
  const out = new Set<number>()
  for (const part of s.split(',')) {
    const m = /^(\d)(?:-(\d))?$/.exec(part.trim())
    if (!m) throw new Error(`invalid level: ${part}`)
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    for (let i = a; i <= b; i++) out.add(i)
  }
  if (out.has(5)) {
    out.delete(5)
    ;[0, 1, 2].forEach((l) => out.add(l))
  }
  return [...out].sort()
}

function guessPublicIp(controllerIp: string | null): string | null {
  const ifs = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal) as os.NetworkInterfaceInfoIPv4[]
  if (controllerIp) {
    const toInt = (ip: string) => ip.split('.').reduce((a, p) => ((a << 8) | Number(p)) >>> 0, 0)
    const same = ifs.find((i) => (toInt(i.address) & toInt(i.netmask)) === (toInt(controllerIp) & toInt(i.netmask)))
    if (same) return same.address
  }
  return ifs[0]?.address ?? null
}

class ConsoleDriver implements Driver {
  private rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  constructor(private readonly autoYes: boolean) {}

  async perform(_action: PhysicalAction, message: string): Promise<void> {
    if (this.autoYes) throw new Error('physical test cannot run with --yes')
    await this.rl.question(`\n  👉 ${message}\n     press ENTER when done… `)
  }

  async confirm(question: string): Promise<boolean> {
    if (this.autoYes) return true
    const a = await this.rl.question(`\n  ❓ ${question} [y/n] `)
    return /^(y|yes)$/i.test(a.trim())
  }

  async ask(question: string): Promise<string> {
    if (this.autoYes) return ''
    return this.rl.question(`\n  ✏️  ${question}: `)
  }

  info(message: string): void {
    console.log(`  ℹ️  ${message}`)
  }

  close(): void {
    this.rl.close()
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      serial: { type: 'string' },
      ip: { type: 'string' },
      port: { type: 'string', default: '60000' },
      tcp: { type: 'boolean', default: false },
      bind: { type: 'string', default: '0.0.0.0' },
      broadcast: { type: 'string', default: '255.255.255.255:60000' },
      listen: { type: 'string', default: '0.0.0.0:60001' },
      'public-ip': { type: 'string' },
      timeout: { type: 'string', default: '2500' },
      'test-card': { type: 'string', default: '25565535' },
      'user-card': { type: 'string' },
      bulk: { type: 'string', default: '0' },
      only: { type: 'string' },
      cli: { type: 'string' },
      level: { type: 'string', default: '0,1' },
      destructive: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      report: { type: 'string', default: process.env.HWTEST_REPORT_DIR ?? 'reports' },
      help: { type: 'boolean', default: false },
    },
  })
  if (values.help || !values.serial) {
    console.log(HELP)
    process.exit(values.help ? 0 : 1)
  }

  const host = values.ip ?? null
  const opts: Options = {
    serial: Number(values.serial),
    host,
    port: Number(values.port),
    transport: values.tcp ? 'tcp' : 'udp',
    bind: values.bind!,
    broadcast: values.broadcast!,
    listen: values.listen!,
    publicIp: values['public-ip'] ?? guessPublicIp(host),
    timeoutMs: Number(values.timeout),
    destructive: values.destructive!,
    bulk: Number(values.bulk),
    testCard: Number(values['test-card']),
    userCard: values['user-card'] ? Number(values['user-card']) : null,
    cliPath: values.cli ?? null,
  }
  const levels = parseLevels(values.level!)
  const driver = new ConsoleDriver(values.yes!)
  const icon: Record<Status, string> = { pass: '✅', fail: '❌', warn: '⚠️ ', skip: '⏭️ ' }

  console.log(
    `\nUHPPOTE Desk — hardware test of controller ${opts.serial} (${opts.host ?? 'broadcast'}, ${opts.transport.toUpperCase()}), levels ${levels.join(', ')}`,
  )
  console.log(`IP of this host for events: ${opts.publicIp ?? 'not detected'} (${opts.listen})\n`)

  const { results, reportFiles } = await runSuite(opts, levels, driver, {
    reportDir: path.resolve(values.report!),
    ...(values.only ? { only: values.only.split(',').map((s) => s.trim()) } : {}),
    onResult: (r) => {
      console.log(`${icon[r.status]} ${r.id.padEnd(6)} ${r.name} (${r.durationMs} ms)`)
      for (const d of r.details) console.log(`         ${d}`)
    },
  })
  driver.close()

  const failed = results.filter((r) => r.status === 'fail').length
  console.log(
    `\nResult: ${results.filter((r) => r.status === 'pass').length} passed, ${failed} failed, ${results.filter((r) => r.status === 'warn').length} warnings, ${results.filter((r) => r.status === 'skip').length} skipped`,
  )
  for (const f of reportFiles) console.log(`Report: ${f}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`)
  process.exit(2)
})
