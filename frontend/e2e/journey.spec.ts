import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'

const fixtures = path.join(import.meta.dirname, 'fixtures')

function trackErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    // 503 from /api/advisor is the expected, documented "AI unavailable" response.
    if (m.type() === 'error' && !/503|Service Unavailable/.test(m.text())) errors.push(`console: ${m.text()}`)
  })
  return errors
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', (d) => d.accept())
})

test('full household journey: steps 1–20 with real OCR, simulator, plan persistence and analytics', async ({ page }) => {
  const errors = trackErrors(page)

  // 1. Open SmartWatts — first-time onboarding
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /see what to change/i })).toBeVisible()
  await page.getByRole('button', { name: /^start$/i }).click()

  // 2. Choose language
  await page.getByRole('button', { name: 'English' }).click()
  await expect(page.getByRole('heading', { name: /add your meralco bill/i })).toBeVisible()

  // 3. Scan/upload bill -> real Tesseract OCR on the backend
  await page.getByTestId('bill-file').setInputFiles(path.join(fixtures, 'sample-bill.png'))
  await expect(page.getByRole('img', { name: /bill photo preview/i })).toBeVisible()
  await page.getByRole('button', { name: /read my bill/i }).click()

  // 4. Review & confirm — OCR values are editable, never auto-saved
  await expect(page.getByRole('heading', { name: /review & confirm bill details/i })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByLabel(/total consumption/i)).toHaveValue('280')
  await expect(page.getByLabel(/total amount due/i)).toHaveValue('3500')
  await expect(page.getByLabel(/billing period start/i)).toHaveValue('2026-09-15')
  await expect(page.getByLabel(/billing period end/i)).toHaveValue('2026-10-14')

  // 5. "No" branch: user edits, then confirms
  await page.getByRole('button', { name: /no, let me fix them/i }).click()
  await expect(page.getByRole('button', { name: /retake photo/i })).toBeVisible()
  await page.getByRole('radio', { name: /proposal reference rate/i }).check()

  // 6. Save bill data
  await page.getByRole('button', { name: /yes, save bill/i }).click()
  await expect(page.getByRole('heading', { name: /your appliances/i })).toBeVisible()

  // 7–8. Add appliance with label scan (real OCR), set usage
  await page.getByRole('link', { name: /add appliance/i }).click()
  await page.getByLabel(/appliance type/i).selectOption('fan')
  await page.getByTestId('label-file').setInputFiles(path.join(fixtures, 'fan-label.jpg'))
  await page.getByRole('button', { name: 'Use 65 W' }).click({ timeout: 30_000 })
  await expect(page.getByLabel(/rated power/i)).toHaveValue('65')
  await page.getByLabel(/hours used per day/i).fill('8')
  await expect(page.getByLabel(/days used/i)).toHaveValue('30')
  await page.getByRole('button', { name: /save appliance/i }).click()

  // 9–11. Review list, decision, save
  await expect(page.getByText(/estimated 15\.6 kWh per billing period/i)).toBeVisible()
  await page.getByRole('button', { name: /yes, save appliance list/i }).click()

  // 12–13. Simulator 8h -> 6h
  await expect(page.getByRole('heading', { name: /what-if savings simulator/i })).toBeVisible()
  await expect(page.getByTestId('before-kwh')).toHaveText('15.6 kWh')
  await page.getByRole('textbox', { name: /hours used per day/i }).fill('6')
  await expect(page.getByTestId('after-kwh')).toHaveText('11.7 kWh')
  await expect(page.getByTestId('delta-kwh')).toHaveText('−3.9 kWh')
  await expect(page.getByTestId('delta-php')).toHaveText('−₱48.48')
  await expect(page.getByTestId('rate-used')).toContainText('12.43')

  // 15. Decision: No -> 16. Save plan
  await page.getByRole('button', { name: /no, save this plan/i }).click()
  await page.getByLabel(/personal goal/i).fill('Fan off by 2 AM')
  await page.getByRole('button', { name: /save savings plan/i }).click()
  await expect(page.getByTestId('plans-list')).toContainText('₱48.48')

  // Refresh: the plan must still be there
  await page.reload()
  await expect(page.getByTestId('plans-list')).toContainText('3.9 kWh')
  await expect(page.getByTestId('plans-list')).toContainText('Fan off by 2 AM')

  // 17. Analytics: one bill -> honest empty trend state; estimates + opportunities shown
  await page.goto('/analytics')
  await expect(page.getByText(/you have one bill so far/i)).toBeVisible()
  await expect(page.getByTestId('opportunities')).toContainText('3.9 kWh')

  // 14. Advisor: no AI key configured -> documented unavailable behaviour, no fake answer
  await page.goto('/advisor')
  await page.getByRole('button', { name: /how can i lower/i }).click()
  await expect(page.getByText(/energy advisor is not available right now/i)).toBeVisible()
  await expect(page.getByTestId('advisor-facts')).toContainText('280 kWh')

  // 19–20. Advanced features decision -> continue
  await page.goto('/more')
  await expect(page.getByText(/no purchases are possible/i)).toBeVisible()
  await page.getByRole('button', { name: /no, continue using smartwatts/i }).click()
  await expect(page).toHaveURL(/\/plans$/)

  // Returning user (step 20)
  await page.goto('/')
  await expect(page.getByText(/welcome back/i)).toBeVisible()

  expect(errors).toEqual([])
})

