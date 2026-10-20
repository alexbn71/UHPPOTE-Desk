import { Button, Group, Text } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

const CHECK_EVERY_MS = 5 * 60_000

/** Entry bundle this page is running (null with the Vite dev server, which has no hashed bundle). */
function runningBuild(): string | null {
  for (const s of document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const m = /\/assets\/(index-[\w-]+\.js)$/.exec(new URL(s.src, location.href).pathname)
    if (m) return m[1]!
  }
  return null
}

/**
 * Tells the user to reload when the server serves a newer web build than the one this page runs
 * (e.g. the container was updated while the tab stayed open). Checked at start, every 5 minutes and when
 * the tab becomes visible again.
 */
export function UpdateNotice() {
  const { t } = useTranslation()
  useEffect(() => {
    const running = runningBuild()
    if (!running) return
    let shown = false
    const check = async () => {
      if (shown || document.visibilityState !== 'visible') return
      try {
        const r = await fetch('/api/health', { cache: 'no-store' })
        if (!r.ok) return
        const { build } = (await r.json()) as { build?: string | null }
        if (!build || build === running) return
        shown = true
        notifications.show({
          id: 'app-update',
          color: 'blue',
          autoClose: false,
          title: t('update.title'),
          message: (
            <Group justify="space-between" wrap="nowrap" gap="sm">
              <Text size="sm">{t('update.message')}</Text>
              <Button size="xs" onClick={() => location.reload()}>
                {t('update.reload')}
              </Button>
            </Group>
          ),
        })
      } catch {
        // server unreachable: checked again later
      }
    }
    void check()
    const timer = setInterval(() => void check(), CHECK_EVERY_MS)
    const onVisible = () => void check()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [t])
  return null
}
