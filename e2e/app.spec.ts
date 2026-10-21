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
  await expect(
    page.getByRole('heading', { name: 'Dashboard' }).or(page.getByRole('heading', { name: 'Change password' })),
  ).toBeVisible()
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

  test('author credits on the login page, the main app and the mobile app', async ({ page }) => {
    const credits = page.getByTestId('credits')
    await page.goto('/')
    await expect(credits).toHaveText('UHPPOTE Desk © 2026 Alessandro Blason · AGPL-3.0 · Source code')
    await expect(credits.getByRole('link', { name: 'Source code' })).toHaveAttribute(
      'href',
      'https://github.com/alexbn71/UHPPOTE-Desk',
    )
    await login(page, 'admin', ADMIN_PASSWORD)
    await expect(credits).toBeVisible()
    await page.goto('/m')
    await expect(credits).toBeVisible()
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
      ['/presence', 'Persons inside'],
      ['/plates', 'Licence plates'],
      ['/attendance', 'Attendance'],
      ['/anomalies', 'Anomalies'],
      ['/people', 'People'],
      ['/cards', 'Cards'],
      ['/guests', 'Guests'],
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
      ['/rules', 'Rules'],
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
    for (const tab of [
      'Network and configuration',
      'Advanced settings',
      'Expansion board',
      'Maintenance',
      'Diagnostics',
    ]) {
      await page.getByRole('tab', { name: tab }).click()
    }
    await expect(page.getByText('Serial number')).toBeVisible({ timeout: 10_000 })
    await page.goto('/attendance')
    for (const tab of ['Shifts', 'Holidays', 'Leave and absences', 'Manual punches', 'Report']) {
      await page.getByRole('tab', { name: tab }).click()
    }
    expect(errors).toEqual([])
  })

  test('network tab: the IP form starts from the configuration read from the controller', async ({ page }) => {
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.goto('/controllers/1')
    await page.getByRole('tab', { name: 'Network and configuration' }).click()
    await expect(page.getByLabel('Gateway')).toHaveValue('192.168.1.1', { timeout: 10_000 })
    await expect(page.getByLabel('Netmask')).toHaveValue('255.255.255.0')
  })

  test('expansion board: configure output 1 and save', async ({ page }) => {
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.goto('/controllers/1')
    await page.getByRole('tab', { name: 'Expansion board' }).click()
    await expect(page.getByText('Alarm expansion board (UT0311-01A)')).toBeVisible()
    await page.getByLabel('Expansion board connected').check({ force: true })
    const relay1 = page.getByTestId('expansion-relay-1')
    await relay1.getByLabel('Output 1').check({ force: true })
    // vendor defaults preselected: threat, open too long, forced open, fire
    await expect(relay1.getByLabel('Forced open')).toBeChecked()
    await relay1.getByLabel('Fire alarm').uncheck({ force: true })
    await page.getByLabel('Door open too long raises an alarm').check({ force: true })
    await page.getByRole('button', { name: 'Save and send to the controller' }).click()
    // written with 0xF2 and verified by reading the table back
    await expect(page.getByText('Saved, sent and verified')).toBeVisible({ timeout: 10_000 })
    const settings = await (await page.request.get('/api/controllers/1/settings')).json()
    expect(settings.expansionBoard.installed).toBe(true)
    expect(settings.expansionBoard).toMatchObject({ openTooLongAlarm: true, invalidCardAlarmAfter3: false })
    expect(settings.expansionBoard.relays[0]).toMatchObject({
      active: true,
      source: 0,
      mode: 1,
      events: 0x07,
      duration: 10,
    })
    expect(settings.expansionBoard.relays.slice(1).every((r: { active: boolean }) => !r.active)).toBe(true)
    // configuration read from the controller: same as the saved one
    await page.getByRole('button', { name: 'Read from the controller' }).click()
    const read = page.getByTestId('expansion-read')
    await expect(read.getByText('Same as the saved configuration')).toBeVisible({ timeout: 10_000 })
    await expect(read.getByRole('row', { name: /Output 1/ })).toContainText('Door 1')
    await expect(read.getByRole('row', { name: /Output 2/ })).toContainText('Off')
  })

  test('update notice: shown only when the server serves a newer web build', async ({ page }) => {
    await login(page, 'admin', ADMIN_PASSWORD)
    // same build as the page: no notice
    const health = await (await page.request.get('/api/health')).json()
    expect(health.build).toMatch(/^index-[\w-]+\.js$/)
    await page.goto('/')
    await page.waitForTimeout(1000)
    await expect(page.getByText('New version available')).toHaveCount(0)
    // the container was updated while the tab stayed open
    await page.route('/api/health', (route) => route.fulfill({ json: { ...health, build: 'index-NewerBuild1.js' } }))
    await page.goto('/')
    await expect(page.getByText('New version available')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
    await page.unroute('/api/health')
  })

  test('reader and door options: managed, saved and verified', async ({ page }) => {
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.goto('/controllers/1')
    await page.getByRole('tab', { name: 'Advanced settings' }).click()
    const card = page.getByTestId('controller-options')
    await card.getByLabel('Managed by UHPPOTE Desk').check({ force: true })
    await card.getByLabel('Silent reader on invalid cards').check({ force: true })
    await card.getByLabel("Don't record repeated swipes of the same card (s)").fill('10')
    await page.getByRole('button', { name: 'Save and send to the controller' }).click()
    await expect(page.getByText('Settings saved, sent and verified in the controller')).toBeVisible({ timeout: 10_000 })
    const settings = await (await page.request.get('/api/controllers/1/settings')).json()
    expect(settings.controllerOptions).toMatchObject({ managed: true, silentInvalidCard: true, swipeGapSeconds: 10 })
    await card.getByRole('button', { name: 'Read from the controller' }).click()
    await expect(page.getByTestId('controller-options-read').getByText('Same as the saved configuration')).toBeVisible({
      timeout: 10_000,
    })
  })

  test('persons inside: door role and page', async ({ page }) => {
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.goto('/doors')
    await page.getByRole('button', { name: 'Edit' }).nth(1).click()
    await page.getByRole('dialog').getByLabel('Persons inside').click()
    await page.getByRole('option', { name: 'Exit' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Save and send to the controller' }).click()
    await expect(page.getByRole('cell', { name: 'Exit' })).toBeVisible({ timeout: 10_000 })
    await page.goto('/presence')
    await expect(page.getByRole('heading', { name: 'Persons inside', exact: true })).toBeVisible()
    await expect(page.getByTestId('presence-count')).toBeVisible()
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
    await request.post('/api/operators', {
      data: { username: 'reader', displayName: 'Reader', role: 'viewer', password: 'Reader-Password-1' },
    })
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
