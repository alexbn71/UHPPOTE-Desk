import { expect, test, type Page } from '@playwright/test'

const ADMIN_PASSWORD = 'Admin-E2E-Password-1'

/** Collects JavaScript errors raised by the page (the tests fail if any occur). */
function trackErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text())
  })
  return errors
}

async function login(page: Page, username: string, password: string) {
  await page.goto('/')
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill(username)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
  // wait for the outcome (app loaded or mandatory password change)
  await expect(page.getByRole('heading', { name: 'Dashboard' }).or(page.getByRole('heading', { name: 'Change password' }))).toBeVisible()
}

test.describe.serial('UHPPOTE Desk', () => {
  test('first login: mandatory password change', async ({ page }) => {
    const errors = trackErrors(page)
    await login(page, 'admin', 'admin-e2e-initial')
    await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Current password', exact: true }).fill('admin-e2e-initial')
    await page.getByRole('textbox', { name: 'New password', exact: true }).fill(ADMIN_PASSWORD)
    await page.getByRole('textbox', { name: 'Confirm new password', exact: true }).fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('network search and adding the controller', async ({ page }) => {
    const errors = trackErrors(page)
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.goto('/controllers')
    await page.getByRole('button', { name: 'Search network' }).click()
    await page.getByRole('button', { name: 'Start search' }).click()
    await expect(page.getByRole('cell', { name: '405419896' })).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Add' }).last().click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Entrance')
    await page.getByRole('textbox', { name: 'IP address', exact: true }).fill('127.0.0.1')
    await page.getByRole('textbox', { name: 'Port', exact: true }).fill('60020')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('heading', { name: 'Entrance' })).toBeVisible()
    await expect(page.getByText('Online')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('v8.92')).toBeVisible({ timeout: 10_000 })
    expect(errors).toEqual([])
  })

  test('person, card and permission: the card reaches the controller', async ({ page, request }) => {
    const errors = trackErrors(page)
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.goto('/people')
    await page.getByRole('button', { name: 'New person' }).click()
    await page.getByRole('textbox', { name: 'Employee code', exact: true }).fill('E100')
    await page.getByRole('textbox', { name: 'Last name', exact: true }).fill('Rossi')
    await page.getByRole('textbox', { name: 'First name', exact: true }).fill('Maria')
    await page.getByRole('button', { name: 'Create person' }).click()
    await expect(page.getByRole('cell', { name: 'E100' })).toBeVisible()
    await page.getByRole('cell', { name: 'E100' }).click()
    await page.getByRole('tab', { name: /Cards/ }).click()
    await page.getByRole('textbox', { name: 'Add card', exact: true }).fill('10058400')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByRole('cell', { name: '10058400 (100,58400)' })).toBeVisible()
    await page.getByRole('tab', { name: 'Permissions' }).click()
    await page.getByLabel('Entrance - Door 1').check()
    await page.getByRole('button', { name: 'Save permissions' }).click()
    await expect(page.getByText('Permissions saved')).toBeVisible()
    const cards = await (await request.get('/__sim/cards')).json()
    expect(cards).toEqual([expect.objectContaining({ card: 10058400, doors: [1, 0, 0, 0] })])
    expect(errors).toEqual([])
  })

  test('live monitor', async ({ page, request }) => {
    const errors = trackErrors(page)
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.goto('/monitor')
    await expect(page.getByText('Live', { exact: true })).toBeVisible()
    await request.post('/__sim/swipe', { data: { card: 10058400, door: 1 } })
    await expect(page.getByText('Rossi Maria').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Granted').first()).toBeVisible()
    await request.post('/__sim/swipe', { data: { card: 10099999, door: 2 } })
    await expect(page.getByText('Card 10099999').first()).toBeVisible({ timeout: 10_000 })
    // the unknown card is offered for registration, but 10099999 (number 99999 > 65535) is not valid Wiegand-26
    await request.post('/__sim/swipe', { data: { card: 10065001, door: 2 } })
    await page.goto('/cards')
    await expect(page.getByRole('button', { name: /^10065001 / })).not.toHaveAttribute('data-disabled')
    await expect(page.getByRole('button', { name: /^10099999 / })).toHaveAttribute('data-disabled')
    expect(errors).toEqual([])
  })

  test('every page opens without errors', async ({ page }) => {
    const errors = trackErrors(page)
    await login(page, 'admin', ADMIN_PASSWORD)
    const pages: [string, string][] = [
      ['/', 'Dashboard'],
      ['/monitor', 'Monitor'],
      ['/events', 'Event history'],
      ['/attendance', 'Attendance'],
      ['/people', 'People'],
      ['/cards', 'Cards'],
      ['/permissions', 'Access permissions'],
      ['/structure', 'Departments and zones'],
      ['/controllers', 'Controllers'],
      ['/controllers/1', 'Entrance'],
      ['/doors', 'Doors'],
      ['/time-profiles', 'Time profiles'],
      ['/tasks', 'Scheduled tasks'],
      ['/sync', 'Synchronisation'],
      ['/operators', 'Operators'],
      ['/audit', 'Audit log'],
      ['/notifications', 'Notifications'],
      ['/webhooks', 'Webhooks'],
      ['/api-tokens', 'API tokens'],
      ['/system', 'System'],
      ['/password', 'Change password'],
    ]
    for (const [url, heading] of pages) {
      await page.goto(url)
      await expect(page.getByRole('heading', { name: heading, exact: true }), `page ${url}`).toBeVisible()
    }
    // tabs of the controller detail and attendance pages
    await page.goto('/controllers/1')
    for (const tab of ['Network and configuration', 'Advanced settings', 'Maintenance', 'Diagnostics']) {
      await page.getByRole('tab', { name: tab }).click()
    }
    await expect(page.getByText('Serial number')).toBeVisible({ timeout: 10_000 })
    await page.goto('/attendance')
    for (const tab of ['Shifts', 'Holidays', 'Leave and absences', 'Manual punches', 'Report']) {
      await page.getByRole('tab', { name: tab }).click()
    }
    expect(errors).toEqual([])
  })

  test('synchronisation: comparison without differences', async ({ page }) => {
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.goto('/sync')
    await page.getByRole('button', { name: 'Compare' }).click()
    await expect(page.getByText('To add: 0')).toBeVisible({ timeout: 10_000 })
  })

  test('language switch: Italian, Spanish, French, German; choice remembered', async ({ page }) => {
    const errors = trackErrors(page)
    await login(page, 'admin', ADMIN_PASSWORD)
    const checks: [string, string, string][] = [
      ['Italiano', 'Persone', 'Storico eventi'],
      ['Español', 'Personas', 'Historial de eventos'],
      ['Français', 'Personnes', 'Historique des événements'],
      ['Deutsch', 'Personen', 'Ereignisverlauf'],
    ]
    for (const [language, people, events] of checks) {
      await page.getByRole('button', { name: /^(Language|Lingua|Idioma|Langue|Sprache)$/ }).click()
      await page.getByRole('menuitem', { name: language }).click()
      await expect(page.getByText(people, { exact: true }).first()).toBeVisible()
      await page.goto('/events')
      await expect(page.getByRole('heading', { name: events, exact: true })).toBeVisible()
      await page.goto('/')
    }
    // the last choice (German) survives a reload
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Übersicht' })).toBeVisible()
    // server errors are translated too
    await page.goto('/time-profiles')
    await page.getByRole('button', { name: 'Neues Profil' }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Test')
    await page.getByPlaceholder('08:00').fill('10:00')
    await page.getByPlaceholder('12:00').fill('09:00')
    await page.getByRole('button', { name: 'Speichern' }).click()
    await expect(page.getByText('Ungültiges Intervall: 10:00-09:00')).toBeVisible()
    // back to English for the following tests
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: 'Neues Zeitprofil' })).toBeHidden()
    await page.getByRole('button', { name: 'Sprache' }).click()
    await page.getByRole('menuitem', { name: 'English' }).click()
    await expect(page.getByText('People', { exact: true }).first()).toBeVisible()
    expect(errors).toEqual([])
  })

  test('read-only operator: no door opening and no administration', async ({ page, request }) => {
    const r = await request.post('/api/auth/login', { data: { username: 'admin', password: ADMIN_PASSWORD } })
    expect(r.ok()).toBeTruthy()
    await request.post('/api/operators', { data: { username: 'reader', displayName: 'Reader', role: 'viewer', password: 'Reader-Password-1' } })
    await login(page, 'reader', 'Reader-Password-1')
    await page.getByRole('textbox', { name: 'Current password', exact: true }).fill('Reader-Password-1')
    await page.getByRole('textbox', { name: 'New password', exact: true }).fill('Reader-Password-2')
    await page.getByRole('textbox', { name: 'Confirm new password', exact: true }).fill('Reader-Password-2')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0)
    await expect(page.getByText('Operators', { exact: true })).toHaveCount(0)
    await page.goto('/operators')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  })
})
