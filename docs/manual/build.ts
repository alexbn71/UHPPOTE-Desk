/**
 * Builds the user manual (docs/UHPPOTE-Desk-Manual.pdf):
 *   1. starts the application with a simulated controller and a fresh database,
 *   2. fills it with demonstration data (people, cards, permissions, events, attendance…),
 *   3. takes screenshots of every page with Playwright,
 *   4. renders docs/manual/manual.html (which references the screenshots) to PDF.
 *
 *   npm run manual        (builds the web app first)
 *
 * With `--readme` (npm run screenshots) it only takes the screenshots shown in the README (docs/screenshots).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { FakeController } from '@uhppote-desk/protocol/testing'
import { buildApp } from '../../apps/server/src/app.js'
import { createContext } from '../../apps/server/src/context.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const MANUAL_DIR = path.join(ROOT, 'docs/manual')
const SHOTS = path.join(MANUAL_DIR, 'shots')
const OUTPUT = path.join(ROOT, 'docs/UHPPOTE-Desk-Manual.pdf')
const README_SHOTS = path.join(ROOT, 'docs/screenshots')
const PORT = 8091
const BASE = `http://127.0.0.1:${PORT}`
const SERIAL = 405419896
const PASSWORD = 'manual-demo-pass'

if (!fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html'))) {
  console.error('apps/web/dist not found: run "npm run build --workspace @uhppote-desk/web" first (or use "npm run manual")')
  process.exit(1)
}
fs.rmSync(SHOTS, { recursive: true, force: true })
fs.mkdirSync(SHOTS, { recursive: true })

// --- application with a simulated controller ----------------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uhppote-desk-manual-'))
const fake = new FakeController({ id: SERIAL, host: '127.0.0.1', port: 60030, tcp: true, address: '192.168.1.50', gateway: '192.168.1.1' })
await fake.start()
const quiet = { info: () => undefined, warn: () => undefined, error: (m: string) => console.error(m) }
const ctx = createContext(
  {
    httpPort: PORT,
    httpHost: '127.0.0.1',
    dataDir,
    secureCookies: false,
    sessionHours: 2,
    adminPassword: null,
    adminPasswordFromLegacyVariable: false,
    webDir: path.join(ROOT, 'apps/web/dist'),
    uhppote: {
      bindAddress: '127.0.0.1',
      broadcast: '127.0.0.1:60030',
      listen: '127.0.0.1:60031',
      listenerPublic: '127.0.0.1:60031',
      timeoutMs: 800,
      retries: 1,
      debug: false,
    },
    healthIntervalSec: 2,
    collectIntervalSec: 3600,
    timeSyncThresholdSec: 0,
    initialBackfill: 1000,
    backupHour: -1,
    backupKeep: 3,
    mqtt: null,
    publicUrl: null,
  },
  quiet,
)
// admin with a normal (changeable) password, so that the Change password page shows its form
await ctx.auth.ensureAdmin(null)
await ctx.auth.setPassword(ctx.db.get<{ id: number }>("SELECT id FROM operators WHERE username = 'admin'")!.id, PASSWORD, false)
await ctx.eventService.startListener()
const app = await buildApp(ctx)
await app.listen({ port: PORT, host: '127.0.0.1' })

// --- API helpers -------------------------------------------------------------------------------------------------
let cookie = ''
async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`)
  // login sets several cookies (session, and clears the device cookie): keep the ones with a value
  const set = r.headers.getSetCookie().map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('='))
  if (set.length) cookie = set.join('; ')
  return (await r.json()) as T
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const year = new Date().getFullYear()

/** Swipe at a given (past) time: the simulated controller clock is moved for the swipe only. */
function swipeAt(day: Date, hhmm: string, card: number, door: number, direction = 1): void {
  const [h, m] = hhmm.split(':').map(Number)
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, Math.floor(Math.random() * 50))
  fake.clockOffsetMs = at.getTime() - Date.now()
  fake.swipe(card, door, direction)
  fake.clockOffsetMs = 0
}

// --- demonstration data ------------------------------------------------------------------------------------------
console.log('Creating demonstration data…')
await call('POST', '/auth/login', { username: 'admin', password: PASSWORD })

