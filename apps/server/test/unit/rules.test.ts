import { describe, expect, it } from 'vitest'
import { ruleInputSchema, type EventDto } from '@uhppote-desk/shared'
import type { ControllerRecord } from '../../src/db/repos.js'
import type { IntegrationEvent } from '../../src/services/integrationEvents.js'
import { formatDuration, matchesConditions, ruleText, type RuleContext } from '../../src/services/rules.js'

const controller = { id: 1, serial: 1, name: 'Villa', enabled: true } as ControllerRecord
const door = { id: 7, controllerId: 1, door: 1, name: 'Cancello', active: true, attendance: false, mode: 3, delay: 5 }

function ctx(timestamp: string, e: Partial<EventDto> = {}): RuleContext {
  const event = {
    id: 1,
    controllerId: 1,
    controllerName: 'Villa',
    index: 1,
    type: 1,
    granted: false,
    door: 1,
    doorName: 'Cancello',
    direction: 1,
    card: 10058400,
    personId: 3,
    personName: 'Rossi Mario',
    timestamp,
    reason: 6,
    receivedAt: timestamp,
    ...e,
  }
  const ev: IntegrationEvent = { type: 'access.denied', controller, door, data: {}, event, state: null }
  return { event: ev, controller, door, timestamp, seconds: null }
}

const rule = (conditions: object, extra: object = {}) =>
  ruleInputSchema.parse({ name: 'R', trigger: { type: 'access.denied' }, conditions, ...extra })
const match = (r: ReturnType<typeof rule>, c: RuleContext) => matchesConditions(r, c, () => [7, 8])

describe('matchesConditions', () => {
  it('time window across midnight', () => {
    const r = rule({ timeFrom: '22:00', timeTo: '06:00' })
    expect(match(r, ctx('2026-10-12 23:15:00'))).toBe(true)
    expect(match(r, ctx('2026-10-13 05:59:00'))).toBe(true)
    expect(match(r, ctx('2026-10-12 21:59:00'))).toBe(false)
  })

  it('weekdays, Monday first', () => {
    const r = rule({ weekdays: [false, false, false, false, false, true, true] })
    expect(match(r, ctx('2026-10-12 10:00:00'))).toBe(false) // Monday
    expect(match(r, ctx('2026-10-17 10:00:00'))).toBe(true) // Saturday
  })

  it('people or cards: either matches', () => {
    expect(match(rule({ personIds: [3] }), ctx('2026-10-12 10:00:00'))).toBe(true)
    expect(match(rule({ personIds: [4] }), ctx('2026-10-12 10:00:00'))).toBe(false)
    expect(match(rule({ personIds: [4], cards: [10058400] }), ctx('2026-10-12 10:00:00'))).toBe(true)
    expect(match(rule({ cards: [1] }), { ...ctx('2026-10-12 10:00:00'), event: null })).toBe(false)
  })

  it('doors, also for controller-level events', () => {
    expect(match(rule({ doorIds: [7] }), ctx('2026-10-12 10:00:00'))).toBe(true)
    expect(match(rule({ doorIds: [9] }), ctx('2026-10-12 10:00:00'))).toBe(false)
    expect(match(rule({ doorIds: [8] }), { ...ctx('2026-10-12 10:00:00'), door: null })).toBe(true) // controller has door 8
  })

  it('requires both times or none', () => {
    expect(() => rule({ timeFrom: '22:00' })).toThrow()
  })
})

describe('ruleText', () => {
  it('fills the placeholders', () => {
    const r = rule({}, { message: '{person} ({card}) a {door} alle {time}: {reason} {unknown}' })
    expect(ruleText(r, ctx('2026-10-12 22:30:05'), 'it')).toBe(
      'Rossi Mario (10058400) a Cancello alle 22:30:05: Nessun diritto di accesso {unknown}',
    )
  })

  it('writes an automatic text when the message is empty', () => {
    expect(ruleText(rule({}), ctx('2026-10-12 22:30:05'), 'it').split('\n')[0]).toBe('Accesso negato — Cancello')
    const open = ruleInputSchema.parse({ name: 'R', trigger: { type: 'door.open_for', seconds: 120 } })
    expect(
      ruleText(open, { event: null, controller, door, timestamp: '2026-10-12 10:00:00', seconds: 120 }, 'it'),
    ).toBe('Cancello aperta da 2 min')
  })

  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45 s')
    expect(formatDuration(150)).toBe('3 min')
  })
})
