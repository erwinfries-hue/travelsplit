import { expect, test, type Page } from '@playwright/test'

async function login(page: Page, who: string) {
  await page.goto('/login')
  await page.getByLabel('E-Mail').fill(`${who}@dev.travelsplit.local`)
  await page.getByLabel('Passwort').fill('travelsplit-dev')
  await page.getByRole('button', { name: 'Test-Login' }).click()
  await expect(page.getByRole('heading', { name: 'Aktive Reisen' })).toBeVisible()
  await page.getByText('Lissabon 2026 (Demo)').first().click()
  await expect(page.getByText('Gesamtausgaben')).toBeVisible()
}

test('Belegfoto wird verkleinert, ohne EXIF/GPS gespeichert und nur per kurzlebiger URL abrufbar', async ({ page }) => {
  await login(page, 'erwin')
  await page.getByRole('link', { name: 'Ausgabe erfassen' }).first().click()
  await page.getByLabel('Betrag').fill('12,40')
  await page.getByLabel('Titel').fill('Foto-Test Bäckerei')
  await page.getByLabel('Beleg').setInputFiles('tests/fixtures/receipt-gps.jpg')
  await expect(page.getByText(/KB, ohne Standort/)).toBeVisible()
  const sizeText = await page.getByText(/KB, ohne Standort/).textContent()
  expect(Number(sizeText!.match(/(\d+) KB/)![1])).toBeLessThanOrEqual(250)
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page).toHaveURL(/\/expenses\/[0-9a-f-]{36}$/)

  const img = page.getByRole('img', { name: 'Belegfoto' })
  await expect(img).toBeVisible()
  const src = await img.getAttribute('src')
  expect(src).toContain('token=')
  const bytes = Buffer.from(await (await page.request.get(src!)).body())
  expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8')
  expect(bytes.includes(Buffer.from('Exif'))).toBe(false)
  expect(bytes.includes(Buffer.from('GPS-Phone'))).toBe(false)
  expect(bytes.length).toBeLessThanOrEqual(250 * 1024)
})

test('Offline erfasste Ausgabe bleibt Entwurf, zählt nicht und wird online genau einmal gebucht', async ({ page, context }) => {
  await login(page, 'erwin')
  const title = `Offline-Test ${Date.now()}`

  await page.getByRole('link', { name: 'Ausgabe erfassen' }).first().click()
  await page.getByLabel('Betrag').fill('7,00')
  await page.getByLabel('Titel').fill(title)
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Speichern' }).click()

  await expect(page.getByRole('heading', { name: 'Nicht gesendet' })).toBeVisible()
  await expect(page.getByText(title)).toBeVisible()
  await expect(page.getByText('Entwurf', { exact: true })).toBeVisible()

  await context.setOffline(false)
  await expect(page.getByRole('heading', { name: 'Nicht gesendet' })).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByText(title)).toHaveCount(1)
  await page.reload()
  await expect(page.getByText(title)).toHaveCount(1)
})

test('Ohne Verbindung öffnet sich die Reise aus der letzten Kopie und kennzeichnet sie', async ({ page, context }) => {
  await login(page, 'erwin')
  await page.getByRole('link', { name: 'Reisen' }).click()
  await expect(page.getByRole('heading', { name: 'Aktive Reisen' })).toBeVisible()
  await context.setOffline(true)
  await page.getByText('Lissabon 2026 (Demo)').first().click()
  await expect(page.getByRole('status').filter({ hasText: 'Offline: Stand vom' })).toBeVisible()
  await expect(page.getByText('Gesamtausgaben')).toBeVisible()
  await context.setOffline(false)
  await expect(page.getByRole('status').filter({ hasText: 'Offline: Stand vom' })).toHaveCount(0)
})
