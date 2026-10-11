import type { Card, Quad } from '@uhppote-desk/protocol'
import type { SyncDiffDto } from '@uhppote-desk/shared'
import type { Db } from '../db/database.js'
import type { ControllerRepo, PeopleRepo, ScheduleRepo } from '../db/repos.js'
import type { Actor, ControllerGateway } from '../gateway/gateway.js'

/** Computes the differences between the desired cards (DB) and those on the controller. */
export function diffCards(desired: Map<number, Card>, actual: Card[]): { toAdd: Card[]; toUpdate: Card[]; toDelete: number[]; unchanged: number } {
  const actualMap = new Map(actual.map((c) => [c.card, c]))
  const toAdd: Card[] = []
  const toUpdate: Card[] = []
  let unchanged = 0
  for (const [num, want] of desired) {
    const have = actualMap.get(num)
    if (!have) toAdd.push(want)
    else if (!sameCard(want, have)) toUpdate.push(want)
    else unchanged++
  }
  const toDelete = actual.filter((c) => !desired.has(c.card)).map((c) => c.card)
  return { toAdd, toUpdate, toDelete, unchanged }
}

export function sameCard(a: Card, b: Card): boolean {
  return (
    a.card === b.card &&
    a.from === b.from &&
    a.to === b.to &&
    a.pin === b.pin &&
    a.doors.every((d, i) => d === b.doors[i]) &&
    a.firstCard.every((f, i) => f === b.firstCard[i])
  )
}

/**
 * Synchronisation DB → controller.
 * The DB is the source of truth for cards, permissions, time profiles, tasks, doors and settings.
 */
export class SyncService {
  constructor(
    private readonly db: Db,
    private readonly gateway: ControllerGateway,
    private readonly controllers: ControllerRepo,
    private readonly people: PeopleRepo,
    private readonly schedule: ScheduleRepo,
  ) {}

  // -------------------------------------------------------------------------
  // Cards
  // -------------------------------------------------------------------------

  /** Cards that must be on the controller, with their permissions. */
  desiredCards(controllerId: number, onlyPersonId?: number): Map<number, Card> {
    const doors = this.controllers.doors(controllerId)
    const doorNumber = new Map(doors.map((d) => [d.id, d.door]))
    const rows = this.db.all<{
      number: number
      person_id: number
      pin: number
      valid_from: string
      valid_to: string
      door_id: number
      profile_id: number | null
      first_card: number
    }>(
      `SELECT c.number, p.id AS person_id, p.pin, p.valid_from, p.valid_to, pe.door_id, pe.profile_id, pe.first_card
       FROM cards c
       JOIN people p ON p.id = c.person_id AND p.active = 1
       JOIN permissions pe ON pe.person_id = p.id
       JOIN doors d ON d.id = pe.door_id AND d.controller_id = ?
       WHERE c.status = 'active' ${onlyPersonId ? 'AND p.id = ?' : ''}`,
      onlyPersonId ? [controllerId, onlyPersonId] : [controllerId],
    )
    const result = new Map<number, Card>()
    for (const r of rows) {
      const door = doorNumber.get(r.door_id)
      if (!door) continue
      const card =
        result.get(r.number) ??
        ({
          card: r.number,
          from: r.valid_from,
          to: r.valid_to,
          doors: [0, 0, 0, 0] as Quad<number>,
          pin: r.pin,
          firstCard: [false, false, false, false] as Quad<boolean>,
        } satisfies Card)
      card.doors[door - 1] = r.profile_id ?? 1
      card.firstCard[door - 1] = r.first_card === 1
      result.set(r.number, card)
    }
    return result
  }

  /** Full comparison DB ↔ controller (reads all the cards from the controller). */
  async diff(actor: Actor, controllerId: number): Promise<SyncDiffDto & { _cards: ReturnType<typeof diffCards> }> {
    const actual = await this.gateway.run(actor, controllerId, 'read-cards', null, (client, t) => client.listCards(t), { audit: false })
    const d = diffCards(this.desiredCards(controllerId), actual)
    return {
      controllerId,
      toAdd: d.toAdd.map((c) => c.card),
      toUpdate: d.toUpdate.map((c) => c.card),
      toDelete: d.toDelete,
      unchanged: d.unchanged,
      controllerCards: actual.length,
      _cards: d,
    }
  }

  /** Aligns the controller's cards with the DB. */
  async syncCards(actor: Actor, controllerId: number): Promise<SyncDiffDto> {
    const run = this.db.run("INSERT INTO sync_runs (controller_id, kind, operator_id) VALUES (?, 'cards', ?)", [controllerId, actor?.id ?? null]).lastInsertRowid
    const hub = this.gateway.hub
    try {
      hub.publishSync(controllerId, 'running', 'sync.progress.readingCards')
      const { _cards, ...summary } = await this.diff(actor, controllerId)
      const total = _cards.toAdd.length + _cards.toUpdate.length + _cards.toDelete.length
      let done = 0
      await this.gateway.run(actor, controllerId, 'sync-cards', { add: summary.toAdd.length, update: summary.toUpdate.length, delete: summary.toDelete.length }, async (client, t) => {
        for (const c of [..._cards.toAdd, ..._cards.toUpdate]) {
          await client.putCard(t, c)
          if (++done % 25 === 0) hub.publishSync(controllerId, 'running', 'sync.progress.writingCards', { done, total })
        }
        for (const n of _cards.toDelete) {
          await client.deleteCard(t, n)
          if (++done % 25 === 0) hub.publishSync(controllerId, 'running', 'sync.progress.writingCards', { done, total })
        }
      })
      this.db.run("UPDATE sync_runs SET status = 'ok', finished_at = datetime('now','localtime'), summary = ? WHERE id = ?", [JSON.stringify(summary), run])
      hub.publishSync(controllerId, 'ok', 'sync.progress.cardsDone', { added: summary.toAdd.length, updated: summary.toUpdate.length, deleted: summary.toDelete.length })
      return summary
    } catch (err) {
      this.db.run("UPDATE sync_runs SET status = 'error', finished_at = datetime('now','localtime'), summary = ? WHERE id = ?", [(err as Error).message, run])
      hub.publishSync(controllerId, 'error', 'errors.controllerError', { detail: (err as Error).message })
      throw err
    }
  }

