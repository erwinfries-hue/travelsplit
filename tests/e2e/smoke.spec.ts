import { expect, test, type Page } from '@playwright/test'

const PASSWORD = 'travelsplit-dev'

async function login(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('E-Mail').fill(`${who}@dev.travelsplit.local`)
  await page.getByLabel('Passwort').fill(PASSWORD)
  await page.getByRole('button', { name: 'Test-Login' }).click()
  await expect(page.getByRole('heading', { name: 'Aktive Reisen' })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  ;(page as Page & { errors?: string[] }).errors = errors
})

test('admin sees the demo trip, adds an expense and sees balances', async ({ page }) => {
  await login(page, 'erwin')
  await page.getByText('Lissabon 2026 (Demo)').first().click()
  await expect(page.getByText('Gesamtausgaben')).toBeVisible()

  await page.getByRole('link', { name: 'Ausgabe erfassen' }).first().click()
  await page.getByLabel('Betrag').fill('30,00')
  await page.getByLabel('Titel').fill('Smoke-Test Kaffee')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByText('Smoke-Test Kaffee').first()).toBeVisible()

  await page.getByRole('link', { name: 'Salden' }).first().click()
  await expect(page.getByRole('heading', { name: 'Vorschläge zum Ausgleich' })).toBeVisible()
  await page.screenshot({ path: 'test-results/balances-mobile.png', fullPage: true })

  expect((page as Page & { errors?: string[] }).errors).toEqual([])
})

test('member sees the trip but no admin management', async ({ page }) => {
  await login(page, 'larissa')
  await page.getByText('Lissabon 2026 (Demo)').first().click()
  await expect(page.getByText('Mein Saldo')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Verwalten' })).toHaveCount(0)
})

test('a non-member sees no trips', async ({ page }) => {
  await login(page, 'roger')
  await expect(page.getByText('Lissabon 2026 (Demo)')).toHaveCount(0)
})
