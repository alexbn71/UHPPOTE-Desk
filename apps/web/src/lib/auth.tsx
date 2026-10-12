import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Role } from '@uhppote-desk/shared'
import { api } from './api'

export interface CurrentUser {
  id: number
  username: string
  displayName: string
  role: Role
  mustChangePassword: boolean
  passwordManaged: boolean
  zoneIds: number[]
  /** Remembered device (mobile app); null for a normal session. */
  deviceId: number | null
  canOpenDoors: boolean
}

interface AuthState {
  user: CurrentUser | null
  loading: boolean
  refresh: () => Promise<unknown>
  logout: () => Promise<void>
  can: (role: Role) => boolean
}

const AuthContext = createContext<AuthState | null>(null)
const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 }

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: CurrentUser }>('/auth/me').then((r) => r.user).catch(() => null),
    staleTime: 60_000,
  })

  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(['me'], null)
    window.addEventListener('uhd:unauthorized', onUnauthorized)
    return () => window.removeEventListener('uhd:unauthorized', onUnauthorized)
  }, [qc])

  const user = me.data ?? null
  const value: AuthState = {
    user,
    loading: me.isLoading,
    refresh: () => me.refetch(),
    logout: async () => {
      await api.post('/auth/logout').catch(() => undefined)
      qc.clear()
      qc.setQueryData(['me'], null)
    },
    can: (role) => !!user && RANK[user.role] >= RANK[role],
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth fuori da AuthProvider')
  return ctx
}
