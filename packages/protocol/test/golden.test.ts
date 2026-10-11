/**
 * Golden test: il codec deve produrre/decodificare esattamente i pacchetti dei vettori ufficiali di uhppoted-codegen.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decode, encode, type Weekdays } from '../src/index.js'

interface Value {
  name: string
  type: string
  value: string | number | boolean
}
interface Vector {
  name: string
  request: { values: Value[]; message: string }
  response?: { values: Value[]; message: string }
}

const data = JSON.parse(
  readFileSync(new URL('./fixtures/uhppoted-codegen-test-data.json', import.meta.url), 'utf8'),
) as { testdata: { tests: Vector[] } }

const vectors = data.testdata.tests

function getter(values: Value[]) {
  const map = new Map(values.map((v) => [v.name, v.value]))
  const raw = (name: string) => {
    if (!map.has(name)) throw new Error(`campo '${name}' assente nel vettore`)
    return map.get(name)!
  }
  return {
    num: (name: string) => Number(raw(name)),
    str: (name: string) => String(raw(name)),
    bool: (name: string) => raw(name) === true || raw(name) === 'true',
    days: (): Weekdays =>
      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(
        (d) => raw(d) === true || raw(d) === 'true',
      ) as Weekdays,
  }
}

type Spec = {
  encode: (g: ReturnType<typeof getter>) => Buffer
  decode?: (buf: Buffer, g: ReturnType<typeof getter>) => void
}

const ID = 405419896

const specs: Record<string, Spec> = {
  'get controller': {
    encode: (g) => encode.getController(g.num('controller')),
    decode: (b, g) =>
      expect(decode.getController(b)).toEqual({
        controller: g.num('controller'),
        address: g.str('ip address'),
        netmask: g.str('subnet mask'),
        gateway: g.str('gateway'),
        mac: g.str('MAC address'),
        version: g.str('version'),
        date: g.str('date'),
      }),
  },
  'set IPv4': {
    encode: (g) => encode.setIPv4(g.num('controller'), g.str('address'), g.str('netmask'), g.str('gateway')),
  },
  'get time': {
    encode: (g) => encode.getTime(g.num('controller')),
    decode: (b, g) => expect(decode.getTime(b)).toEqual({ controller: ID, datetime: g.str('date time') }),
  },
  'set time': {
    encode: (g) => encode.setTime(g.num('controller'), g.str('datetime')),
    decode: (b, g) => expect(decode.setTime(b)).toEqual({ controller: ID, datetime: g.str('date time') }),
  },
  'get status': {
    encode: (g) => encode.getStatus(g.num('controller')),
    decode: (b, g) => {
      const s = decode.getStatus(b)
      expect(s.controller).toBe(ID)
      expect(s.systemDate).toBe(g.str('system date'))
      expect(s.systemTime).toBe(g.str('system time'))
      expect(s.doorOpen).toEqual([1, 2, 3, 4].map((d) => g.bool(`door ${d} open`)))
      expect(s.buttonPressed).toEqual([1, 2, 3, 4].map((d) => g.bool(`door ${d} button`)))
      expect(s.relays).toBe(g.num('relays'))
      expect(s.inputs).toBe(g.num('inputs'))
      expect(s.systemError).toBe(g.num('system error'))
      expect(s.specialInfo).toBe(g.num('special info'))
      expect(s.sequenceNo).toBe(g.num('sequence no'))
      if (g.num('event index') === 0) {
        expect(s.event).toBeNull()
      } else {
        expect(s.event).toEqual({
          index: g.num('event index'),
          type: g.num('event type'),
          granted: g.bool('event access granted'),
          door: g.num('event door'),
          direction: g.num('event direction'),
          card: g.num('event card'),
          timestamp: g.str('event timestamp') || null,
          reason: g.num('event reason'),
        })
      }
    },
  },
  'get listener': {
    encode: (g) => encode.getListener(g.num('controller')),
    decode: (b, g) =>
      expect(decode.getListener(b)).toEqual({
        controller: ID,
        address: g.str('address'),
        port: g.num('port'),
        interval: g.num('interval'),
      }),
  },
  'set listener': {
    encode: (g) =>
      encode.setListener(g.num('controller'), { address: g.str('address'), port: g.num('port'), interval: g.num('interval') }),
    decode: (b, g) => expect(decode.setListener(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'get door': {
    encode: (g) => encode.getDoorControl(g.num('controller'), g.num('door')),
    decode: (b, g) =>
      expect(decode.getDoorControl(b)).toEqual({ controller: ID, door: g.num('door'), mode: g.num('mode'), delay: g.num('delay') }),
  },
  'set door': {
    encode: (g) => encode.setDoorControl(g.num('controller'), { door: g.num('door'), mode: g.num('mode'), delay: g.num('delay') }),
    decode: (b, g) =>
      expect(decode.setDoorControl(b)).toEqual({ controller: ID, door: g.num('door'), mode: g.num('mode'), delay: g.num('delay') }),
  },
  'open door': {
    encode: (g) => encode.openDoor(g.num('controller'), g.num('door')),
    decode: (b, g) => expect(decode.openDoor(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'get cards': {
    encode: (g) => encode.getCards(g.num('controller')),
    decode: (b, g) => expect(decode.getCards(b)).toEqual({ controller: ID, cards: g.num('cards') }),
  },
  'get card': {
    encode: (g) => encode.getCard(g.num('controller'), g.num('card')),
    decode: (b, g) =>
      expect(decode.getCard(b).card).toMatchObject({
        card: g.num('card'),
        from: g.str('start date'),
        to: g.str('end date'),
        doors: [g.num('door 1'), g.num('door 2'), g.num('door 3'), g.num('door 4')],
        pin: g.num('PIN'),
      }),
  },
  'get card at index': {
    encode: (g) => encode.getCardAtIndex(g.num('controller'), g.num('index')),
    decode: (b, g) =>
      expect(decode.getCardAtIndex(b).card).toMatchObject({
        card: g.num('card'),
        from: g.str('start date'),
        to: g.str('end date'),
        doors: [g.num('door 1'), g.num('door 2'), g.num('door 3'), g.num('door 4')],
        pin: g.num('PIN'),
      }),
  },
  'put card': {
    encode: (g) =>
      encode.putCard(g.num('controller'), {
        card: g.num('card'),
        from: g.str('start date'),
        to: g.str('end date'),
        doors: [g.num('door1'), g.num('door2'), g.num('door3'), g.num('door4')],
        pin: g.num('PIN'),
        firstCard: [false, false, false, false],
      }),
    decode: (b, g) => expect(decode.putCard(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'delete card': {
    encode: (g) => encode.deleteCard(g.num('controller'), g.num('card')),
    decode: (b, g) => expect(decode.deleteCard(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'delete cards': {
    encode: (g) => encode.deleteAllCards(g.num('controller')),
    decode: (b, g) => expect(decode.deleteAllCards(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'get event': {
    encode: (g) => encode.getEvent(g.num('controller'), g.num('index')),
    decode: (b, g) =>
      expect(decode.getEvent(b).event).toEqual({
        index: g.num('index'),
        type: g.num('event type'),
        granted: g.bool('access granted'),
        door: g.num('door'),
        direction: g.num('direction'),
        card: g.num('card'),
        timestamp: g.str('timestamp'),
        reason: g.num('reason'),
      }),
  },
  'get event index': {
    encode: (g) => encode.getEventIndex(g.num('controller')),
    decode: (b, g) => expect(decode.getEventIndex(b)).toEqual({ controller: ID, index: g.num('index') }),
  },
  'set event index': {
    encode: (g) => encode.setEventIndex(g.num('controller'), g.num('index')),
    decode: (b, g) => expect(decode.setEventIndex(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'record special events': {
    encode: (g) => encode.recordSpecialEvents(g.num('controller'), g.bool('enabled')),
    decode: (b, g) => expect(decode.recordSpecialEvents(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'get time profile': {
    encode: (g) => encode.getTimeProfile(g.num('controller'), g.num('profile')),
    decode: (b, g) =>
      expect(decode.getTimeProfile(b).profile).toEqual({
        id: g.num('profile'),
        from: g.str('start date'),
        to: g.str('end date'),
        weekdays: g.days(),
        segments: [1, 2, 3].map((i) => ({ start: g.str(`segment ${i} start`), end: g.str(`segment ${i} end`) })),
        linkedTo: g.num('linked profile'),
      }),
  },
  'set time profile': {
    encode: (g) =>
      encode.setTimeProfile(g.num('controller'), {
        id: g.num('profile'),
        from: g.str('start date'),
        to: g.str('end date'),
        weekdays: g.days(),
        segments: [1, 2, 3].map((i) => ({ start: g.str(`segment ${i} start`), end: g.str(`segment ${i} end`) })),
        linkedTo: g.num('linked profile id'),
      }),
    decode: (b, g) => expect(decode.setTimeProfile(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'clear time profiles': {
    encode: (g) => encode.clearTimeProfiles(g.num('controller')),
    decode: (b, g) => expect(decode.clearTimeProfiles(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'add task': {
    encode: (g) =>
      encode.addTask(g.num('controller'), {
        task: g.num('task'),
        from: g.str('start date'),
        to: g.str('end date'),
        weekdays: g.days(),
        start: g.str('start time'),
        door: g.num('door'),
        moreCards: g.num('more cards'),
      }),
    decode: (b, g) => expect(decode.addTask(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'refresh task list': {
    encode: (g) => encode.refreshTaskList(g.num('controller')),
    decode: (b, g) => expect(decode.refreshTaskList(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'clear task list': {
    encode: (g) => encode.clearTaskList(g.num('controller')),
    decode: (b, g) => expect(decode.clearTaskList(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'set pc control': {
    encode: (g) => encode.setPCControl(g.num('controller'), g.bool('enabled')),
    decode: (b, g) => expect(decode.setPCControl(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'set interlock': {
    encode: (g) => encode.setInterlock(g.num('controller'), g.num('interlock')),
    decode: (b, g) => expect(decode.setInterlock(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'activate keypads': {
    encode: (g) =>
      encode.activateKeypads(g.num('controller'), [g.bool('reader 1'), g.bool('reader 2'), g.bool('reader 3'), g.bool('reader 4')]),
    decode: (b, g) => expect(decode.activateKeypads(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'set door passcodes': {
    encode: (g) =>
      encode.setDoorPasscodes(g.num('controller'), g.num('door'), [1, 2, 3, 4].map((i) => g.num(`passcode ${i}`))),
    decode: (b, g) => expect(decode.setDoorPasscodes(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'get antipassback': {
    encode: (g) => encode.getAntiPassback(g.num('controller')),
    decode: (b, g) => expect(decode.getAntiPassback(b)).toEqual({ controller: ID, antipassback: g.num('antipassback') }),
  },
  'set antipassback': {
    encode: (g) => encode.setAntiPassback(g.num('controller'), g.num('antipassback')),
    decode: (b, g) => expect(decode.setAntiPassback(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'set first-card': {
    encode: (g) =>
      encode.setFirstCard(g.num('controller'), {
        door: g.num('door'),
        start: g.str('start-time'),
        end: g.str('end-time'),
        activeMode: g.num('active-mode'),
        inactiveMode: g.num('inactive-mode'),
        weekdays: g.days(),
      }),
    decode: (b, g) => expect(decode.setFirstCard(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
  'restore default parameters': {
    encode: (g) => encode.restoreDefaultParameters(g.num('controller')),
    decode: (b, g) => expect(decode.restoreDefaultParameters(b)).toEqual({ controller: ID, ok: g.bool('ok') }),
  },
}
specs['get status no event'] = specs['get status']!

describe('vettori ufficiali uhppoted-codegen', () => {
  it('copre tutti i vettori del fixture', () => {
    const missing = vectors.map((v) => v.name).filter((n) => !specs[n])
    expect(missing).toEqual([])
  })

  for (const v of vectors) {
    const spec = specs[v.name]
    if (!spec) continue

    it(`${v.name}: encode request`, () => {
      const expected = Buffer.from(v.request.message, 'base64')
      expect(spec.encode(getter(v.request.values)).toString('hex')).toBe(expected.toString('hex'))
    })

    if (v.response && spec.decode) {
      it(`${v.name}: decode response`, () => {
        spec.decode!(Buffer.from(v.response!.message, 'base64'), getter(v.response!.values))
      })
    }
  }
})