const hq = await call<{ id: number }>('POST', '/zones', { name: 'Headquarters', parentId: null })
await call('POST', '/zones', { name: 'Warehouse building', parentId: null })
const admin = await call<{ id: number }>('POST', '/departments', { name: 'Administration', parentId: null })
const production = await call<{ id: number }>('POST', '/departments', { name: 'Production', parentId: null })
const assembly = await call<{ id: number }>('POST', '/departments', { name: 'Assembly', parentId: production.id })
const logistics = await call<{ id: number }>('POST', '/departments', { name: 'Logistics', parentId: null })

const controller = await call<{ id: number }>('POST', '/controllers', { serial: SERIAL, name: 'Main building', host: '127.0.0.1', port: 60030, transport: 'udp', zoneId: hq.id, enabled: true })
await ctx.health.check(controller.id)
const doors = await call<{ id: number; door: number }[]>('GET', '/doors')
const door = (n: number) => doors.find((d) => d.door === n)!.id
const doorSetup: [number, string, boolean][] = [
  [1, 'Main entrance', true],
  [2, 'Warehouse', false],
  [3, 'Server room', false],
  [4, 'Back office', false],
]
for (const [n, name, attendance] of doorSetup) await call('PUT', `/doors/${door(n)}`, { name, active: true, attendance, mode: 3, delay: n === 2 ? 8 : 5 })

const weekdays = [true, true, true, true, true, false, false]
await call('PUT', '/time-profiles/2', { id: 2, name: 'Office hours', validFrom: `${year}-01-01`, validTo: `${year + 1}-12-31`, weekdays, segments: [{ start: '07:30', end: '19:00' }], linkedTo: null })
await call('PUT', '/time-profiles/3', {
  id: 3,
  name: 'Warehouse shifts',
  validFrom: `${year}-01-01`,
  validTo: `${year + 1}-12-31`,
  weekdays: [true, true, true, true, true, true, false],
  segments: [
    { start: '05:30', end: '14:30' },
    { start: '13:30', end: '22:30' },
  ],
  linkedTo: null,
})
await call('PUT', '/time-profiles/4', { id: 4, name: 'Saturday morning', validFrom: `${year}-01-01`, validTo: `${year + 1}-12-31`, weekdays: [false, false, false, false, false, true, false], segments: [{ start: '08:00', end: '12:30' }], linkedTo: 2 })

const office = await call<{ id: number }>('POST', '/shifts', { name: 'Office', startTime: '08:30', endTime: '17:30', breakMinutes: 60, toleranceMinutes: 10, weekdays })
const early = await call<{ id: number }>('POST', '/shifts', { name: 'Warehouse early', startTime: '06:00', endTime: '14:00', breakMinutes: 30, toleranceMinutes: 5, weekdays })
await call('POST', '/shifts', { name: 'Night security', startTime: '22:00', endTime: '06:00', breakMinutes: 0, toleranceMinutes: 15, weekdays: [true, true, true, true, true, true, true] })

const peopleData = [
  { code: 'E001', firstName: 'Maria', lastName: 'Rossi', departmentId: admin.id, shiftId: office.id, card: 10058400, email: 'maria.rossi@example.com', color: '#2b8ae6' },
  { code: 'E002', firstName: 'Luca', lastName: 'Bianchi', departmentId: assembly.id, shiftId: early.id, card: 10058401, email: '', color: '#34c38f' },
  { code: 'E003', firstName: 'Giulia', lastName: 'Ferrari', departmentId: admin.id, shiftId: office.id, card: 10058402, email: '', color: '#e8590c' },
  { code: 'E004', firstName: 'John', lastName: 'Smith', departmentId: logistics.id, shiftId: early.id, card: 10058403, email: '', color: '#7048e8' },
  { code: 'E005', firstName: 'Anna', lastName: 'Müller', departmentId: production.id, shiftId: null, card: 10058404, email: '', color: '#d6336c' },
  { code: 'E006', firstName: 'Sofia', lastName: 'García', departmentId: logistics.id, shiftId: null, card: 10058405, email: '', color: '#0ca678' },
]
const people: { id: number; card: number }[] = []
for (const p of peopleData) {
  const created = await call<{ id: number }>('POST', '/people', {
    code: p.code,
    firstName: p.firstName,
    lastName: p.lastName,
    departmentId: p.departmentId,
    email: p.email,
    phone: '',
    notes: '',
    pin: p.code === 'E001' ? 4821 : 0,
    validFrom: `${year}-01-01`,
    validTo: `${year + 2}-12-31`,
    active: true,
    shiftId: p.shiftId,
  })
  await call('POST', '/cards', { number: p.card, personId: created.id })
  people.push({ id: created.id, card: p.card })
}
const [rossi, bianchi, ferrari, smith, muller, garcia] = people as [typeof people[0], typeof people[0], typeof people[0], typeof people[0], typeof people[0], typeof people[0]]
await call('PUT', `/people/${rossi.id}/permissions`, {
  permissions: [
    { doorId: door(1), profileId: null, firstCard: true },
    { doorId: door(3), profileId: 2, firstCard: false },
    { doorId: door(4), profileId: null, firstCard: false },
  ],
})
await call('POST', '/permissions/bulk', { personIds: [bianchi.id, smith.id, garcia.id], doorIds: [door(1), door(2)], action: 'grant', profileId: 3 })
await call('POST', '/permissions/bulk', { personIds: [ferrari.id, muller.id], doorIds: [door(1), door(4)], action: 'grant', profileId: 2 })
for (let n = 10058410; n <= 10058419; n++) await call('POST', '/cards', { number: n, personId: null })

