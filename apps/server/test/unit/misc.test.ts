import { describe, expect, it } from 'vitest'
import type { Card } from '@uhppote-desk/protocol'
import { hashPassword, verifyPassword } from '../../src/auth/password.js'
import { diffCards } from '../../src/services/sync.js'
import { parseCsv, toCsv } from '../../src/util/csv.js'

const card = (n: number, doors: [number, number, number, number] = [1, 0, 0, 0], pin = 0): Card => ({
  card: n,
  from: '2026-01-01',
  to: '2026-12-31',
  doors,
  pin,
  firstCard: [false, false, false, false],
})

describe('diffCards', () => {
  it('finds additions, changes, removals and unchanged', () => {
    const desired = new Map([
      [1, card(1)],
      [2, card(2, [1, 1, 0, 0])],
      [3, card(3)],
    ])
    const actual = [card(2), card(3), card(4)]
    const d = diffCards(desired, actual)
    expect(d.toAdd.map((c) => c.card)).toEqual([1])
    expect(d.toUpdate.map((c) => c.card)).toEqual([2])
    expect(d.toDelete).toEqual([4])
    expect(d.unchanged).toBe(1)
  })

  it('PIN and dates count as differences', () => {
    expect(diffCards(new Map([[1, card(1, [1, 0, 0, 0], 1234)]]), [card(1)]).toUpdate).toHaveLength(1)
    expect(diffCards(new Map([[1, { ...card(1), to: '2027-01-01' }]]), [card(1)]).toUpdate).toHaveLength(1)
  })
})

describe('CSV', () => {
  it('parsing with ; separator and quotes', () => {
    const rows = parseCsv('﻿matricola;cognome;reparto\r\n001;"Rossi; Mario";Vendite\\Estero\r\n\r\n002;"Bianchi ""Gigi""";\n')
    expect(rows).toEqual([
      ['matricola', 'cognome', 'reparto'],
      ['001', 'Rossi; Mario', 'Vendite\\Estero'],
      ['002', 'Bianchi "Gigi"', ''],
    ])
  })

  it('detects the comma as separator', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('round trip', () => {
    const data = [['x;y', 'a"b', 3, null]]
    const parsed = parseCsv(toCsv(data))
    expect(parsed).toEqual([['x;y', 'a"b', '3', '']])
  })
})

describe('password', () => {
  it('hash and verify', async () => {
    const h = await hashPassword('segreta-123')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(await verifyPassword('segreta-123', h)).toBe(true)
    expect(await verifyPassword('sbagliata', h)).toBe(false)
    expect(await verifyPassword('x', 'formato-non-valido')).toBe(false)
  })
})