  /**
   * Immediate update of a person's cards on all controllers (after a change).
   * `removedCards`: card numbers to delete (e.g. a lost or removed card).
   * Errors are collected and returned per controller (offline controllers are aligned by the full sync).
   */
  async pushPerson(actor: Actor, personId: number | null, removedCards: number[] = []): Promise<{ controllerId: number; error?: string }[]> {
    const results: { controllerId: number; error?: string }[] = []
    for (const c of this.controllers.list().filter((x) => x.enabled)) {
      try {
        const desired = personId ? this.desiredCards(c.id, personId) : new Map<number, Card>()
        const personCards = personId ? this.people.cards({ personId }).map((x) => x.number) : []
        const toRemove = new Set([...removedCards, ...personCards.filter((n) => !desired.has(n))])
        await this.gateway.run(actor, c.id, 'push-person', { personId, cards: [...desired.keys()], removed: [...toRemove] }, async (client, t) => {
          for (const card of desired.values()) await client.putCard(t, card)
          for (const n of toRemove) await client.deleteCard(t, n)
        })
        results.push({ controllerId: c.id })
      } catch (err) {
        results.push({ controllerId: c.id, error: (err as Error).message })
      }
    }
    return results
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  async pushDoor(actor: Actor, doorId: number): Promise<void> {
    const d = this.controllers.door(doorId)
    if (!d) throw new Error('Door not found')
    await this.gateway.run(actor, d.controllerId, 'set-door-control', { door: d.door, mode: d.mode, delay: d.delay }, (client, t) =>
      client.setDoorControl(t, { door: d.door, mode: d.mode, delay: d.delay }),
    )
  }

  async pushTimeProfiles(actor: Actor, controllerId: number): Promise<number> {
    const profiles = this.schedule.profiles()
    return this.gateway.run(actor, controllerId, 'push-time-profiles', { count: profiles.length }, async (client, t) => {
      await client.clearTimeProfiles(t)
      for (const p of profiles) {
        await client.setTimeProfile(t, {
          id: p.id,
          from: p.validFrom,
          to: p.validTo,
          weekdays: p.weekdays as [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
          segments: p.segments,
          linkedTo: p.linkedTo ?? 0,
        })
      }
      return profiles.length
    })
  }

  async pushTasks(actor: Actor, controllerId: number): Promise<number> {
    const tasks = this.schedule.tasks(controllerId).filter((t) => t.enabled)
    return this.gateway.run(actor, controllerId, 'push-tasks', { count: tasks.length }, async (client, t) => {
      await client.clearTaskList(t)
      for (const task of tasks) {
        await client.addTask(t, {
          task: task.task,
          from: task.validFrom,
          to: task.validTo,
          weekdays: task.weekdays as [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
          start: task.startTime,
          door: task.door,
          moreCards: task.moreCards,
        })
      }
      await client.refreshTaskList(t)
      return tasks.length
    })
  }

  async pushSettings(actor: Actor, controllerId: number): Promise<void> {
    const s = this.controllers.settings(controllerId)
    await this.gateway.run(actor, controllerId, 'push-settings', s, async (client, t) => {
      await client.setInterlock(t, s.interlock)
      await client.setAntiPassback(t, s.antipassback)
      await client.activateKeypads(t, s.keypads as Quad<boolean>)
      for (let door = 1; door <= 4; door++) await client.setDoorPasscodes(t, door, s.passcodes[door - 1] ?? [])
      for (let door = 1; door <= 4; door++) {
        const fc = s.firstCard[door - 1]
        if (fc?.enabled) {
          await client.setFirstCard(t, {
            door,
            start: fc.start,
            end: fc.end,
            activeMode: fc.activeMode,
            inactiveMode: fc.inactiveMode,
            weekdays: fc.weekdays as [boolean, boolean, boolean, boolean, boolean, boolean, boolean],
          })
        }
      }
      await client.recordSpecialEvents(t, s.recordSpecialEvents)
      await client.setPCControl(t, s.pcControl)
    })
  }

  /** Full synchronisation: doors, time profiles, tasks, settings, cards. */
  async pushAll(actor: Actor, controllerId: number): Promise<SyncDiffDto> {
    const hub = this.gateway.hub
    hub.publishSync(controllerId, 'running', 'sync.progress.doors')
    for (const d of this.controllers.doors(controllerId)) await this.pushDoor(actor, d.id)
    hub.publishSync(controllerId, 'running', 'sync.progress.profiles')
    await this.pushTimeProfiles(actor, controllerId)
    hub.publishSync(controllerId, 'running', 'sync.progress.tasks')
    await this.pushTasks(actor, controllerId)
    hub.publishSync(controllerId, 'running', 'sync.progress.settings')
    await this.pushSettings(actor, controllerId)
    return this.syncCards(actor, controllerId)
  }
}
