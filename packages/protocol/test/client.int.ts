/**
 * Integration: UhppoteClient ↔ FakeController on real UDP/TCP sockets (loopback).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  EventListener,
  EventOverwrittenError,
  NotFoundError,
  OperationFailedError,
  Reason,
  TimeoutError,
  UhppoteClient,
  type ControllerStatus,
  type ControllerTarget,
} from '../src/index.js'
import { FakeController } from '../src/testing/index.js'

const ID = 405419896
let fake: FakeController
let target: ControllerTarget
let client: UhppoteClient

beforeAll(async () => {
  fake = new FakeController({ id: ID, tcp: true })
  const ep = await fake.start()
  target = { id: ID, host: ep.host, port: ep.port }
  client = new UhppoteClient({
    bindAddress: '127.0.0.1',
    broadcast: `${ep.host}:${ep.port}`,
    timeoutMs: 500,
    retries: 1,
  })
})

afterAll(async () => {
  await fake.stop()
})

afterEach(() => {
  fake.offline = false
  fake.dropRate = 0
  fake.latencyMs = 0
  fake.dropNext = 0
})

describe('device', () => {
  it('discovery returns the controller', async () => {
    const found = await client.discover()
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      controller: ID,
      address: '192.168.1.100',
      version: 'v8.92',
      mac: '00:12:23:34:45:56',
    })
  })

  it('get controller via unicast UDP and TCP', async () => {
    expect((await client.getController(target)).controller).toBe(ID)
    expect((await client.getController({ ...target, transport: 'tcp' })).controller).toBe(ID)
  })

  it('set IPv4 without reply, verified with get controller', async () => {
    await client.setIPv4(target, '192.168.1.150', '255.255.255.0', '192.168.1.254')
    const info = await client.getController(target)
    expect(info.address).toBe('192.168.1.150')
    expect(info.gateway).toBe('192.168.1.254')
  })

  it('time: set and get', async () => {
    const set = await client.setTime(target, '2026-10-11 08:30:00')
    expect(set?.startsWith('2026-10-11 08:30')).toBe(true)
    const now = await client.getTime(target)
    expect(now?.startsWith('2026-10-11 08:3')).toBe(true)
    fake.clockOffsetMs = 0
  })

  it('listener: set and get', async () => {
    await client.setListener(target, { address: '192.168.1.10', port: 60001, interval: 0 })
    expect(await client.getListener(target)).toEqual({ address: '192.168.1.10', port: 60001, interval: 0 })
  })
})

describe('doors', () => {
  it('door control: set and get', async () => {
    const r = await client.setDoorControl(target, { door: 3, mode: 2, delay: 10 })
    expect(r).toEqual({ door: 3, mode: 2, delay: 10 })
    expect(await client.getDoorControl(target, 3)).toEqual({ door: 3, mode: 2, delay: 10 })
    await client.setDoorControl(target, { door: 3, mode: 3, delay: 5 })
  })

  it('remote opening generates event 44', async () => {
    await client.openDoor(target, 2)
    const status = await client.getStatus(target)
    expect(status.event).toMatchObject({ door: 2, reason: Reason.RemoteOpenDoor, granted: true })
  })
})

describe('cards', () => {
  const card = {
    card: 10058400,
    from: '2026-01-01',
    to: '2026-12-31',
    doors: [1, 0, 29, 0] as [number, number, number, number],
    pin: 7531,
    firstCard: [false, true, false, false] as [boolean, boolean, boolean, boolean],
  }

  it('put, get, count, delete, tombstone', async () => {
    await client.deleteAllCards(target)
    await client.putCard(target, card)
    await client.putCard(target, { ...card, card: 10058401 })
    await client.putCard(target, { ...card, card: 10058402 })
    expect(await client.getCards(target)).toBe(3)
    expect(await client.getCard(target, 10058400)).toEqual(card)
    expect(await client.getCard(target, 99999)).toBeNull()

    expect(await client.deleteCard(target, 10058401)).toBe(true)
    expect(await client.deleteCard(target, 10058401)).toBe(false)
    expect(await client.getCardAtIndex(target, 2)).toEqual({ state: 'deleted' })
    expect(await client.getCardAtIndex(target, 4)).toEqual({ state: 'empty' })

    const all = await client.listCards(target)
    expect(all.map((c) => c.card)).toEqual([10058400, 10058402])
  })

  it('put card replaces an existing card', async () => {
    await client.putCard(target, { ...card, pin: 0, doors: [0, 0, 0, 1] })
    expect(await client.getCard(target, card.card)).toMatchObject({ pin: 0, doors: [0, 0, 0, 1] })
  })
})

describe('time profiles, tasks, advanced', () => {
  it('time profile: set, get, clear', async () => {
    const profile = {
      id: 29,
      from: '2026-01-01',
      to: '2026-12-31',
      weekdays: [true, true, true, true, true, false, false] as [
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
        boolean,
      ],
      segments: [
        { start: '08:30', end: '12:30' },
        { start: '13:30', end: '17:30' },
      ],
      linkedTo: 3,
    }
    await client.setTimeProfile(target, profile)
    expect(await client.getTimeProfile(target, 29)).toEqual(profile)
    await client.clearTimeProfiles(target)
    expect(await client.getTimeProfile(target, 29)).toBeNull()
  })

  it('task list: clear, add, refresh', async () => {
    await client.clearTaskList(target)
    await client.addTask(target, {
      task: 1,
      from: '2026-01-01',
      to: '2026-12-31',
      weekdays: [true, true, true, true, true, false, false],
      start: '08:00',
      door: 1,
      moreCards: 0,
    })
    await client.refreshTaskList(target)
    expect(fake.tasksActive).toHaveLength(1)
    expect(fake.tasksActive[0]).toMatchObject({ task: 1, door: 1, start: '08:00' })
  })

  it('interlock, anti-passback, keypad, passcode, first-card, PC control, special events', async () => {
    await client.setInterlock(target, 3)
    expect(fake.interlock).toBe(3)
    await client.setAntiPassback(target, 2)
    expect(await client.getAntiPassback(target)).toBe(2)
    await client.activateKeypads(target, [true, false, true, false])
    expect(fake.keypads).toEqual([true, false, true, false])
    await client.setDoorPasscodes(target, 1, [12345, 999999])
    expect(fake.passcodes[0]).toEqual([12345, 999999])
    await client.setFirstCard(target, {
      door: 2,
      start: '08:00',
      end: '18:00',
      activeMode: 0,
      inactiveMode: 3,
      weekdays: [true, true, true, true, true, false, false],
    })
    expect(fake.firstCard.get(2)).toMatchObject({ activeMode: 0, inactiveMode: 3 })
    await client.setPCControl(target, false)
    await client.recordSpecialEvents(target, true)
    expect(fake.recordSpecialEvents).toBe(true)
  })

  it('a controller refusing a command produces OperationFailedError', async () => {
    fake.failOps.add(0x8c)
    try {
      await expect(client.setDoorPasscodes(target, 1, [1, 2])).rejects.toBeInstanceOf(OperationFailedError)
    } finally {
      fake.failOps.clear()
    }
  })
})

describe('expansion board (0xF2)', () => {
  it('setExpansionBoard writes the parameter table in packets of 8 and is decoded back', async () => {
    const before = fake.parameterWrites
    const config = {
      relays: [
        { active: true, source: 0, mode: 1, events: 0x04, signals: 0, duration: 5 },
        { active: true, source: 0, mode: 1, events: 0x02, signals: 0, duration: 10 },
        { active: false, source: 0, mode: 0, events: 0, signals: 0, duration: 0 },
        { active: true, source: 1, mode: 3, events: 0x20, signals: 0, duration: 0 },
      ],
      doorOpenTooLong: 8,
      duressCode: 889988,
    } as const
    await client.setExpansionBoard(target, structuredClone(config) as never)
    expect(fake.expansionBoard()).toEqual({
      ...config,
      openTooLongAlarm: false,
      invalidCardAlarmAfter3: false,
      duressAfterCard: false,
    })
    // 24 relay bytes + 30, 32, 35, 162 + 74, 75, 163 + 245, 252 = 33 bytes → 5 packets
    expect(fake.parameterWrites - before).toBe(5)
  })

  it('readParameters / readExpansionBoard read back what was written (unicast and broadcast)', async () => {
    const config = {
      relays: [
        { active: true, source: 0, mode: 1, events: 0x04, signals: 0, duration: 5 },
        { active: false, source: 0, mode: 0, events: 0, signals: 0, duration: 0 },
        { active: false, source: 0, mode: 0, events: 0, signals: 0, duration: 0 },
        { active: true, source: 3, mode: 4, events: 0, signals: 0x82, duration: 30 },
      ],
      doorOpenTooLong: 12,
      duressCode: 123456,
    }
    await client.setExpansionBoard(target, structuredClone(config) as never)
    const table = await client.readParameters(target)
    expect(table.length).toBe(1024)
    expect([table[0], table[1]]).toEqual([0x0d, 0x7e])
    expect(table[10]).toBe(fake.doors[0].mode)
    const state = await client.readExpansionBoard(target)
    expect(state).toMatchObject({ ...config, recordAlarmEvents: true, alarmEvents: 0x04 | 0x08 | 0x20 })
    // without host: broadcast, like the vendor software
    expect((await client.readExpansionBoard({ id: ID })).relays).toEqual(config.relays)
  })

  it('a 0xF2 write of the door bytes is applied to the door configuration', async () => {
    const before = await client.getDoorControl(target, 2)
    await client.writeParameters(target, [
      { index: 4, value: 70 },
      { index: 5, value: 0 },
    ])
    expect((await client.getDoorControl(target, 2)).delay).toBe(7)
    await client.setDoorControl(target, before)
    expect((await client.readParameters(target))[4]).toBe(before.delay * 10)
  })

  it('readParameters times out on an offline controller', async () => {
    fake.offline = true
    await expect(client.readParameters(target)).rejects.toBeInstanceOf(TimeoutError)
  })

  it('a refused write raises OperationFailedError', async () => {
    fake.failOps.add(0xf2)
    try {
      await expect(client.writeParameters(target, [{ index: 136, value: 0 }])).rejects.toBeInstanceOf(
        OperationFailedError,
      )
    } finally {
      fake.failOps.delete(0xf2)
    }
  })

  it('simulated alarms drive the configured relays (FakeController model)', async () => {
    await client.setExpansionBoard(target, {
      relays: [
        { active: true, source: 0, mode: 1, events: 0x04, signals: 0, duration: 1 },
        { active: false, source: 0, mode: 0, events: 0, signals: 0, duration: 0 },
        { active: false, source: 0, mode: 0, events: 0, signals: 0, duration: 0 },
        { active: true, source: 2, mode: 1, events: 0x20, signals: 0, duration: 1 },
      ],
      doorOpenTooLong: 25,
      duressCode: null,
    })
    fake.raiseAlarm(2, Reason.ForcedOpen)
    expect(fake.expansionOutputs).toEqual([false, false, false, false])
    fake.raiseAlarm(1, Reason.ForcedOpen)
    expect(fake.expansionOutputs[0]).toBe(true)
    fake.setFireInput(true)
    expect(fake.expansionOutputs[3]).toBe(true)
    expect((await client.getStatus(target)).fireAlarm).toBe(true)
    fake.setFireInput(false)
    expect((await client.getStatus(target)).fireAlarm).toBe(false)
  })

  it('probe returns the raw reply, or null without an answer', async () => {
    const reply = await client.probe(target, (await import('../src/index.js')).encode.getStatus(ID))
    expect(reply?.[1]).toBe(0x20)
    const unknown = Buffer.alloc(64)
    unknown[0] = 0x17
    unknown[1] = 0xc2
    unknown.writeUInt32LE(ID, 4)
    expect(await client.probe(target, unknown)).toBeNull()
  })
})

describe('events', () => {
  it('granted / denied swipe and read by index', async () => {
    await client.deleteAllCards(target)
    await client.putCard(target, {
      card: 10058400,
      from: '2020-01-01',
      to: '2099-12-31',
      doors: [1, 0, 0, 0],
      pin: 0,
      firstCard: [false, false, false, false],
    })
    const ok = fake.swipe(10058400, 1)
    const ko = fake.swipe(10058400, 2)
    const unknown = fake.swipe(123, 1)
    expect(ok).toMatchObject({ granted: true, reason: Reason.Swipe })
    expect(ko).toMatchObject({ granted: false, reason: Reason.NoAccessRights })
    expect(unknown.granted).toBe(false)

    const e = await client.getEvent(target, ok.index)
    expect(e).toMatchObject({ index: ok.index, card: 10058400, door: 1, granted: true })
    expect(await client.getLastEventIndex(target)).toBe(unknown.index)
    await expect(client.getEvent(target, unknown.index + 100)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('outside the time profile → reason 13', async () => {
    const now = fake.now()
    const day = (now.getDay() + 6) % 7
    const weekdays = [false, false, false, false, false, false, false] as [
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
      boolean,
    ]
    weekdays[(day + 1) % 7] = true // tomorrow only
    await client.setTimeProfile(target, {
      id: 10,
      from: '2020-01-01',
      to: '2099-12-31',
      weekdays,
      segments: [{ start: '00:00', end: '23:59' }],
      linkedTo: 0,
    })
    await client.putCard(target, {
      card: 10058499,
      from: '2020-01-01',
      to: '2099-12-31',
      doors: [10, 0, 0, 0],
      pin: 0,
      firstCard: [false, false, false, false],
    })
    expect(fake.swipe(10058499, 1)).toMatchObject({ granted: false, reason: Reason.NotInAllowedTimePeriod })
  })

  it('event index bookmark', async () => {
    await client.setEventIndex(target, 7)
    expect(await client.getEventIndex(target)).toBe(7)
  })

  it('events overwritten in the ring buffer', async () => {
    const small = new FakeController({ id: 111, eventCapacity: 10, eventDiscard: 4 })
    const ep = await small.start()
    try {
      for (let i = 0; i < 20; i++) small.swipe(1, 1)
      const t = { id: 111, host: ep.host, port: ep.port }
      await expect(client.getEvent(t, 1)).rejects.toBeInstanceOf(EventOverwrittenError)
      expect((await client.getEvent(t, small.lastEventIndex)).index).toBe(small.lastEventIndex)
    } finally {
      await small.stop()
    }
  })

  it('the listener receives push events (also with SOM 0x19)', async () => {
    const listener = new EventListener('127.0.0.1:0')
    const addr = await listener.start()
    const v662 = new FakeController({ id: 222, v662Events: true })
    const ep = await v662.start()
    try {
      const received: ControllerStatus[] = []
      listener.on('status', (s) => received.push(s))
      for (const [t, f] of [
        [target, fake],
        [{ id: 222, host: ep.host, port: ep.port }, v662],
      ] as const) {
        await client.setListener(t, { address: '127.0.0.1', port: addr.port, interval: 0 })
        f.swipe(10058400, 1)
      }
      await waitFor(() => received.length >= 2)
      expect(received.map((s) => s.controller).sort()).toEqual([222, ID].sort())
      expect(received.find((s) => s.controller === ID)?.event?.card).toBe(10058400)
    } finally {
      await listener.stop()
      await v662.stop()
      await client.setListener(target, { address: '0.0.0.0', port: 0, interval: 0 })
    }
  })

  it('periodic auto-send', async () => {
    const listener = new EventListener('127.0.0.1:0')
    const addr = await listener.start()
    try {
      let count = 0
      listener.on('status', () => count++)
      await client.setListener(target, { address: '127.0.0.1', port: addr.port, interval: 1 })
      await waitFor(() => count >= 2, 3500)
      expect(count).toBeGreaterThanOrEqual(2)
    } finally {
      await client.setListener(target, { address: '0.0.0.0', port: 0, interval: 0 })
      await listener.stop()
    }
  })
})

describe('robustness', () => {
  it('timeout with an offline controller', async () => {
    fake.offline = true
    const started = Date.now()
    await expect(client.getStatus(target)).rejects.toBeInstanceOf(TimeoutError)
    // idempotent operation: 1 attempt + 1 retry
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })

  it('no retry for non-idempotent operations', async () => {
    fake.offline = true
    const started = Date.now()
    await expect(client.openDoor(target, 1)).rejects.toBeInstanceOf(TimeoutError)
    expect(Date.now() - started).toBeLessThan(900)
  })

  it('retry recovers a lost packet', async () => {
    const attempts: number[] = []
    const c = new UhppoteClient({
      bindAddress: '127.0.0.1',
      timeoutMs: 300,
      retries: 2,
      onRequest: (i) => attempts.push(i.attempts),
    })
    fake.dropNext = 2 // the first two requests are lost, the third one gets a reply
    expect(await c.getTime(target)).not.toBeNull()
    expect(attempts).toEqual([3])
    fake.dropNext = 3 // more than the available attempts
    await expect(c.getTime(target)).rejects.toBeInstanceOf(TimeoutError)
    expect(attempts).toEqual([3, 3])
  })

  it('concurrent requests are serialised per controller', async () => {
    fake.latencyMs = 20
    const results = await Promise.all(Array.from({ length: 20 }, () => client.getCards(target)))
    expect(new Set(results).size).toBe(1)
  })

  it('TCP without IP is rejected', async () => {
    await expect(client.getStatus({ id: ID, transport: 'tcp' })).rejects.toThrow(/TCP requires/)
  })
})

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within the timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
}