test('manual entry fallback and validation', async ({ page }) => {
  const errors = trackErrors(page)
  await page.goto('/bill')
  await page.getByRole('button', { name: /enter bill details manually/i }).first().click()
  await page.getByRole('button', { name: /yes, save bill/i }).click()
  await expect(page.getByText(/please fix the highlighted fields/i)).toBeVisible()
  await expect(page.getByLabel(/billing period start/i)).toBeFocused()
  await page.getByLabel(/billing period start/i).fill('2026-08-15')
  await page.getByLabel(/billing period end/i).fill('2026-09-14')
  await page.getByLabel(/total consumption/i).fill('250')
  await page.getByLabel(/total amount due/i).fill('3,100.00')
  await expect(page.getByText(/your effective rate: ₱12\.40\/kWh/i)).toBeVisible()
  await page.getByRole('button', { name: /yes, save bill/i }).click()
  await expect(page.getByRole('heading', { name: /your appliances/i })).toBeVisible()
  expect(errors).toEqual([])
})

test('offline: saved data and calculations still work; network features say so', async ({ page, context }) => {
  await page.goto('/bill')
  await page.getByRole('button', { name: /enter bill details manually/i }).first().click()
  await page.getByLabel(/billing period start/i).fill('2026-08-15')
  await page.getByLabel(/billing period end/i).fill('2026-09-14')
  await page.getByLabel(/total consumption/i).fill('250')
  await page.getByLabel(/total amount due/i).fill('3100')
  await page.getByRole('button', { name: /yes, save bill/i }).click()
  await expect(page.getByRole('heading', { name: /your appliances/i })).toBeVisible()
  // Let the service worker finish precaching before going offline.
  await page.waitForFunction(async () => !!(await navigator.serviceWorker?.getRegistration())?.active)

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByText(/offline — calculations and saved data still work/i)).toBeVisible()
  await page.getByRole('link', { name: /add appliance/i }).click()
  await page.getByLabel(/appliance type/i).selectOption('aircon')
  await expect(page.getByLabel(/^name$/i)).toHaveValue('Air conditioner')
  await page.getByLabel(/rated power/i).fill('1000')
  await page.getByLabel(/hours used per day/i).fill('8')
  await page.getByRole('button', { name: /save appliance/i }).click()
  await page.getByRole('button', { name: /yes, save appliance list/i }).click()
  await page.getByRole('textbox', { name: /hours used per day/i }).fill('6')
  await expect(page.getByTestId('delta-kwh')).toHaveText('−62 kWh')
  await page.getByRole('link', { name: /advisor/i }).first().click()
  await page.getByRole('button', { name: /how can i lower/i }).click()
  await expect(page.getByText(/energy advisor needs internet/i)).toBeVisible()
  await context.setOffline(false)
})

