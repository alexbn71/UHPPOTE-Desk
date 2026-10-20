/**
 * Guest link (/g/<token>) on a phone-sized screen, without login: hold to open, then the same link
 * refused on a second phone (the pass is bound to the first one).
 */
import { devices, expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'

const BASE = 'http://localhost:8090'
const PASSWORDS = ['Admin-E2E-Password-1', 'admin-e2e-initial']

test.use({ ...devices['Pixel 7'], baseURL: BASE })

let admin: APIRequestContext

/** Admin API session, whatever state the other specs left (initial password or changed one). */
async function adminSession(): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE })
  for (const password of PASSWORDS) {
    const r = await ctx.post('/api/auth/login', { data: { username: 'admin', password } })
    if (!r.ok()) continue
    if ((await r.json()).user.mustChangePassword) {
      await ctx.post('/api/auth/password', { data: { currentPassword: password, newPassword: PASSWORDS[0] } })
    }
    return ctx
  }
  throw new Error('cannot log in as admin')
}

const minute = (offset: number) => {
  const d = new Date(Date.now() + offset * 60_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

test.beforeAll(async () => {
  admin = await adminSession()
  const controllers = (await (await admin.get('/api/controllers')).json()) as { serial: number }[]
  if (!controllers.some((c) => c.serial === 405419896)) {
    await admin.post('/api/controllers', {
      data: { serial: 405419896, name: 'Entrance', host: '127.0.0.1', port: 60020 },
    })
  }
})

test.afterAll(async () => {
  await admin.dispose()
})

test('a guest opens a door from the link; the link does not work on another phone', async ({ page, browser }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const doors = (await (await admin.get('/api/doors')).json()) as { id: number; name: string }[]
  const door = doors.find((d) => d.name === 'Entrance - Door 1')!
  const created = await admin.post('/api/guests', {
    data: { name: 'Mario', doorIds: [door.id], validFrom: minute(-1), validTo: minute(60), bindDevice: true },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const { token } = (await created.json()) as { token: string }

  await page.goto(`/g/${token}`)
  await expect(page.getByRole('heading', { name: 'Hi Mario' })).toBeVisible()
  const hold = page.getByRole('button', { name: 'Hold to open: Entrance - Door 1' })
  const box = (await hold.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(1600)
  await page.mouse.up()
  await expect(page.getByText('Entrance - Door 1 opened')).toBeVisible()

  // the link forwarded to someone else
  const other = await browser.newContext({ ...devices['Pixel 7'], baseURL: BASE })
  const otherPage = await other.newPage()
  await otherPage.goto(`/g/${token}`)
  await expect(otherPage.getByText('Link in use on another phone')).toBeVisible()
  await expect(otherPage.getByRole('button', { name: /Hold to open/ })).toHaveCount(0)
  await other.close()

  // an unknown link
  await page.goto(`/g/${'x'.repeat(22)}`)
  await expect(page.getByText('Link not valid')).toBeVisible()
  expect(errors).toEqual([])
})
