import type { RuleDto, RuleInput, RuleRunDto } from '@uhppote-desk/shared'
import { fromBool, toBool, type Db } from './database.js'

/** Runs kept per rule. */
const KEEP_RUNS = 200

interface RuleRow {
  id: number
  name: string
  enabled: number
  severity: RuleDto['severity']
  language: string
  trigger: string
  conditions: string
  actions: string
  message: string
  cooldown_seconds: number
  last_fired_at: string | null
  fire_count: number
  created_at: string
}

const mapRule = (r: RuleRow): RuleDto => ({
  id: r.id,
  name: r.name,
  enabled: toBool(r.enabled),
  severity: r.severity,
  language: r.language as RuleDto['language'],
  trigger: JSON.parse(r.trigger) as RuleDto['trigger'],
  conditions: JSON.parse(r.conditions) as RuleDto['conditions'],
  actions: JSON.parse(r.actions) as RuleDto['actions'],
  message: r.message,
  cooldownSeconds: r.cooldown_seconds,
  lastFiredAt: r.last_fired_at,
  fireCount: r.fire_count,
  createdAt: r.created_at,
})

export class RuleRepo {
  constructor(private readonly db: Db) {}

  list(): RuleDto[] {
    return this.db.all<RuleRow>('SELECT * FROM rules ORDER BY name, id').map(mapRule)
  }

  get(id: number): RuleDto | undefined {
    const r = this.db.get<RuleRow>('SELECT * FROM rules WHERE id = ?', [id])
    return r && mapRule(r)
  }

  create(r: RuleInput): number {
    return this.db.run(
      'INSERT INTO rules (name, enabled, severity, language, trigger, conditions, actions, message, cooldown_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        r.name,
        fromBool(r.enabled),
        r.severity,
        r.language,
        JSON.stringify(r.trigger),
        JSON.stringify(r.conditions),
        JSON.stringify(r.actions),
        r.message,
        r.cooldownSeconds,
      ],
    ).lastInsertRowid
  }

  update(id: number, r: RuleInput): boolean {
    return (
      this.db.run(
        'UPDATE rules SET name = ?, enabled = ?, severity = ?, language = ?, trigger = ?, conditions = ?, actions = ?, message = ?, cooldown_seconds = ? WHERE id = ?',
        [
          r.name,
          fromBool(r.enabled),
          r.severity,
          r.language,
          JSON.stringify(r.trigger),
          JSON.stringify(r.conditions),
          JSON.stringify(r.actions),
          r.message,
          r.cooldownSeconds,
          id,
        ],
      ).changes > 0
    )
  }

  delete(id: number): boolean {
    return this.db.run('DELETE FROM rules WHERE id = ?', [id]).changes > 0
  }

  /** Records a firing and keeps only the most recent runs. */
  addRun(ruleId: number, at: string, text: string, errors: string[]): void {
    this.db.tx(() => {
      if (!this.db.get('SELECT 1 FROM rules WHERE id = ?', [ruleId])) return
      this.db.run('INSERT INTO rule_runs (rule_id, at, text, errors) VALUES (?, ?, ?, ?)', [
        ruleId,
        at,
        text,
        JSON.stringify(errors),
      ])
      this.db.run('UPDATE rules SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?', [at, ruleId])
      this.db.run(
        `DELETE FROM rule_runs WHERE rule_id = ? AND id <= (SELECT id FROM rule_runs WHERE rule_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        [ruleId, ruleId, KEEP_RUNS],
      )
    })
  }

  runs(ruleId: number, limit = KEEP_RUNS): RuleRunDto[] {
    return this.db
      .all<{
        id: number
        rule_id: number
        at: string
        text: string
        errors: string
      }>('SELECT * FROM rule_runs WHERE rule_id = ? ORDER BY id DESC LIMIT ?', [ruleId, limit])
      .map((r) => ({ id: r.id, ruleId: r.rule_id, at: r.at, text: r.text, errors: JSON.parse(r.errors) as string[] }))
  }
}