test('manage: bad image recovery, keyboard-only entry, edit appliance -> plan recalculation, delete plan', async ({ page }) => {
  const errors = trackErrors(page)

  // Image upload failure (server rejects an unreadable file) -> plain-language error -> manual entry
  await page.goto('/bill')
  await page.getByTestId('bill-file').setInputFiles(path.join(fixtures, 'corrupt.png'))
  await page.getByRole('button', { name: /read my bill/i }).click()
  await expect(page.getByText(/we could not read this photo/i)).toBeVisible()
  await page.getByRole('alert').getByRole('button', { name: /enter bill details manually/i }).click()

  // Keyboard-only bill entry: type, then Enter submits; decision buttons reachable by Tab
  await page.getByLabel(/billing period start/i).fill('2026-09-15')
  await page.getByLabel(/billing period end/i).fill('2026-10-14')
  await page.getByLabel(/total consumption/i).focus()
  await page.keyboard.type('280')
  await page.keyboard.press('Tab')
  await page.keyboard.type('3500')
  await page.getByRole('radio', { name: /proposal reference rate/i }).focus()
  await page.keyboard.press('Space')
  await page.getByLabel(/total amount due/i).press('Enter')
  await expect(page.getByRole('heading', { name: /your appliances/i })).toBeVisible()

  // Appliance + plan
  await page.getByRole('link', { name: /add appliance/i }).click()
  await page.getByLabel(/rated power/i).fill('65')
  await page.getByLabel(/hours used per day/i).fill('8')
  await page.getByLabel(/hours used per day/i).press('Enter')
  await page.getByRole('button', { name: /yes, save appliance list/i }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('textbox', { name: /hours used per day/i }).fill('6')
  await page.getByRole('button', { name: /no, save this plan/i }).click()
  await page.getByRole('button', { name: /save savings plan/i }).click()
  await expect(page.getByTestId('plans-list')).toContainText('3.9 kWh')

  // Edit the appliance (8h -> 10h): plan keeps original assumptions but is flagged; recalculation updates it
  await page.goto('/appliances')
  await page.getByRole('link', { name: /edit electric fan/i }).click()
  await page.getByLabel(/hours used per day/i).fill('10')
  await page.getByRole('button', { name: /save appliance/i }).click()
  await expect(page.getByText(/estimated 19\.5 kWh/i)).toBeVisible()
  await page.getByRole('button', { name: /yes, save appliance list/i }).click()
  await page.goto('/plans')
  await expect(page.getByTestId('plans-list')).toContainText('3.9 kWh')
  await expect(page.getByText(/your appliance or rate changed/i)).toBeVisible()
  await page.getByRole('button', { name: /recalculate with current values/i }).click()
  // 65 W x (10 - 6) h x 30 d = 7.8 kWh; x 12.43 = 96.954 -> 96.95
  await expect(page.getByTestId('plans-list')).toContainText('7.8 kWh')
  await expect(page.getByTestId('plans-list')).toContainText('₱96.95')
  await expect(page.getByText(/recalculated/i)).toBeVisible()

  // Delete the plan safely (confirm dialog accepted in beforeEach), survives reload
  await page.getByRole('button', { name: /^delete$/i }).click()
  await expect(page.getByText(/no saved plans yet/i)).toBeVisible()
  await page.reload()
  await expect(page.getByText(/no saved plans yet/i)).toBeVisible()
  expect(errors.filter((e) => !/422/.test(e))).toEqual([])
})
