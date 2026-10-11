import { expect, test, type Page } from '@playwright/test'

const ADMIN_PASSWORD = 'Admin-E2E-Password-1'

/** Fallisce il test se la pagina genera errori JavaScript. */
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
  await page.getByRole('textbox', { name: 'Utente', exact: true }).fill(username)
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password)
  await page.getByRole('button', { name: 'Accedi' }).click()
  // attende l'esito del login (app caricata oppure cambio password obbligatorio)
  await expect(page.getByRole('heading', { name: 'Dashboard' }).or(page.getByRole('heading', { name: 'Cambio password' }))).toBeVisible()
}

test.describe.serial('UHPPOTE Desk', () => {
  test('primo accesso: cambio password obbligatorio', async ({ page }) => {
    const errors = trackErrors(page)
    await login(page, 'admin', 'admin-e2e-iniziale')
    await expect(page.getByRole('heading', { name: 'Cambio password' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Password attuale', exact: true }).fill('admin-e2e-iniziale')
    await page.getByRole('textbox', { name: 'Nuova password', exact: true }).fill(ADMIN_PASSWORD)
    await page.getByRole('textbox', { name: 'Conferma nuova password', exact: true }).fill(ADMIN_PASSWORD)
    await page.getByRole('button', { name: 'Salva' }).click()
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    expect(errors).toEqual([])
  })

  test('ricerca in rete e aggiunta del controller', async ({ page }) => {
    const errors = trackErrors(page)
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.getByRole('link', { name: 'Controller' }).or(page.getByText('Controller', { exact: true })).first().click()
    await page.getByRole('button', { name: 'Cerca in rete' }).click()
    await page.getByRole('button', { name: 'Avvia ricerca' }).click()
    await expect(page.getByRole('cell', { name: '405419896' })).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: 'Aggiungi' }).last().click()
    await page.getByRole('textbox', { name: 'Nome', exact: true }).fill('Ingresso')
    await page.getByRole('textbox', { name: 'Indirizzo IP', exact: true }).fill('127.0.0.1')
    await page.getByRole('textbox', { name: 'Porta', exact: true }).fill('60020')
    await page.getByRole('button', { name: 'Salva' }).click()
    await expect(page.getByRole('heading', { name: 'Ingresso' })).toBeVisible()
    await expect(page.getByText('Online')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('v8.92')).toBeVisible({ timeout: 10_000 })
    expect(errors).toEqual([])
  })

  test('persona, tessera e permesso: la tessera arriva sul controller', async ({ page, request }) => {
    const errors = trackErrors(page)
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.goto('/persone')
    await page.getByRole('button', { name: 'Nuova persona' }).click()
    await page.getByRole('textbox', { name: 'Matricola', exact: true }).fill('E100')
    await page.getByRole('textbox', { name: 'Cognome', exact: true }).fill('Rossi')
    await page.getByRole('textbox', { name: 'Nome', exact: true }).fill('Maria')
    await page.getByRole('button', { name: 'Crea persona' }).click()
    await expect(page.getByRole('cell', { name: 'E100' })).toBeVisible()
    await page.getByRole('cell', { name: 'E100' }).click()
    await page.getByRole('tab', { name: /Tessere/ }).click()
    await page.getByRole('textbox', { name: 'Aggiungi tessera', exact: true }).fill('10058400')
    await page.getByRole('button', { name: 'Aggiungi', exact: true }).click()
    await expect(page.getByRole('cell', { name: '10058400 (100,58400)' })).toBeVisible()
    await page.getByRole('tab', { name: 'Permessi' }).click()
    await page.getByLabel('Ingresso - Porta 1').check()
    await page.getByRole('button', { name: 'Salva permessi' }).click()
    await expect(page.getByText('Permessi salvati')).toBeVisible()
    const cards = await (await request.get('/__sim/cards')).json()
    expect(cards).toEqual([expect.objectContaining({ card: 10058400, doors: [1, 0, 0, 0] })])
    expect(errors).toEqual([])
  })

  test('monitor in tempo reale', async ({ page, request }) => {
    const errors = trackErrors(page)
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.goto('/monitor')
    await expect(page.getByText('Live')).toBeVisible()
    await request.post('/__sim/swipe', { data: { card: 10058400, door: 1 } })
    await expect(page.getByText('Rossi Maria').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('Consentito').first()).toBeVisible()
    await request.post('/__sim/swipe', { data: { card: 10099999, door: 2 } })
    await expect(page.getByText('Tessera 10099999').first()).toBeVisible({ timeout: 10_000 })
    expect(errors).toEqual([])
  })

  test('tutte le pagine si aprono senza errori', async ({ page }) => {
    const errors = trackErrors(page)
    await login(page, 'admin', ADMIN_PASSWORD)
    const pages: [string, string][] = [
      ['/', 'Dashboard'],
      ['/monitor', 'Monitor'],
      ['/eventi', 'Storico eventi'],
      ['/presenze', 'Presenze'],
      ['/persone', 'Persone'],
      ['/tessere', 'Tessere'],
      ['/permessi', 'Permessi di accesso'],
      ['/struttura', 'Reparti e zone'],
      ['/controller', 'Controller'],
      ['/controller/1', 'Ingresso'],
      ['/porte', 'Porte'],
      ['/fasce-orarie', 'Fasce orarie'],
      ['/task', 'Task programmati'],
      ['/sincronizzazione', 'Sincronizzazione'],
      ['/operatori', 'Operatori'],
      ['/audit', 'Registro operazioni'],
      ['/sistema', 'Sistema'],
      ['/password', 'Cambio password'],
    ]
    for (const [url, heading] of pages) {
      await page.goto(url)
      await expect(page.getByRole('heading', { name: heading, exact: true }), `pagina ${url}`).toBeVisible()
    }
    // schede del dettaglio controller e delle presenze
    await page.goto('/controller/1')
    for (const tab of ['Rete e configurazione', 'Impostazioni avanzate', 'Manutenzione', 'Diagnostica']) {
      await page.getByRole('tab', { name: tab }).click()
    }
    await expect(page.getByText('Numero di serie')).toBeVisible({ timeout: 10_000 })
    await page.goto('/presenze')
    for (const tab of ['Turni', 'Festività', 'Ferie e assenze', 'Timbrature manuali', 'Report']) {
      await page.getByRole('tab', { name: tab }).click()
    }
    expect(errors).toEqual([])
  })

  test('sincronizzazione: confronto senza differenze', async ({ page }) => {
    await login(page, 'admin', ADMIN_PASSWORD)
    await page.goto('/sincronizzazione')
    await page.getByRole('button', { name: 'Confronta' }).click()
    await expect(page.getByText('Da aggiungere: 0')).toBeVisible({ timeout: 10_000 })
  })

  test('operatore in sola lettura: niente apertura porte né amministrazione', async ({ page, request }) => {
    const r = await request.post('/api/auth/login', { data: { username: 'admin', password: ADMIN_PASSWORD } })
    expect(r.ok()).toBeTruthy()
    await request.post('/api/operators', { data: { username: 'lettore', displayName: 'Lettore', role: 'viewer', password: 'Lettore-Password-1' } })
    await login(page, 'lettore', 'Lettore-Password-1')
    await page.getByRole('textbox', { name: 'Password attuale', exact: true }).fill('Lettore-Password-1')
    await page.getByRole('textbox', { name: 'Nuova password', exact: true }).fill('Lettore-Password-2')
    await page.getByRole('textbox', { name: 'Conferma nuova password', exact: true }).fill('Lettore-Password-2')
    await page.getByRole('button', { name: 'Salva' }).click()
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Apri', exact: true })).toHaveCount(0)
    await expect(page.getByText('Operatori', { exact: true })).toHaveCount(0)
    await page.goto('/operatori')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
  })
})
