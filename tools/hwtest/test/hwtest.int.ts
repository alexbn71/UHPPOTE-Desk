/**
 * Test of the hardware suite itself: all levels (physical ones included) run against the FakeController,
 * with a driver that performs the "physical actions" on the simulator.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Reason } from '@uhppote-desk/protocol'
import { FakeController } from '@uhppote-desk/protocol/testing'
import type { Driver, Options, PhysicalAction } from '../src/framework.js'
import { runSuite } from '../src/runner.js'

const SERIAL = 405419896
const USER_CARD = 10058400
let fake: FakeController
let opts: Options

class FakeDriver implements Driver {
  readonly prompts: string[] = []
  constructor(private readonly f: FakeController) {}
  async perform(action: PhysicalAction, message: string): Promise<void> {
    this.prompts.push(message)
    const f = this.f
    switch (action.kind) {
      case 'swipe':
        setTimeout(() => f.swipe(action.card ?? USER_CARD, action.door, 1, action.pin), 50)
        break
      case 'swipe-burst':
        for (let i = 0; i < action.count; i++) f.swipe(action.card ?? USER_CARD, action.door)
        break
      case 'door-sensor':
        setTimeout(() => f.setDoorSensor(action.door, action.open), 50)
        break
      case 'press-button':
        setTimeout(() => f.pressButton(action.door), 50)
        break
      case 'unplug':
        f.offline = true
        break
      case 'replug':
        f.offline = false
        break
      case 'power-cycle':
        f.event(3, false, 0, 1, 0, 28)
        break
      case 'force-door':
        setTimeout(() => f.raiseAlarm(action.door, Reason.ForcedOpen), 50)
        break
      case 'hold-door-open':
        setTimeout(() => f.raiseAlarm(action.door, Reason.DoorOpenTooLong), 50)
        break
      case 'fire-input':
        setTimeout(() => f.setFireInput(action.active), 50)
        break
      case 'keypad-code':
        setTimeout(() => f.raiseAlarm(action.door, Reason.PushButtonThreat), 50)
        break
      case 'observe-relay':
        break
    }
  }
  async confirm(question: string, action?: PhysicalAction): Promise<boolean> {
    // questions about the expansion board outputs are answered from the simulated relays
    if (action?.kind === 'observe-relay' && /expansion board/i.test(question)) return this.f.expansionOutputs[action.door - 1]!
    return true
  }
  async ask(): Promise<string> {
    return String(USER_CARD)
  }
  info(): void {}
}

beforeAll(async () => {
  fake = new FakeController({ id: SERIAL, tcp: true, address: '127.0.0.1', netmask: '255.0.0.0', gateway: '127.0.0.1' })
  const ep = await fake.start()
  opts = {
    serial: SERIAL,
    host: ep.host,
    port: ep.port,
    transport: 'udp',
    bind: '127.0.0.1',
    broadcast: `${ep.host}:${ep.port}`,
    listen: '127.0.0.1:60041',
    publicIp: '127.0.0.1',
    timeoutMs: 400,
    destructive: false,
    bulk: 50,
    testCard: 25565535,
    userCard: USER_CARD,
    cliPath: null,
  }
  // some cards and an initial "production" state to preserve
  fake.cardSlots.push({ card: 10000001, from: '2020-01-01', to: '2099-12-31', doors: [1, 1, 1, 1], pin: 0, firstCard: [false, false, false, false] })
  fake.listener = { address: '10.0.0.5', port: 60001, interval: 0 }
})

afterAll(async () => {
  await fake.stop()
})

describe('hardware suite against FakeController', () => {
  it('levels 0-4 pass and the controller state is restored', async () => {
    const driver = new FakeDriver(fake)
    const { results } = await runSuite(opts, [0, 1, 2, 3, 4], driver)
    const failed = results.filter((r) => r.status === 'fail')
    expect(failed.map((f) => `${f.id}: ${f.details.join(' / ')}`)).toEqual([])
    const byId = Object.fromEntries(results.map((r) => [r.id, r.status]))
    expect(byId['L0.5']).toBe('pass')
    expect(byId['L0.6']).toBe('pass')
    expect(byId['L2.2']).toBe('pass')
    expect(byId['L2.4']).toBe('pass')
    expect(byId['L3.5']).toBe('pass')
    expect(byId['L3.6']).toBe('pass')
    expect(byId['L3.7']).toBe('pass')
    expect(byId['L3.8']).toBe('pass')
    expect(byId['L3.9']).toBe('pass')
    expect(byId['L4.2']).toBe('pass')
    expect(byId['L4.3']).toBe('pass')
    // original state preserved
    expect(fake.listener).toEqual({ address: '10.0.0.5', port: 60001, interval: 0 })
    expect(fake.cards.map((c) => c.card)).toEqual([10000001])
    expect(fake.doors[0]).toEqual({ mode: 3, delay: 5 })
  }, 120_000)

  it('level 6 (expansion board) passes and leaves all outputs inactive', async () => {
    const driver = new FakeDriver(fake)
    const delayBefore = fake.doors[0].delay
    const { results } = await runSuite({ ...opts, destructive: true }, [6], driver)
    const byId = Object.fromEntries(results.map((r) => [r.id, r]))
    expect(results.filter((r) => r.status === 'fail').map((f) => `${f.id}: ${f.details.join(' / ')}`)).toEqual([])
    // the simulator answers neither 0xC2 nor applies the table to get-door-control: warnings, not failures
    expect(byId['L6.1']!.status).toBe('warn')
    expect(byId['L6.2']!.status).toBe('warn')
    for (const id of ['L6.3', 'L6.4', 'L6.5', 'L6.6', 'L6.7', 'L6.8']) expect(byId[id]!.status, id).toBe('pass')
    expect(fake.doors[0].delay).toBe(delayBefore)
    expect(fake.expansionBoard().relays.every((r) => !r.active)).toBe(true)
    expect(fake.expansionBoard().doorOpenTooLong).toBe(25)
    expect(fake.listener).toEqual({ address: '10.0.0.5', port: 60001, interval: 0 })
  }, 120_000)

  it('level 6 fails when an output does not switch (relay not configured on the controller)', async () => {
    fake.failOps.add(0xf2)
    try {
      const { results } = await runSuite(opts, [6], new FakeDriver(fake), { only: ['L6.3', 'L6.4'] })
      expect(results.map((r) => r.status)).toEqual(['fail', 'fail'])
    } finally {
      fake.failOps.delete(0xf2)
    }
  }, 60_000)

  it('detects a controller that does not answer', async () => {
    fake.offline = true
    try {
      const { results } = await runSuite({ ...opts, timeoutMs: 200 }, [1], new FakeDriver(fake), { only: ['L1.1'] })
      expect(results[0]!.status).toBe('fail')
      expect(results[0]!.details.join()).toMatch(/no reply/)
    } finally {
      fake.offline = false
    }
  })
})