// photos: generated avatars with the initials
const browser = await chromium.launch()
{
  const page = await browser.newPage({ viewport: { width: 240, height: 240 } })
  for (const [i, p] of peopleData.entries()) {
    await page.setContent(
      `<div id="a" style="width:240px;height:240px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,${p.color},#1557a8);color:#fff;font:600 96px system-ui,Segoe UI,sans-serif">${p.firstName[0]}${p.lastName[0]}</div>`,
    )
    const png = await page.locator('#a').screenshot()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'photo.png')
    const r = await fetch(`${BASE}/api/people/${people[i]!.id}/photo`, { method: 'PUT', headers: { cookie }, body: form })
    if (!r.ok) throw new Error(`photo upload: ${r.status} ${await r.text()}`)
  }
  await page.close()
}

await call('POST', '/tasks', { controllerId: controller.id, door: 2, task: 1, validFrom: `${year}-01-01`, validTo: `${year + 1}-12-31`, weekdays, startTime: '07:00', moreCards: 0, enabled: true })
await call('POST', '/tasks', { controllerId: controller.id, door: 2, task: 0, validFrom: `${year}-01-01`, validTo: `${year + 1}-12-31`, weekdays, startTime: '18:00', moreCards: 0, enabled: true })
await call('POST', '/tasks', { controllerId: controller.id, door: 3, task: 7, validFrom: `${year}-01-01`, validTo: `${year + 1}-12-31`, weekdays: [true, true, true, true, true, true, true], startTime: '20:00', moreCards: 0, enabled: true })

const settings = await call<Record<string, unknown>>('GET', `/controllers/${controller.id}/settings`)
await call('PUT', `/controllers/${controller.id}/settings`, {
  ...settings,
  recordSpecialEvents: true,
  interlock: 0,
  keypads: [false, false, true, false],
  passcodes: [[], [], [135790], []],
  expansionBoard: {
    installed: true,
    doorOpenTooLong: 30,
    duressCode: null,
    relays: [
      { active: true, source: 0, mode: 1, events: 0x04 | 0x10, signals: 0, duration: 20 },
      { active: true, source: 0, mode: 3, events: 0x02, signals: 0, duration: 10 },
      { active: false, source: 2, mode: 1, events: 0x27, signals: 0, duration: 10 },
      { active: true, source: 1, mode: 1, events: 0x20, signals: 0, duration: 300 },
    ],
  },
})

await call('POST', `/holidays/italian/${year}`)

await call('POST', '/operators', { username: 'reception', displayName: 'Reception desk', role: 'operator', active: true, password: 'reception-pass', zoneIds: [hq.id] })
await call('POST', '/operators', { username: 'hr.office', displayName: 'HR office', role: 'viewer', active: true, password: 'hr-office-pass', zoneIds: [] })

