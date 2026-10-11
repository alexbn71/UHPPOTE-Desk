import type { ControllerStatus, ControllerTarget, UhppoteClient } from '@uhppote-desk/protocol'

export type Status = 'pass' | 'fail' | 'warn' | 'skip'

export interface TestResult {
  id: string
  level: number
  name: string
  status: Status
  durationMs: number
  details: string[]
  data?: unknown
}

/** Azioni fisiche richieste all'operatore (o eseguite da un driver simulato nei test). */
export type PhysicalAction =
  | { kind: 'observe-relay'; door: number }
  | { kind: 'swipe'; card: number | null; door: number; pin?: number }
  | { kind: 'door-sensor'; door: number; open: boolean }
  | { kind: 'press-button'; door: number }
  | { kind: 'unplug' }
  | { kind: 'replug' }
  | { kind: 'power-cycle' }
  | { kind: 'swipe-burst'; card: number | null; door: number; count: number }

export interface Driver {
  /** Chiede all'operatore di eseguire un'azione; risolve quando l'operatore conferma di averla eseguita. */
  perform(action: PhysicalAction, message: string): Promise<void>
  /** Domanda sì/no all'operatore (es. "hai sentito lo scatto del relè?"). */
  confirm(question: string, action?: PhysicalAction): Promise<boolean>
  /** Domanda con risposta libera (es. numero di tessera). */
  ask(question: string): Promise<string>
  info(message: string): void
}

export interface Options {
  serial: number
  host: string | null
  port: number
  transport: 'udp' | 'tcp'
  bind: string
  broadcast: string
  /** IP:porta locale per ricevere gli eventi (il controller verrà temporaneamente puntato qui). */
  listen: string
  /** IP di questo host come visto dal controller (per set-listener). */
  publicIp: string | null
  timeoutMs: number
  destructive: boolean
  bulk: number
  /** Numero tessera di test (non deve esistere sul controller). */
  testCard: number
  /** Tessera reale dell'operatore per i test fisici (null = chiesta durante il test). */
  userCard: number | null
  cliPath: string | null
}

export interface Context {
  opts: Options
  client: UhppoteClient
  target: ControllerTarget
  driver: Driver
  /** Eventi ricevuti dal listener temporaneo durante i test. */
  events: ControllerStatus[]
  /** Attende un evento che soddisfa il predicato. */
  waitEvent(pred: (s: ControllerStatus) => boolean, timeoutMs: number): Promise<ControllerStatus | null>
  /** Valori salvati per il ripristino. */
  backup: Record<string, unknown>
  /** Raccolta condivisa fra test (es. firmware). */
  facts: Record<string, unknown>
}

export interface TestCase {
  id: string
  level: number
  name: string
  /** Richiede interazione fisica. */
  physical?: boolean
  /** Richiede --destructive. */
  destructive?: boolean
  run(ctx: Context, t: TestHelpers): Promise<void>
}

export class SkipError extends Error {}
export class WarnError extends Error {}

export interface TestHelpers {
  log(line: string): void
  data(value: unknown): void
  skip(reason: string): never
  warn(reason: string): never
  assert(cond: unknown, message: string): asserts cond
}

export async function runTests(ctx: Context, tests: TestCase[], onResult?: (r: TestResult) => void): Promise<TestResult[]> {
  const results: TestResult[] = []
  for (const tc of tests) {
    const details: string[] = []
    let data: unknown
    const helpers: TestHelpers = {
      log: (l) => details.push(l),
      data: (v) => (data = v),
      skip: (r) => {
        throw new SkipError(r)
      },
      warn: (r) => {
        throw new WarnError(r)
      },
      assert: (cond, message) => {
        if (!cond) throw new Error(message)
      },
    }
    const started = Date.now()
    let status: Status = 'pass'
    try {
      if (tc.destructive && !ctx.opts.destructive) throw new SkipError('richiede --destructive')
      await tc.run(ctx, helpers)
    } catch (err) {
      if (err instanceof SkipError) status = 'skip'
      else if (err instanceof WarnError) status = 'warn'
      else status = 'fail'
      details.push((err as Error).message)
    }
    const r: TestResult = { id: tc.id, level: tc.level, name: tc.name, status, durationMs: Date.now() - started, details, ...(data !== undefined ? { data } : {}) }
    results.push(r)
    onResult?.(r)
  }
  return results
}

export function summarize(results: TestResult[]): Record<Status, number> {
  const s: Record<Status, number> = { pass: 0, fail: 0, warn: 0, skip: 0 }
  for (const r of results) s[r.status]++
  return s
}

export function toMarkdown(results: TestResult[], opts: Options, facts: Record<string, unknown>, startedAt: Date): string {
  const s = summarize(results)
  const icon: Record<Status, string> = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭️' }
  const lines = [
    `# Report test hardware UHPPOTE`,
    '',
    `- Data: ${startedAt.toLocaleString('it-IT')}`,
    `- Controller: ${opts.serial} @ ${opts.host ?? 'broadcast'}:${opts.port} (${opts.transport})`,
    `- Firmware: ${String(facts.firmware ?? 'n/d')}`,
    `- Host: bind ${opts.bind}, broadcast ${opts.broadcast}, listener ${opts.publicIp ?? '?'} (${opts.listen})`,
    `- Esito: ${s.pass} superati, ${s.fail} falliti, ${s.warn} avvisi, ${s.skip} saltati`,
    '',
    '| ID | Livello | Test | Esito | Durata | Dettagli |',
    '|---|---|---|---|---|---|',
    ...results.map(
      (r) => `| ${r.id} | L${r.level} | ${r.name} | ${icon[r.status]} ${r.status} | ${r.durationMs} ms | ${r.details.join('<br>').replaceAll('|', '\\|')} |`,
    ),
    '',
  ]
  return lines.join('\n')
}
