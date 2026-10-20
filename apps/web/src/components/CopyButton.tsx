import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Copies text to the clipboard. The Clipboard API exists only on secure pages (HTTPS or localhost): on a plain
 * http:// LAN address the text is copied through a hidden textarea and the older copy command instead.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // permission denied: try the fallback
    }
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.opacity = '0'
  // inside an open modal the focus is trapped: append to the focused element's container when possible
  const host = (document.activeElement?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body
  host.appendChild(area)
  area.focus()
  area.select()
  area.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  host.removeChild(area)
  return ok
}

/** Same render-prop API as Mantine's CopyButton, working on plain http:// addresses too. */
export function CopyButton({
  value,
  timeout = 1500,
  children,
}: {
  value: string
  timeout?: number
  children: (p: { copied: boolean; copy: () => void }) => ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), [])
  const copy = () =>
    void copyText(value).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), timeout)
    })
  return <>{children({ copied, copy })}</>
}
