/**
 * Test differenziali: per input casuali validi il nostro encoder deve produrre gli stessi byte
 * dell'encoder della libreria di riferimento npm `uhppoted` (implementazione indipendente).
 */
import { createRequire } from 'node:module'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { encode, decode, FunctionCode, type Weekdays } from '../src/index.js'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ref = require('uhppoted/src/encoder.js') as Record<string, (id: number, args?: unknown) => Buffer>
const refDecoder = require('uhppoted/src/decoder.js') as Record<string, (bytes: DataView) => unknown>

const controller = fc.integer({ min: 1, max: 0xfffffffe })
const door = fc.integer({ min: 1, max: 4 })
const date = fc
  .date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2099-12-31T00:00:00Z'), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 10))
const datetime = fc
  .date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2099-12-31T23:59:59Z'), noInvalidDate: true })
  .map((d) => d.toISOString().slice(0, 19).replace('T', ' '))
const hhmm = fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 })).map(
  ([h, m]) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
)
const weekdays = fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()) as fc.Arbitrary<Weekdays>
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const dayNames = (w: Weekdays) => DAY_NAMES.filter((_, i) => w[i])
const ip = fc.ipV4()
const permission = fc.oneof(fc.constant(0), fc.constant(1), fc.integer({ min: 2, max: 254 }))
const toRefPermission = (p: number) => (p === 0 ? false : p === 1 ? true : p)

const hex = (b: Buffer) => b.toString('hex')
const runs = { numRuns: 200 }

