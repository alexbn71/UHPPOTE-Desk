/**
 * Suite di test su hardware reale per controller UHPPOTE.
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
Uso: npm run hw -- --serial <S/N> [--ip <IP>] [opzioni]

Livelli (--level, es. 0,1,2 oppure 0-4; default 0,1):
  0  Rete: interfacce, ping, discovery broadcast, UDP unicast, TCP, confronto uhppoted-cli
  1  Sola lettura: dispositivo, ora, stato, listener, porte, tessere, eventi, latenza
  2  Scritture sicure con ripristino: ora, listener+auto-invio, tessera di test, fascia 254, ritardo porta, segnalibro
  3  Prove fisiche guidate: relè, swipe autorizzato/negato, fascia oraria, sensore, pulsante, PIN
  4  Robustezza: 100 richieste, carico tessere (--bulk), scollegamento rete, riavvio, raffica di swipe
  5  Deploy: esegue L0-L2 (da lanciare dentro il container sul NAS)

Opzioni:
  --serial <n>        numero di serie del controller (obbligatorio)
  --ip <addr>         IP del controller (senza: solo broadcast)
  --port <n>          porta del controller (default 60000)
  --tcp               usa TCP invece di UDP
  --bind <addr>       IP locale da usare (default 0.0.0.0)
  --broadcast <a:p>   indirizzo di broadcast (default 255.255.255.255:60000)
  --listen <a:p>      dove ricevere gli eventi (default 0.0.0.0:60001)
  --public-ip <addr>  IP di questo PC visto dal controller (default: rilevato)
  --timeout <ms>      timeout per richiesta (default 2500)
  --test-card <n>     tessera fittizia per i test di scrittura (default 25565535)
  --user-card <n>     tessera reale per le prove fisiche
  --bulk <n>          numero di tessere per il test di carico L4.2
  --only <ids>        esegue solo i test indicati (es. L1.2,L2.4)
  --cli <path>        percorso di uhppoted-cli per il confronto L0.7
  --destructive       consente i test distruttivi
  --yes               risponde automaticamente "sì" (solo livelli non fisici)
  --report <dir>      cartella dei report (default reports/)
`

function parseLevels(s: string): number[] {
  const out = new Set<number>()
  for (const part of s.split(',')) {
    const m = /^(\d)(?:-(\d))?$/.exec(part.trim())
    if (!m) throw new Error(`livello non valido: ${part}`)
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
  const ifs = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal) as os.NetworkInterfaceInfoIPv4[]
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
    if (this.autoYes) throw new Error('prova fisica non eseguibile con --yes')
    await this.rl.question(`\n  👉 ${message}\n     premi INVIO quando fatto… `)
  }

  async confirm(question: string): Promise<boolean> {
    if (this.autoYes) return true
    const a = await this.rl.question(`\n  ❓ ${question} [s/n] `)
    return /^(s|si|sì|y|yes)$/i.test(a.trim())
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

  console.log(`\nUHPPOTE Desk — test hardware controller ${opts.serial} (${opts.host ?? 'broadcast'}, ${opts.transport.toUpperCase()}), livelli ${levels.join(', ')}`)
  console.log(`IP di questo host per gli eventi: ${opts.publicIp ?? 'non rilevato'} (${opts.listen})\n`)

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
  console.log(`\nRisultato: ${results.filter((r) => r.status === 'pass').length} superati, ${failed} falliti, ${results.filter((r) => r.status === 'warn').length} avvisi, ${results.filter((r) => r.status === 'skip').length} saltati`)
  for (const f of reportFiles) console.log(`Report: ${f}`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(`Errore: ${(err as Error).message}`)
  process.exit(2)
})
