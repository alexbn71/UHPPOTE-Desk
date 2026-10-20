import { useQuery } from '@tanstack/react-query'
import type { CardDto, ControllerDto, DoorDto, PersonDto } from '@uhppote-desk/shared'
import { api } from './api'

export interface TreeNode {
  id: number
  name: string
  parentId: number | null
}

export interface TimeProfile {
  id: number
  name: string
  validFrom: string
  validTo: string
  weekdays: boolean[]
  segments: { start: string; end: string }[]
  linkedTo: number | null
}

export interface Shift {
  id: number
  name: string
  startTime: string
  endTime: string
  breakMinutes: number
  toleranceMinutes: number
  weekdays: boolean[]
}

export interface Permission {
  personId: number
  doorId: number
  profileId: number | null
  firstCard: boolean
}

export const useControllers = () =>
  useQuery({ queryKey: ['controllers'], queryFn: () => api.get<ControllerDto[]>('/controllers') })
export const useDoors = () => useQuery({ queryKey: ['doors'], queryFn: () => api.get<DoorDto[]>('/doors') })
export const useZones = () => useQuery({ queryKey: ['zones'], queryFn: () => api.get<TreeNode[]>('/zones') })
export const useDepartments = () =>
  useQuery({ queryKey: ['departments'], queryFn: () => api.get<TreeNode[]>('/departments') })
export const usePeople = (search = '') =>
  useQuery({
    queryKey: ['people', search],
    queryFn: () => api.get<PersonDto[]>(`/people${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  })
export const useCards = () => useQuery({ queryKey: ['cards'], queryFn: () => api.get<CardDto[]>('/cards') })
export const useTimeProfiles = () =>
  useQuery({ queryKey: ['time-profiles'], queryFn: () => api.get<TimeProfile[]>('/time-profiles') })
export const useShifts = () => useQuery({ queryKey: ['shifts'], queryFn: () => api.get<Shift[]>('/shifts') })
export const usePermissions = () =>
  useQuery({ queryKey: ['permissions'], queryFn: () => api.get<Permission[]>('/permissions') })

/** Full "Parent › Child" path of a node. */
export function treePath(nodes: TreeNode[] | undefined, id: number | null): string {
  if (!nodes || id === null) return ''
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const parts: string[] = []
  let cur = byId.get(id)
  const seen = new Set<number>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    parts.unshift(cur.name)
    cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined
  }
  return parts.join(' › ')
}

export function treeOptions(nodes: TreeNode[] | undefined): { value: string; label: string }[] {
  return (nodes ?? [])
    .map((n) => ({ value: String(n.id), label: treePath(nodes, n.id) }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