describe('encoder vs libreria uhppoted', () => {
  it('set listener', () =>
    fc.assert(
      fc.property(controller, ip, fc.integer({ min: 0, max: 65535 }), fc.integer({ min: 0, max: 255 }), (id, a, port, interval) => {
        expect(hex(encode.setListener(id, { address: a, port, interval }))).toBe(hex(ref.SetListener!(id, { address: a, port, interval })))
      }),
      runs,
    ))

  it('set IPv4', () =>
    fc.assert(
      fc.property(controller, ip, ip, ip, (id, a, m, g) => {
        expect(hex(encode.setIPv4(id, a, m, g))).toBe(hex(ref.SetIP!(id, { address: a, netmask: m, gateway: g })))
      }),
      runs,
    ))

  it('set time', () =>
    fc.assert(
      fc.property(controller, datetime, (id, dt) => {
        expect(hex(encode.setTime(id, dt))).toBe(hex(ref.SetTime!(id, { datetime: dt })))
      }),
      runs,
    ))

  it('set door control', () =>
    fc.assert(
      fc.property(controller, door, fc.constantFrom(1, 2, 3), fc.integer({ min: 0, max: 255 }), (id, d, mode, delay) => {
        expect(hex(encode.setDoorControl(id, { door: d, mode, delay }))).toBe(hex(ref.SetDoorControl!(id, { door: d, delay, control: mode })))
      }),
      runs,
    ))

  it('put card', () =>
    fc.assert(
      fc.property(
        controller,
        fc.integer({ min: 1, max: 0xfffffffe }),
        date,
        date,
        fc.tuple(permission, permission, permission, permission),
        fc.integer({ min: 1, max: 999999 }),
        fc.tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean()),
        (id, card, from, to, doors, pin, firstCard) => {
          const ours = encode.putCard(id, { card, from, to, doors, pin, firstCard })
          const theirs = ref.PutCard!(id, {
            card,
            from,
            to,
            doors: { 1: toRefPermission(doors[0]), 2: toRefPermission(doors[1]), 3: toRefPermission(doors[2]), 4: toRefPermission(doors[3]) },
            PIN: pin,
            firstcard: { 1: firstCard[0], 2: firstCard[1], 3: firstCard[2], 4: firstCard[3] },
          })
          expect(hex(ours)).toBe(hex(theirs))
        },
      ),
      runs,
    ))

  it('set time profile', () =>
    fc.assert(
      fc.property(
        controller,
        fc.integer({ min: 2, max: 254 }),
        date,
        date,
        weekdays,
        fc.array(fc.tuple(hhmm, hhmm), { minLength: 0, maxLength: 3 }),
        fc.oneof(fc.constant(0), fc.integer({ min: 2, max: 254 })),
        (id, pid, from, to, days, segs, linked) => {
          const segments = segs.map(([start, end]) => ({ start, end }))
          const ours = encode.setTimeProfile(id, { id: pid, from, to, weekdays: days, segments, linkedTo: linked })
          const theirs = ref.SetTimeProfile!(id, {
            profile: { id: pid, valid: { from, to }, weekdays: dayNames(days), segments, linkedTo: linked || undefined },
          })
          expect(hex(ours)).toBe(hex(theirs))
        },
      ),
      runs,
    ))

  it('add task', () =>
    fc.assert(
      fc.property(controller, fc.integer({ min: 0, max: 12 }), date, date, weekdays, hhmm, door, fc.integer({ min: 0, max: 255 }), (id, task, from, to, days, start, d, more) => {
        const ours = encode.addTask(id, { task, from, to, weekdays: days, start, door: d, moreCards: more })
        // la libreria usa una numerazione 1-based per i task numerici
        const theirs = ref.AddTask!(id, { task: { task: task + 1, valid: { from, to }, weekdays: dayNames(days), start, door: d, cards: more } })
        expect(hex(ours)).toBe(hex(theirs))
      }),
      runs,
    ))

  it('set first-card', () =>
    fc.assert(
      fc.property(controller, door, hhmm, hhmm, fc.constantFrom(0, 1, 2), fc.constantFrom(0, 1, 2, 3), weekdays, (id, d, start, end, active, inactive, days) => {
        // nella libreria le modalità sono espresse con gli opcodes porta (3=controlled,1=NO,2=NC,4=first-card)
        const toLib = [3, 1, 2, 4]
        const ours = encode.setFirstCard(id, { door: d, start, end, activeMode: active, inactiveMode: inactive, weekdays: days })
        const theirs = ref.SetFirstCard!(id, {
          door: d,
          startTime: start,
          endTime: end,
          activeMode: toLib[active],
          inactiveMode: toLib[inactive],
          monday: days[0],
          tuesday: days[1],
          wednesday: days[2],
          thursday: days[3],
          friday: days[4],
          saturday: days[5],
          sunday: days[6],
        })
        expect(hex(ours)).toBe(hex(theirs))
      }),
      runs,
    ))

  it('set door passcodes', () =>
    fc.assert(
      fc.property(controller, door, fc.array(fc.integer({ min: 0, max: 999999 }), { maxLength: 4 }), (id, d, codes) => {
        expect(hex(encode.setDoorPasscodes(id, d, codes))).toBe(hex(ref.SetDoorPasscodes!(id, { door: d, passcodes: codes })))
      }),
      runs,
    ))

  it('comandi semplici con magic word', () =>
    fc.assert(
      fc.property(controller, (id) => {
        expect(hex(encode.deleteAllCards(id))).toBe(hex(ref.DeleteCards!(id)))
        expect(hex(encode.clearTimeProfiles(id))).toBe(hex(ref.ClearTimeProfiles!(id)))
        expect(hex(encode.clearTaskList(id))).toBe(hex(ref.ClearTaskList!(id)))
        expect(hex(encode.refreshTaskList(id))).toBe(hex(ref.RefreshTaskList!(id)))
        expect(hex(encode.restoreDefaultParameters(id))).toBe(hex(ref.RestoreDefaultParameters!(id)))
        expect(hex(encode.setPCControl(id, true))).toBe(hex(ref.SetPCControl!(id, { enable: true })))
        expect(hex(encode.setEventIndex(id, 12345))).toBe(hex(ref.SetEventIndex!(id, { index: 12345 })))
      }),
      runs,
    ))
})

describe('decoder vs libreria uhppoted', () => {
  it('get card: stesso risultato su pacchetti casuali validi', () =>
    fc.assert(
      fc.property(controller, fc.integer({ min: 1, max: 0xfffffffe }), date, date, fc.tuple(permission, permission, permission, permission), fc.integer({ min: 0, max: 999999 }), (id, card, from, to, doors, pin) => {
        const pkt = encode.putCard(id, { card, from, to, doors, pin, firstCard: [true, false, true, false] })
        pkt[1] = FunctionCode.GetCard
        const ours = decode.getCard(pkt).card
        const theirs = refDecoder.GetCardByID!(new DataView(pkt.buffer, pkt.byteOffset, 64)) as {
          card: { number: number; valid: { from: string; to: string }; doors: Record<string, boolean | number>; PIN: number }
        }
        expect(ours.card).toBe(theirs.card.number)
        expect(ours.from).toBe(theirs.card.valid.from)
        expect(ours.to).toBe(theirs.card.valid.to)
        expect(ours.pin).toBe(theirs.card.PIN)
        expect(ours.doors.map(toRefPermission)).toEqual([1, 2, 3, 4].map((d) => theirs.card.doors[d]))
      }),
      runs,
    ))
})
