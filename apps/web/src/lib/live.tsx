import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { notifications } from '@mantine/notifications'
import type { ControllerLiveState, EventDto, WsMessage } from '@uhppote-desk/shared'
import { ALARM_REASONS, KNOWN_REASONS } from '@uhppote-desk/shared'
import i18n from '../i18n'

export interface SyncProgress {
  status: 'running' | 'ok' | 'error'
  code: string
  params: Record<string, string | number>
}

interface LiveState {
  connected: boolean
  states: Record<number, ControllerLiveState>
  events: EventDto[]
  sync: Record<number, SyncProgress>
}

const LiveContext = createContext<LiveState>({ connected: false, states: {}, events: [], sync: {} })
const MAX_EVENTS = 300
const known = new Set<number>(KNOWN_REASONS)

/** WebSocket connection to the server with automatic reconnection. */
export function LiveProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [state, setState] = useState<LiveState>({ connected: false, states: {}, events: [], sync: {} })
  const qc = useQueryClient()
  const retry = useRef(0)

  useEffect(() => {
    if (!enabled) return
    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/api/ws`)
      ws.onopen = () => {
        retry.current = 0
        setState((s) => ({ ...s, connected: true }))
      }
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as WsMessage
        if (msg.type === 'status') {
          setState((s) => ({ ...s, states: { ...s.states, [msg.state.controllerId]: msg.state } }))
        } else if (msg.type === 'event') {
          setState((s) => ({ ...s, events: [msg.event, ...s.events].slice(0, MAX_EVENTS) }))
          if (ALARM_REASONS.has(msg.event.reason)) {
            const reason = known.has(msg.event.reason)
              ? i18n.t(`codes.reason.${msg.event.reason}` as 'codes.reason.1')
              : i18n.t('codes.reason.unknown', { code: msg.event.reason })
            notifications.show({
              color: 'red',
              title: msg.event.doorName ?? i18n.t('common.doorN', { n: msg.event.door }),
              message: reason,
              autoClose: false,
            })
          }
          void qc.invalidateQueries({ queryKey: ['events'] })
        } else if (msg.type === 'sync') {
          setState((s) => ({ ...s, sync: { ...s.sync, [msg.controllerId]: { status: msg.status, code: msg.code, params: msg.params ?? {} } } }))
        }
      }
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }))
        if (closed) return
        const delay = Math.min(30_000, 1000 * 2 ** retry.current++)
        timer = setTimeout(connect, delay)
      }
    }
    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      ws?.close()
    }
  }, [enabled, qc])

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>
}

export function useLive(): LiveState {
  return useContext(LiveContext)
}
