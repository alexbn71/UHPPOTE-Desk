import fs from 'node:fs'
import path from 'node:path'
import { EventListener, UhppoteClient, type ControllerStatus } from '@uhppote-desk/protocol'
import { runTests, summarize, toMarkdown, type Context, type Driver, type Options, type TestResult } from './framework.js'
import { ALL_LEVELS, restore } from './tests.js'

export interface RunResult {
  results: TestResult[]
  facts: Record<string, unknown>
  reportFiles: string[]
}

export async function runSuite(
  opts: Options,
  levels: number[],
  driver: Driver,
  config: { reportDir?: string | null; only?: string[]; onResult?: (r: TestResult) => void } = {},
): Promise<RunResult> {
  const client = new UhppoteClient({ bindAddress: opts.bind, broadcast: opts.broadcast, timeoutMs: opts.timeoutMs, retries: 1 })
  const target = { id: opts.serial, host: opts.host, port: opts.port, transport: opts.transport }
  const events: ControllerStatus[] = []
  const waiters = new Set<() => void>()
  const listener = new EventListener(opts.listen)
  listener.on('status', (s) => {
    if (s.controller !== opts.serial) return
    events.push(s)
    for (const w of waiters) w()
  })
  await listener.start()

  const ctx: Context = {
    opts,
    client,
    target,
    driver,
    events,
    backup: {},
    facts: {},
    waitEvent: (pred, timeoutMs) =>
      new Promise((resolve) => {
        const check = () => {
          const found = events.find(pred)
          if (found) {
            cleanup()
            resolve(found)
          }
        }
        const timer = setTimeout(() => {
          cleanup()
          resolve(null)
        }, timeoutMs)
        const cleanup = () => {
          clearTimeout(timer)
          waiters.delete(check)
        }
        waiters.add(check)
        check()
      }),
  }

  const started = new Date()
  const tests = levels.flatMap((l) => ALL_LEVELS[l] ?? []).filter((t) => !config.only?.length || config.only.includes(t.id))
  let results: TestResult[] = []
  try {
    results = await runTests(ctx, tests, config.onResult)
  } finally {
    for (const line of await restore(ctx)) driver.info(line)
    await listener.stop()
  }

  const reportFiles: string[] = []
  if (config.reportDir) {
    fs.mkdirSync(config.reportDir, { recursive: true })
    const stamp = started.toISOString().replace(/[:T]/g, '-').slice(0, 19)
    const base = path.join(config.reportDir, `hwtest-${opts.serial}-${stamp}`)
    fs.writeFileSync(`${base}.md`, toMarkdown(results, opts, ctx.facts, started))
    fs.writeFileSync(`${base}.json`, JSON.stringify({ startedAt: started, options: opts, facts: ctx.facts, summary: summarize(results), results, backup: ctx.backup }, null, 2))
    reportFiles.push(`${base}.md`, `${base}.json`)
  }
  return { results, facts: ctx.facts, reportFiles }
}
