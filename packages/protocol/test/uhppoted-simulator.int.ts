/**
 * Integrazione con il simulatore ufficiale uhppoted (implementazione indipendente, scritta in Go).
 * Eseguito solo se la variabile UHPPOTED_SIM indica l'host del simulatore (es. 127.0.0.1).
 *
 *   tools/bin/simulator/uhppote-simulator.exe --devices <dir>     (UDP/TCP :60000, REST :8000)
 *   UHPPOTED_SIM=127.0.0.1 npm run test:int
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EventListener, Reason, UhppoteClient, type ControllerStatus, type ControllerTarget } from '../src/index.js'

const SIM = process.env.UHPPOTED_SIM
const REST = `http://${SIM ?? '127.0.0.1'}:${process.env.UHPPOTED_SIM_REST_PORT ?? '8000'}/uhppote/simulator`
const ID = 405419897

async function rest(method: string, path = '', body?: unknown): Promise<Response> {
  return fetch(`${REST}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : null,
  })
}

describe.skipIf(!SIM)('simulatore uhppoted', () => {
  let client: UhppoteClient
  const udp: ControllerTarget = { id: ID, host: SIM!, port: 60000 }
  const tcp: ControllerTarget = { ...udp, transport: 'tcp' }

  beforeAll(async () => {
    await rest('DELETE', `/${ID}`).catch(() => undefined)
    const res = await rest('POST', '', { 'device-id': ID, 'device-type': 'UT0311-L04', compressed: false })
    expect([200, 201]).toContain(res.status)
    client = new UhppoteClient({ timeoutMs: 1500, retries: 1 })
  })

  afterAll(async () => {
    await rest('DELETE', `/${ID}`).catch(() => undefined)
  })

  it('get controller (UDP e TCP)', async () => {
    const a = await client.getController(udp)
    const b = await client.getController(tcp)
    expect(a.controller).toBe(ID)
    expect(b).toEqual(a)
  })

  it('discovery in broadcast di loopback', async () => {
    const found = await client.discover(`${SIM}:60000`)
    expect(found.map((c) => c.controller)).toContain(ID)
  })

  it('ora', async () => {
    await client.setTime(udp, '2026-10-11 12:00:00')
    expect((await client.getTime(udp))?.slice(0, 13)).toBe('2026-10-11 12')
  })

  it('door control', async () => {
    await client.setDoorControl(udp, { door: 4, mode: 1, delay: 9 })
    expect(await client.getDoorControl(udp, 4)).toEqual({ door: 4, mode: 1, delay: 9 })
    await client.setDoorControl(udp, { door: 4, mode: 3, delay: 5 })
  })

  it('tessere: put/get/list/delete', async () => {
    await client.deleteAllCards(udp)
    const card = {
      card: 10058400,
      from: '2026-01-01',
      to: '2026-12-31',
      doors: [1, 0, 0, 1] as [number, number, number, number],
      pin: 7531,
      firstCard: [false, false, false, false] as [boolean, boolean, boolean, boolean],
    }
    await client.putCard(udp, card)
    await client.putCard(tcp, { ...card, card: 10058401 })
    expect(await client.getCards(udp)).toBe(2)
    expect(await client.getCard(udp, 10058400)).toMatchObject({ card: 10058400, from: '2026-01-01', to: '2026-12-31', doors: [1, 0, 0, 1], pin: 7531 })
    expect((await client.listCards(udp)).map((c) => c.card).sort()).toEqual([10058400, 10058401])
    expect(await client.deleteCard(udp, 10058401)).toBe(true)
    expect(await client.getCard(udp, 10058401)).toBeNull()
  })

  it('profilo orario', async () => {
    const profile = {
      id: 29,
      from: '2026-01-01',
      to: '2026-12-31',
      weekdays: [true, true, true, true, true, false, false] as [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
      segments: [{ start: '08:30', end: '17:30' }],
      linkedTo: 0,
    }
    await client.setTimeProfile(udp, profile)
    expect(await client.getTimeProfile(udp, 29)).toEqual(profile)
  })

  it('task, interblocco, anti-passback, keypad, passcode, special events', async () => {
    await client.clearTaskList(udp)
    await client.addTask(udp, { task: 2, from: '2026-01-01', to: '2026-12-31', weekdays: [true, true, true, true, true, true, true], start: '22:00', door: 1, moreCards: 0 })
    await client.refreshTaskList(udp)
    await client.setInterlock(udp, 0)
    await client.setAntiPassback(udp, 1)
    expect(await client.getAntiPassback(udp)).toBe(1)
    await client.setAntiPassback(udp, 0)
    await client.activateKeypads(udp, [false, false, false, false])
    await client.setDoorPasscodes(udp, 1, [123456])
    // set-first-card (0xAA) NON è supportato dal simulatore v0.9.0: va in panic ("unsupported message type").
    // È coperto dai vettori ufficiali e dal FakeController.
    await client.recordSpecialEvents(udp, true)
  })

  it('swipe simulato → evento sul listener e leggibile per indice', async () => {
    const listener = new EventListener('0.0.0.0:60011')
    await listener.start()
    const received: ControllerStatus[] = []
    listener.on('status', (s) => received.push(s))
    try {
      await client.setListener(udp, { address: '127.0.0.1', port: 60011, interval: 0 })
      const res = await rest('POST', `/${ID}/swipe`, { door: 1, 'card-number': 10058400, direction: 1, PIN: 7531 })
      expect(res.ok).toBe(true)
      const deadline = Date.now() + 3000
      while (!received.some((s) => s.event?.card === 10058400) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      const ev = received.find((s) => s.event?.card === 10058400)?.event
      expect(ev).toMatchObject({ card: 10058400, door: 1, granted: true })
      expect(await client.getEvent(udp, ev!.index)).toMatchObject({ card: 10058400, reason: Reason.Swipe })
    } finally {
      await client.setListener(udp, { address: '0.0.0.0', port: 0, interval: 0 })
      await listener.stop()
    }
  })

  it('apertura remota', async () => {
    await client.openDoor(udp, 3)
    const s = await client.getStatus(udp)
    expect(s.controller).toBe(ID)
  })

  it('segnalibro eventi', async () => {
    await client.setEventIndex(udp, 1)
    expect(await client.getEventIndex(udp)).toBe(1)
  })
})
