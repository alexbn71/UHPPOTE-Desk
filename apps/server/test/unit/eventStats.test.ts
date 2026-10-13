import { beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../../src/db/database.js'
import { EventRepo } from '../../src/db/repos.js'

const NOW = '2026-10-14 10:20:00' // Wednesday

let db: Db
let events: EventRepo
let index = 1

function swipe(timestamp: string, granted: boolean, door = 1, type = 1) {
  events.insert({
    controllerId: 1,
    epoch: 0,
    index: index++,
    type,
    granted,
    door,
    direction: 1,
    card: 123,
    timestamp,
    reason: granted ? 1 : 6,
  })
}

beforeEach(() => {
  db = new Db(':memory:')
  db.migrate()
  db.run("INSERT INTO controllers (id, serial, name) VALUES (1, 423187757, 'Main')")
  db.run("INSERT INTO doors (controller_id, door, name) VALUES (1, 1, 'Entrance'), (1, 2, 'Garage')")
  events = new EventRepo(db)
})

describe('EventRepo.stats', () => {
  it('counts card swipes per day for the last 7 days, filling the gaps', () => {
    swipe('2026-10-14 08:00:00', true)
    swipe('2026-10-14 09:00:00', false)
    swipe('2026-10-08 12:00:00', true) // first day of the window
    swipe('2026-10-07 23:59:59', true) // outside
    swipe('2026-10-14 09:30:00', true, 1, 2) // not a card swipe
    const { daily } = events.stats(NOW)
    expect(daily.map((d) => d.date)).toEqual([
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
    ])
    expect(daily[0]).toEqual({ date: '2026-10-08', granted: 1, denied: 0 })
    expect(daily[6]).toEqual({ date: '2026-10-14', granted: 1, denied: 1 })
    expect(daily.slice(1, 6).every((d) => d.granted === 0 && d.denied === 0)).toBe(true)
  })

  it('buckets the last 24 hours, across midnight', () => {
    swipe('2026-10-13 11:05:00', true) // first bucket
    swipe('2026-10-13 10:59:59', true) // outside
    swipe('2026-10-13 23:10:00', false)
    swipe('2026-10-14 10:19:00', true) // current hour
    const { hourly } = events.stats(NOW)
    expect(hourly).toHaveLength(24)
    expect(hourly[0]).toEqual({ hour: '2026-10-13 11', granted: 1, denied: 0 })
    expect(hourly.find((h) => h.hour === '2026-10-13 23')).toEqual({ hour: '2026-10-13 23', granted: 0, denied: 1 })
    expect(hourly[23]).toEqual({ hour: '2026-10-14 10', granted: 1, denied: 0 })
  })

  it('ranks doors by swipes in the last 7 days', () => {
    swipe('2026-10-14 08:00:00', true, 2)
    swipe('2026-10-13 08:00:00', false, 2)
    swipe('2026-10-12 08:00:00', true, 1)
    expect(events.stats(NOW).byDoor).toEqual([
      { controllerId: 1, controllerName: 'Main', door: 2, doorName: 'Garage', granted: 1, denied: 1 },
      { controllerId: 1, controllerName: 'Main', door: 1, doorName: 'Entrance', granted: 1, denied: 0 },
    ])
  })

  it('maps granted swipes of the last 28 days to weekday (Monday first) and hour', () => {
    swipe('2026-10-12 08:15:00', true) // Monday
    swipe('2026-10-05 08:45:00', true) // Monday
    swipe('2026-10-11 22:00:00', true) // Sunday
    swipe('2026-10-12 08:30:00', false) // denied: not counted
    swipe('2026-09-16 08:00:00', true) // outside the 28 days
    const cells = events.stats(NOW).weekHours.sort((a, b) => a.weekday - b.weekday)
    expect(cells).toEqual([
      { weekday: 0, hour: 8, count: 2 },
      { weekday: 6, hour: 22, count: 1 },
    ])
  })
})
