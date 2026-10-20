import { useTranslation } from 'react-i18next'
import { KNOWN_REASONS } from '@uhppote-desk/shared'

const known = new Set<number>(KNOWN_REASONS)

/** Translated labels for the protocol codes (reasons, door modes, …). */
export function useCodes() {
  const { t } = useTranslation()
  return {
    reason: (code: number) =>
      known.has(code) ? t(`codes.reason.${code}` as 'codes.reason.1') : t('codes.reason.unknown', { code }),
    eventType: (code: number) => t(`codes.eventType.${code}` as 'codes.eventType.1', { defaultValue: String(code) }),
    direction: (code: number) => (code === 1 || code === 2 ? t(`codes.direction.${code}`) : '—'),
    doorMode: (code: number) => t(`codes.doorMode.${code}` as 'codes.doorMode.1', { defaultValue: String(code) }),
    firstCardMode: (code: number) =>
      t(`codes.firstCardMode.${code}` as 'codes.firstCardMode.0', { defaultValue: String(code) }),
    interlock: (code: number) => t(`codes.interlock.${code}` as 'codes.interlock.0', { defaultValue: String(code) }),
    antipassback: (code: number) =>
      t(`codes.antipassback.${code}` as 'codes.antipassback.0', { defaultValue: String(code) }),
    task: (code: number) => t(`codes.task.${code}` as 'codes.task.0', { defaultValue: String(code) }),
    weekday: (index: number) => t(`codes.weekday.${index}` as 'codes.weekday.0'),
    role: (role: 'admin' | 'operator' | 'viewer') => t(`codes.role.${role}`),
    leave: (type: string) => t(`codes.leave.${type}` as 'codes.leave.ferie', { defaultValue: type }),
    attendanceStatus: (s: string) =>
      t(`codes.attendanceStatus.${s}` as 'codes.attendanceStatus.presente', { defaultValue: s }),
    anomaly: (a: string) => t(`codes.anomaly.${a}` as 'codes.anomaly.singlePunch', { defaultValue: a }),
    cardStatus: (s: 'active' | 'lost' | 'disabled') => t(`codes.cardStatus.${s}`),
    syncStatus: (s: string) => t(`codes.syncStatus.${s}` as 'codes.syncStatus.ok', { defaultValue: s }),
    weekdaysText: (w: boolean[]) => {
      if (w.every(Boolean)) return t('codes.weekdays.every')
      if (w.slice(0, 5).every(Boolean) && !w[5] && !w[6]) return t('codes.weekdays.workdays')
      const days = w.map((on, i) => (on ? t(`codes.weekday.${i}` as 'codes.weekday.0') : null)).filter(Boolean)
      return days.length ? days.join(', ') : t('codes.weekdays.none')
    },
  }
}
