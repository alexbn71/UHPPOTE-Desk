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

/** Physical actions requested from the operator (or performed by a simulated driver in the tests). */
export type PhysicalAction =
  | { kind: 'observe-relay'; door: number }
  | { kind: 'swipe'; card: number | null; door: number; pin?: number }
  | { kind: 'door-sensor'; door: number; open: boolean }
  | { kind: 'press-button'; door: number }
  | { kind: 'unplug' }
  | { kind: 'replug' }
  | { kind: 'power-cycle' }
  | { kind: 'swipe-burst'; card: number | null; door: number; count: number }
  /** Open the door by hand without a valid access (key, unlatched door): forced open. */
  | { kind: 'force-door'; door: number }
  /** Open the door with a valid access and keep it open for `seconds`. */
  | { kind: 'hold-door-open'; door: number; seconds: number }
  /** Close/open the fire input of the expansion board. */
  | { kind: 'fire-input'; active: boolean }
  /** Type a code on the PIN keypad of the door reader. */
  | { kind: 'keypad-code'; door: number; code: number }

export interface Driver {
  /** Asks the operator to perform an action; resolves when the operator confirms it is done. */
  perform(action: PhysicalAction, message: string): Promise<void>
  /** Yes/no question to the operator (e.g. "did you hear the relay click?"). */
  confirm(question: string, action?: PhysicalAction): Promise<boolean>
  /** Free-text question (e.g. a card number). */
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
  /** Local IP:port to receive events (the controller is temporarily pointed here). */
  listen: string
  /** IP of this host as seen by the controller (for set-listener). */
  publicIp: string | null
  timeoutMs: number
  destructive: boolean
  bulk: number
  /** Test card number (must not exist on the controller). */
  testCard: number
  /** The operator's real card for the physical tests (null = asked during the test). */
  userCard: number | null
  cliPath: string | null
}

export interface Context {
  opts: Options
  client: UhppoteClient
  target: ControllerTarget
  driver: Driver
  /** Events received by the temporary listener during the tests. */
  events: ControllerStatus[]
  /** Waits for an event matching the predicate. */
  waitEvent(pred: (s: ControllerStatus) => boolean, timeoutMs: number): Promise<ControllerStatus | null>
  /** Values saved for the restore. */
  backup: Record<string, unknown>
  /** Facts shared between tests (e.g. firmware). */
  facts: Record<string, unknown>
}

export interface TestCase {
  id: string
  level: number
  name: string
  /** Requires physical interaction. */
  physical?: boolean
  /** Requires --destructive. */
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

export async function runTests(
  ctx: Context,
  tests: TestCase[],
  onResult?: (r: TestResult) => void,
): Promise<TestResult[]> {
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
      if (tc.destructive && !ctx.opts.destructive) throw new SkipError('requires --destructive')
      await tc.run(ctx, helpers)
    } catch (err) {
      if (err instanceof SkipError) status = 'skip'
      else if (err instanceof WarnError) status = 'warn'
      else status = 'fail'
      details.push((err as Error).message)
    }
    const r: TestResult = {
      id: tc.id,
      level: tc.level,
      name: tc.name,
      status,
      durationMs: Date.now() - started,
      details,
      ...(data !== undefined ? { data } : {}),
    }
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

export function toMarkdown(
  results: TestResult[],
  opts: Options,
  facts: Record<string, unknown>,
  startedAt: Date,
): string {
  const s = summarize(results)
  const icon: Record<Status, string> = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭️' }
  const lines = [
    `# UHPPOTE hardware test report`,
    '',
    `- Date: ${startedAt.toLocaleString('en-GB')}`,
    `- Controller: ${opts.serial} @ ${opts.host ?? 'broadcast'}:${opts.port} (${opts.transport})`,
    `- Firmware: ${String(facts.firmware ?? 'n/a')}`,
    `- Host: bind ${opts.bind}, broadcast ${opts.broadcast}, listener ${opts.publicIp ?? '?'} (${opts.listen})`,
    `- Result: ${s.pass} passed, ${s.fail} failed, ${s.warn} warnings, ${s.skip} skipped`,
    '',
    '| ID | Level | Test | Result | Duration | Details |',
    '|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.id} | L${r.level} | ${r.name} | ${icon[r.status]} ${r.status} | ${r.durationMs} ms | ${r.details.join('<br>').replaceAll('|', '\\|')} |`,
    ),
    '',
  ]
  return lines.join('\n')
}
