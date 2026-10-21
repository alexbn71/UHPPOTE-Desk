/**
 * Two-factor authentication in the browser: an operator activates it (QR code, code, recovery codes), then logs in
 * with password and code, and with a recovery code.
 */
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'
import { currentStep, hotp } from '../apps/server/src/auth/totp'

const PASSWORDS = ['Admin-E2E-Password-1', 'admin-e2e-initial']
const USER = 'totp-e2e'
const PASSWORD = 'Totp-E2E-Password-1'

let admin: APIRequestContext

async function adminSession(): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: 'http://127.0.0.1:8090' })
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

test.beforeAll(async () => {
  admin = await adminSession()
  const operators = (await (await admin.get('/api/operators')).json()) as { id: number; username: string }[]
  const old = operators.find((o) => o.username === USER)
  if (old) await admin.delete(`/api/operators/${old.id}`)
  const r = await admin.post('/api/operators', {
    data: { username: USER, displayName: 'TOTP test', role: 'operator', active: true, password: PASSWORD, zoneIds: [] },
  })
  expect(r.ok(), await r.text()).toBe(true)
  // the password set by the administrator must be changed at first login: do it here
  const user = await playwrightRequest.newContext({ baseURL: 'http://127.0.0.1:8090' })
  await user.post('/api/auth/login', { data: { username: USER, password: PASSWORD } })
  await user.post('/api/auth/password', { data: { currentPassword: PASSWORD, newPassword: PASSWORD + 'x' } })
  await user.dispose()
})

test.afterAll(async () => {
  await admin.dispose()
})

async function fillLogin(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.getByLabel('Username').fill(USER)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORD + 'x')
  await page.getByRole('button', { name: 'Log in' }).click()
}

test('activate two-factor authentication and log in with a code and with a recovery code', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await fillLogin(page)
  await page.getByRole('button', { name: 'Two-factor authentication' }).click()
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible()
  await page.getByRole('button', { name: 'Activate' }).click()
  await page.getByRole('textbox', { name: 'Confirm your password to start', exact: true }).fill(PASSWORD + 'x')
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByAltText('QR')).toBeVisible()
  const secret = (await page.locator('code').first().innerText()).replace(/\s/g, '')
  expect(secret).toMatch(/^[A-Z2-7]{32}$/)
  await page.getByLabel('Code shown by the app').fill(hotp(secret, currentStep()))
  await page.getByRole('button', { name: 'Confirm' }).click()

  await expect(page.getByRole('heading', { name: 'Recovery codes' })).toBeVisible()
  const codes = await page.locator('code').allInnerTexts()
  expect(codes).toHaveLength(10)
  await page.getByRole('button', { name: 'I have saved them' }).click()
  await expect(page.getByText('Recovery codes left: 10')).toBeVisible()

  // log out, then log in: the code is asked after the password
  await page.getByRole('button', { name: 'Log out' }).click()
  await fillLogin(page)
  const codeField = page.getByLabel('Verification code')
  await expect(codeField).toBeVisible()
  await codeField.fill('000000')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByText('Verification code not valid')).toBeVisible()
  // the code used for the activation is refused as already used: use the next step's one
  await codeField.fill(hotp(secret, currentStep() + 1))
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()

  // a recovery code also works
  await page.getByRole('button', { name: 'Log out' }).click()
  await fillLogin(page)
  await page.getByLabel('Verification code').fill(codes[0]!)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()

  // the administrator sees it in the operator list
  const operators = (await (await admin.get('/api/operators')).json()) as { username: string; totpEnabled: boolean }[]
  expect(operators.find((o) => o.username === USER)?.totpEnabled).toBe(true)
  expect(errors).toEqual([])
})

test('the administrator chooses who must use two-factor authentication', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Username').fill('admin')
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORDS[0]!)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible()
  await page.goto('/operators')
  const select = page.getByRole('combobox', { name: 'Two-factor authentication required for' })
  await expect(select).toHaveValue('Nobody (optional)')
  // the operator with two-factor authentication shows a reset button and a "Yes" badge
  await expect(page.getByRole('row', { name: new RegExp(USER) }).getByText('Yes')).toBeVisible()
  // admin has not activated it: choosing administrators asks for a confirmation (cancelled here, so that the other
  // tests keep logging in with the password only)
  await select.click()
  await page.getByRole('option', { name: 'Administrators', exact: true }).click()
  await expect(page.getByText('You have not activated two-factor authentication yet')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(select).toHaveValue('Nobody (optional)')
  const settings = await (await admin.get('/api/security/settings')).json()
  expect(settings).toEqual({ require2fa: 'none' })
})
