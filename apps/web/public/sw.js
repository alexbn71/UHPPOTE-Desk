/* UHPPOTE Desk service worker: installable app (offline shell), push notifications, "open door" action. */
const CACHE = 'uhd-shell-v3'
const SHELL = ['/', '/m', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/badge-96.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// network first (the app is always up to date); the cache only when the server cannot be reached.
// The API is never cached.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/__')) return
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname))) {
          const copy = res.clone()
          void caches.open(CACHE).then((c) => c.put(event.request, copy))
        }
        return res
      })
      .catch(async () => (await caches.match(event.request)) ?? (event.request.mode === 'navigate' ? caches.match('/') : Response.error())),
  )
})

self.addEventListener('push', (event) => {
  const p = event.data ? event.data.json() : null
  if (!p) return
  // Android shows the action; iOS has no actions: a tap opens the app on the door
  const actions = p.canOpen && p.door ? [{ action: 'open', title: p.texts.open }] : []
  event.waitUntil(
    self.registration.showNotification(p.title, {
      body: p.body,
      tag: p.tag,
      icon: '/icon-192.png',
      // small icon (status bar): Android uses only its transparency, so it must be a white silhouette
      badge: '/badge-96.png',
      data: p,
      actions,
    }),
  )
})

async function focusOrOpen(url) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const c of all) {
    if (new URL(c.url).origin === self.location.origin && 'navigate' in c) {
      await c.focus()
      return c.navigate(url)
    }
  }
  return self.clients.openWindow(url)
}

self.addEventListener('notificationclick', (event) => {
  const p = event.notification.data
  event.notification.close()
  if (!p) return
  if (event.action === 'open' && p.door && p.confirmation === 'press') {
    // "hold to open" mode: the action itself is the confirmation
    event.waitUntil(
      fetch(`/api/doors/${p.door.id}/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' })
        .then(async (res) => {
          const body = res.ok ? null : await res.json().catch(() => null)
          // the administrator now requires fingerprint/Face ID: confirm in the app, on that door
          if (body && (body.code === 'biometricRequired' || body.code === 'biometricNotRegistered')) return focusOrOpen(p.url)
          const text = res.ok ? p.texts.opened : p.texts.failed.replace('{{error}}', (body && body.error) || `HTTP ${res.status}`)
          return self.registration.showNotification(text, { tag: `${p.tag}-result`, icon: '/icon-192.png', badge: '/badge-96.png' })
        })
        .catch(() => focusOrOpen(p.url)),
    )
    return
  }
  // fingerprint/Face ID mode, or a tap on the notification: the app opens on the door
  event.waitUntil(focusOrOpen(p.url))
})