// attendance swipes on the working days of the current month before today (at least the last 5 working days)
const workDays: Date[] = []
for (let d = new Date(); workDays.length < 10; ) {
  d = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)
  if (d.getDay() !== 0 && d.getDay() !== 6) workDays.unshift(d)
}
const thisMonth = workDays.filter((d) => d.getMonth() === new Date().getMonth())
const days = thisMonth.length >= 5 ? thisMonth : workDays.slice(-5)
const jitter = (base: string, spread: number) => {
  const [h, m] = base.split(':').map(Number)
  const t = h! * 60 + m! + Math.round((Math.random() - 0.5) * spread)
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`
}
for (const [i, day] of days.entries()) {
  swipeAt(day, i === 1 ? '08:52' : jitter('08:24', 8), rossi.card, 1, 1)
  swipeAt(day, jitter('17:38', 20), rossi.card, 1, 2)
  swipeAt(day, jitter('05:54', 6), bianchi.card, 1, 1)
  swipeAt(day, jitter('14:06', 10), bianchi.card, 1, 2)
  if (i === days.length - 2) {
    // Ferrari on holiday that day (see leave below)
  } else {
    swipeAt(day, jitter('08:27', 6), ferrari.card, 1, 1)
    swipeAt(day, jitter('12:31', 4), ferrari.card, 1, 2)
    swipeAt(day, jitter('13:29', 4), ferrari.card, 1, 1)
    swipeAt(day, jitter('17:33', 8), ferrari.card, 1, 2)
  }
  swipeAt(day, jitter('05:58', 4), smith.card, 1, 1)
  if (i !== days.length - 1) swipeAt(day, jitter('15:10', 30), smith.card, 1, 2) // forgot to punch out on the last day
  swipeAt(day, jitter('09:15', 30), muller.card, 1, 1)
  swipeAt(day, jitter('16:45', 30), muller.card, 1, 2)
  // other doors: warehouse, back office, a denied attempt
  swipeAt(day, jitter('10:15', 60), bianchi.card, 2, 1)
  swipeAt(day, jitter('11:40', 60), garcia.card, 2, 1)
  swipeAt(day, jitter('15:20', 60), rossi.card, 4, 1)
  if (i % 2 === 0) swipeAt(day, jitter('19:45', 20), ferrari.card, 3, 1)
}
await call('POST', '/leaves', { personId: ferrari.id, fromDate: ymd(days[days.length - 2]!), toDate: ymd(days[days.length - 2]!), type: 'ferie', notes: '' })
await call('POST', '/punches', { personId: smith.id, timestamp: `${ymd(days[days.length - 1]!)} 14:02`, direction: 2, reason: 'Forgot to swipe on exit' })

// today: a few events for the dashboard and the history
const today = new Date()
swipeAt(today, '08:02', smith.card, 2, 1)
swipeAt(today, '08:11', rossi.card, 4, 1)
fake.swipe(10065001, 1, 1) // unknown card: offered for registration
fake.setDoorSensor(2, true)
fake.setDoorSensor(2, false)
fake.pressButton(4)
await call('POST', `/controllers/${controller.id}/collect`)
await call('POST', `/doors/${door(1)}/open`)
await call('POST', `/controllers/${controller.id}/sync/all`)
await sleep(500)

// --- README screenshots ------------------------------------------------------------------------------------
if (process.argv.includes('--readme')) {
  await readmeScreenshots()
  await shutdown()
  console.log(`README screenshots written to ${path.relative(ROOT, README_SHOTS)}`)
  process.exit(0)
}

/** Full-window screenshots for the README: light and dark desktop, and the mobile app on a phone. */
async function readmeScreenshots(): Promise<void> {
  fs.rmSync(README_SHOTS, { recursive: true, force: true })
  fs.mkdirSync(README_SHOTS, { recursive: true })
  const open = async (options: Parameters<typeof browser.newContext>[0]) => {
    const context = await browser.newContext({ locale: 'en-GB', ...options })
    const page = await context.newPage()
    await page.goto(BASE)
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill('admin')
    await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Log in' }).click()
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor()
    await page.getByText('Online').first().waitFor({ timeout: 10_000 })
    return { context, page }
  }
  const save = async (page: Page, name: string) => {
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.mouse.move(0, 0) // no hover effects or chart tooltips
    await sleep(600)
    await page.screenshot({ path: path.join(README_SHOTS, `${name}.png`) })
    console.log(`  ${name}`)
  }
  const visit = async (page: Page, url: string, heading: string) => {
    await page.goto(`${BASE}${url}`)
    await page.getByRole('heading', { name: heading, exact: true }).first().waitFor()
  }

  const desktop = { viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1 }
  for (const scheme of ['light', 'dark'] as const) {
    const { context, page } = await open({ ...desktop, colorScheme: scheme })
    await save(page, scheme === 'light' ? 'dashboard' : 'dashboard-dark')
    if (scheme === 'light') {
      await visit(page, '/monitor', 'Monitor')
      await page.getByText('Live', { exact: true }).first().waitFor()
      fake.swipe(garcia.card, 2, 1)
      await sleep(700)
      fake.swipe(10099999, 3, 1)
      await sleep(700)
      fake.swipe(rossi.card, 1, 1)
      await page.getByText('Rossi Maria').first().waitFor({ timeout: 10_000 })
      await save(page, 'monitor')
      await visit(page, '/people', 'People')
      await page.getByRole('cell', { name: 'E001' }).click()
      await page.getByRole('tab', { name: 'Details' }).waitFor()
      await save(page, 'person')
      await visit(page, '/attendance', 'Attendance')
      await page.getByText('Period summary').waitFor()
      await save(page, 'attendance')
      await visit(page, `/controllers/${controller.id}`, 'Main building')
      await page.getByText('v8.92').first().waitFor({ timeout: 10_000 })
      await save(page, 'controller')
    }
    await context.close()
  }

  const { context, page } = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })
  await page.goto(`${BASE}/m`)
  await page.getByText('Main entrance').first().waitFor({ timeout: 10_000 })
  await save(page, 'mobile')
  await context.close()
}

// --- screenshots ---------------------------------------------------------------------------------------------
console.log('Taking screenshots…')
const context = await browser.newContext({ viewport: { width: 1360, height: 850 }, deviceScaleFactor: 2, colorScheme: 'light', locale: 'en-GB' })
const page = await context.newPage()

/**
 * Screenshot of the page. By default only the content area (without the header and the navigation bar), cut at
 * `maxHeight` CSS pixels; `whole` keeps the full window (header and navigation included).
 */
async function shot(name: string, opts: { whole?: boolean; maxHeight?: number } = {}): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined)
  await sleep(400)
  const file = path.join(SHOTS, `${name}.png`)
  const dialog = page.locator('[role="dialog"]:visible').last()
  if (await dialog.count()) {
    await dialog.screenshot({ path: file })
  } else if (opts.whole) {
    await page.screenshot({ path: file })
  } else {
    const height = await page.evaluate(() => document.documentElement.scrollHeight)
    const x = 241
    const y = 62
    await page.screenshot({ path: file, fullPage: true, clip: { x, y, width: 1360 - x, height: Math.min(height - y, opts.maxHeight ?? 1100) } })
  }
  console.log(`  ${name}`)
}
async function go(url: string, heading: string): Promise<void> {
  await page.goto(`${BASE}${url}`)
  await page.getByRole('heading', { name: heading, exact: true }).first().waitFor()
}

await page.goto(BASE)
await page.getByRole('textbox', { name: 'Username', exact: true }).waitFor()
await page.locator('form').first().screenshot({ path: path.join(SHOTS, 'login.png') })
await page.getByRole('textbox', { name: 'Username', exact: true }).fill('admin')
await page.getByRole('textbox', { name: 'Password', exact: true }).fill(PASSWORD)
await page.getByRole('button', { name: 'Log in' }).click()
await page.getByRole('heading', { name: 'Dashboard' }).waitFor()
await page.getByText('Online').first().waitFor({ timeout: 10_000 })
await shot('dashboard', { whole: true })

await page.getByRole('button', { name: 'Language' }).first().click()
await page.getByRole('menuitem', { name: 'Deutsch' }).waitFor()
await sleep(300)
await page.screenshot({ path: path.join(SHOTS, 'language.png'), clip: { x: 900, y: 0, width: 460, height: 300 } })
await page.keyboard.press('Escape')

await go('/monitor', 'Monitor')
await page.getByText('Live', { exact: true }).first().waitFor()
fake.swipe(garcia.card, 2, 1)
await sleep(700)
fake.swipe(10099999, 3, 1)
await sleep(700)
fake.swipe(rossi.card, 1, 1)
await page.getByText('Rossi Maria').first().waitFor({ timeout: 10_000 })
await shot('monitor', { maxHeight: 700 })

await go('/events', 'Event history')
await shot('events')

await go('/people', 'People')
await shot('people')
await page.getByRole('cell', { name: 'E001' }).click()
await page.getByRole('tab', { name: 'Details' }).waitFor()
await shot('person-details')
await page.getByRole('tab', { name: /Cards/ }).click()
await shot('person-cards')
await page.getByRole('tab', { name: 'Permissions' }).click()
await shot('person-permissions')
await page.keyboard.press('Escape')

await go('/cards', 'Cards')
await shot('cards')
await go('/permissions', 'Access permissions')
await shot('permissions')
await go('/structure', 'Departments and zones')
await shot('structure')

await go('/controllers', 'Controllers')
await shot('controllers', { maxHeight: 420 })
await page.getByRole('button', { name: 'Search network' }).click()
await page.getByRole('button', { name: 'Start search' }).click()
await page.getByRole('dialog').getByRole('cell', { name: String(SERIAL) }).waitFor({ timeout: 10_000 })
await shot('discovery')
await page.keyboard.press('Escape')

await go(`/controllers/${controller.id}`, 'Main building')
await page.getByText('v8.92').first().waitFor({ timeout: 10_000 })
await shot('controller-diagnostics', { maxHeight: 1600 })
await page.getByRole('tab', { name: 'Network and configuration' }).click()
await shot('controller-network', { maxHeight: 1600 })
await page.getByRole('tab', { name: 'Advanced settings' }).click()
await shot('controller-advanced', { maxHeight: 1600 })
await page.getByRole('tab', { name: 'Expansion board' }).click()
await page.getByText('Alarm expansion board (UT0311-01A)').waitFor()
await shot('controller-expansion', { maxHeight: 1600 })
await page.getByRole('tab', { name: 'Maintenance' }).click()
await shot('controller-maintenance', { maxHeight: 1600 })

await go('/doors', 'Doors')
await shot('doors', { maxHeight: 480 })
await go('/time-profiles', 'Time profiles')
await shot('time-profiles', { maxHeight: 480 })
await page.getByRole('row', { name: /Saturday morning/ }).getByRole('button', { name: 'Edit' }).click()
await page.getByRole('dialog').waitFor()
await shot('time-profile-edit')
await page.keyboard.press('Escape')
await go('/tasks', 'Scheduled tasks')
await shot('tasks', { maxHeight: 480 })

await go('/sync', 'Synchronisation')
await page.getByRole('button', { name: 'Compare' }).first().click()
await page.getByText(/aligned/).first().waitFor({ timeout: 10_000 })
await shot('sync', { maxHeight: 520 })

await go('/attendance', 'Attendance')
await page.getByText('Period summary').waitFor()
await shot('attendance-report', { maxHeight: 1250 })
for (const [tab, name] of [
  ['Shifts', 'attendance-shifts'],
  ['Holidays', 'attendance-holidays'],
  ['Leave and absences', 'attendance-leaves'],
  ['Manual punches', 'attendance-punches'],
] as const) {
  await page.getByRole('tab', { name: tab }).click()
  await shot(name, { maxHeight: 640 })
}

await go('/operators', 'Operators')
await shot('operators', { maxHeight: 480 })
await go('/audit', 'Audit log')
await shot('audit', { maxHeight: 760 })
await go('/system', 'System')
await shot('system', { maxHeight: 1600 })
await go('/password', 'Change password')
await shot('password', { maxHeight: 520 })
await context.close()

// --- PDF -----------------------------------------------------------------------------------------------------------
console.log('Rendering the PDF…')
const pdfPage = await browser.newPage()
await pdfPage.goto(`file://${path.join(MANUAL_DIR, 'manual.html').replaceAll('\\', '/')}`)
await pdfPage.waitForLoadState('networkidle')
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string
await pdfPage.evaluate((v) => {
  document.querySelectorAll('[data-version]').forEach((e) => (e.textContent = v))
  document.querySelectorAll('[data-date]').forEach((e) => (e.textContent = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long' })))
}, version)
await pdfPage.pdf({
  path: OUTPUT,
  format: 'A4',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate:
    '<div style="width:100%;font:8px system-ui,Segoe UI,sans-serif;color:#7a8699;padding:0 14mm;display:flex;justify-content:space-between"><span>UHPPOTE Desk — User manual</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  margin: { top: '14mm', bottom: '16mm', left: '0', right: '0' },
})
await pdfPage.close()
await shutdown()
console.log(`Manual written to ${path.relative(ROOT, OUTPUT)}`)

async function shutdown(): Promise<void> {
  await browser.close()
  await app.close()
  await ctx.eventService.stopListener()
  ctx.db.close()
  await fake.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
