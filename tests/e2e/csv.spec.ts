import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('E-Mail').fill('erwin@dev.travelsplit.local')
  await page.getByLabel('Passwort').fill('travelsplit-dev')
  await page.getByRole('button', { name: 'Test-Login' }).click()
  await expect(page.getByRole('heading', { name: 'Aktive Reisen' })).toBeVisible()
}

test('CSV-Export einer Reise lässt sich in eine neue Reise importieren, aber nur einmal', async ({ page }) => {
  await login(page)
  await page.getByText('Lissabon 2026 (Demo)').first().click()
  await page.getByRole('link', { name: 'Export & Import' }).click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV herunterladen' }).click()])
  const file = await download.path()
  const csv = readFileSync(file, 'utf8')
  expect(csv.charCodeAt(0)).toBe(0xfeff)
  expect(csv).toContain('"expense_share"')

  await page.getByRole('link', { name: 'Abrechnung als PDF' }).click()
  await expect(page.getByTestId('report-check')).toHaveText(/stimmen mit dem Server überein/)

  await page.goto('/trips/new')
  const title = `Import-Ziel ${Date.now()}`
  await page.getByLabel('Name der Reise').fill(title)
  await page.getByLabel('Dein Name in dieser Reise').fill('Erwin')
  await page.getByRole('button', { name: 'Reise erstellen' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await page.getByRole('link', { name: 'Export & Import' }).click()

  await page.getByLabel('CSV-Datei wählen').setInputFiles(file)
  const preview = page.getByTestId('import-preview')
  await expect(preview).toContainText('Neu als Platzhalter')
  await preview.getByRole('button', { name: /importieren/ }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Importiert:' })).toBeVisible()

  await page.getByLabel('CSV-Datei wählen').setInputFiles(file)
  await page.getByTestId('import-preview').getByRole('button', { name: /importieren/ }).click()
  await expect(page.getByText('Diese Datei wurde in dieser Reise schon importiert.')).toBeVisible()
})
