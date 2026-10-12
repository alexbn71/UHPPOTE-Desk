/**
 * Mobile app (/m) on a phone-sized screen: login with "remember this device", hold-to-open,
 * then fingerprint/Face ID with Chromium's virtual authenticator (WebAuthn).
 * Runs on http://localhost: WebAuthn does not accept IP addresses as relying party.
 */
import { devices, expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'

const BASE = 'http://localhost:8090'
const PASSWORDS = ['Admin-E2E-Password-1', 'admin-e2e-initial']

test.use({ ...devices['Pixel 7'], baseURL: BASE })

let admin: APIRequestContext

/** Admin API session, whatever state the other spec left (initial password or changed one). */
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

test.describe.serial('mobile app', () => {
  test.beforeAll(async () => {
    admin = await adminSession()
    const controllers = (await (await admin.get('/api/controllers')).json()) as { serial: number }[]
    if (!controllers.some((c) => c.serial === 405419896)) {
      await admin.post('/api/controllers', { data: { serial: 405419896, name: 'Entrance', host: '127.0.0.1', port: 60020 } })
    }
    await admin.put('/api/mobile/settings', { data: { openConfirmation: 'press', sessionDays: 90 } })
  })

  test.afterAll(async () => {
    await admin.put('/api/mobile/settings', { data: { openConfirmation: 'press', sessionDays: 90 } })
    await admin.dispose()
  })

  test('login with a remembered device and hold to open', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto('/m')
    await expect(page.getByRole('checkbox', { name: 'Remember this device' })).toBeChecked()
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('admin')
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORDS[0])
    await page.getByRole('button', { name: 'Log in' }).click()

    const hold = page.getByRole('button', { name: 'Hold to open: Entrance - Door 1' })
    await expect(hold).toBeVisible({ timeout: 10_000 })
    // a short tap does not open
    await hold.click()
    await expect(page.getByText('Entrance - Door 1 opened')).toBeHidden()
    // holding it does
    const box = (await hold.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(1600)
    await page.mouse.up()
    await expect(page.getByText('Entrance - Door 1 opened')).toBeVisible()

    await page.getByText('Settings', { exact: true }).click()
    await expect(page.getByText('This device', { exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('fingerprint / Face ID: activation and opening', async ({ page, context }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await admin.put('/api/mobile/settings', { data: { openConfirmation: 'biometric', sessionDays: 90 } })

    // a phone with a fingerprint reader: Chromium's virtual platform authenticator
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })

    await page.goto('/m')
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('admin')
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORDS[0])
    await page.getByRole('button', { name: 'Log in' }).click()

    await expect(page.getByText('Fingerprint / Face ID required')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'Open with fingerprint / Face ID' }).first()).toBeDisabled()
    await page.getByRole('button', { name: 'Activate fingerprint / Face ID' }).click()
    await expect(page.getByText('Fingerprint / Face ID activated')).toBeVisible()

    await page.getByRole('button', { name: 'Open with fingerprint / Face ID' }).first().click()
    await expect(page.getByText(/^Entrance - Door \d opened$/)).toBeVisible()

    await page.getByText('Settings', { exact: true }).click()
    await expect(page.getByText('Fingerprint / Face ID active on this phone')).toBeVisible()
    await expect(page.getByText('never (fingerprint / Face ID)')).toBeVisible()

    const list = (await (await admin.get('/api/mobile/devices')).json()) as { biometric: boolean; expiresAt: string | null }[]
    expect(list.some((d) => d.biometric && d.expiresAt === null)).toBe(true)
    expect(errors).toEqual([])
  })
})
