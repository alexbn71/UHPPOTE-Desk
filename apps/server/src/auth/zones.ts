import type { ControllerRecord } from '../db/repos.js'
import type { SessionUser } from './auth.js'

/** May the user command the controller? Zone restriction, sub-zones included (no zones = all). */
export function canOperateController(
  zones: { id: number; parentId: number | null }[],
  user: Pick<SessionUser, 'role' | 'zoneIds'>,
  c: Pick<ControllerRecord, 'zoneId'>,
): boolean {
  if (user.role === 'admin' || user.zoneIds.length === 0) return true
  const allowed = new Set(user.zoneIds)
  let changed = true
  while (changed) {
    changed = false
    for (const z of zones) {
      if (z.parentId !== null && allowed.has(z.parentId) && !allowed.has(z.id)) {
        allowed.add(z.id)
        changed = true
      }
    }
  }
  return c.zoneId !== null && allowed.has(c.zoneId)
}
