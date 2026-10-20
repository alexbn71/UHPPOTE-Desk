import { Button, Loader } from '@mantine/core'
import { IconLockOpen } from '@tabler/icons-react'
import { useRef, useState, type PointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

const HOLD_MS = 1200

/**
 * "Hold to open": `onConfirm` runs after the button has been held down for HOLD_MS, so that a touch
 * in the pocket does not open a door.
 */
export function HoldButton({ name, onConfirm }: { name: string; onConfirm: () => Promise<unknown> }) {
  const { t } = useTranslation()
  const [progress, setProgress] = useState(0)
  const [busy, setBusy] = useState(false)
  const timer = useRef<number | null>(null)
  const started = useRef(0)

  const cancel = () => {
    if (timer.current) cancelAnimationFrame(timer.current)
    timer.current = null
    setProgress(0)
  }
  const tick = () => {
    const p = Math.min(1, (Date.now() - started.current) / HOLD_MS)
    setProgress(p)
    if (p < 1) {
      timer.current = requestAnimationFrame(tick)
      return
    }
    timer.current = null
    navigator.vibrate?.(40)
    setBusy(true)
    void onConfirm().finally(() => {
      setBusy(false)
      setProgress(0)
    })
  }
  const start = (e: PointerEvent) => {
    if (busy) return
    e.preventDefault()
    started.current = Date.now()
    timer.current = requestAnimationFrame(tick)
  }

  return (
    <Button
      fullWidth
      size="lg"
      leftSection={busy ? <Loader size="xs" color="white" /> : <IconLockOpen size={20} />}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        backgroundImage: `linear-gradient(90deg, var(--mantine-color-green-filled) ${progress * 100}%, transparent ${progress * 100}%)`,
        touchAction: 'none',
        userSelect: 'none',
      }}
      aria-label={`${t('mobile.hold')}: ${name}`}
    >
      {busy ? t('mobile.opening') : t('mobile.hold')}
    </Button>
  )
}
