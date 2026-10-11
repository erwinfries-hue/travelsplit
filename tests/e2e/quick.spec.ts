import { expect, test, type Page } from '@playwright/test'

async function login(page: Page, next = '/login') {
  await page.goto(next)
  if (!page.url().includes('/login')) await page.goto('/login')
  await page.getByLabel('E-Mail').fill('erwin@dev.travelsplit.local')
  await page.getByLabel('Passwort').fill('travelsplit-dev')
  await page.getByRole('button', { name: 'Test-Login' }).click()
}

test('Schnellerfassung füllt das Formular vor, gespeichert wird erst nach Prüfung', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('heading', { name: 'Aktive Reisen' })).toBeVisible()
  await page.getByText('Lissabon 2026 (Demo)').first().click()

  const quick = page.getByLabel('Schnellerfassung')
  await quick.fill('Fado 40 EUR Erwin Zora')
  await page.getByRole('button', { name: 'Weiter' }).click()
  await expect(page.getByRole('alert')).toHaveText('«Zora» ist in dieser Reise nicht bekannt.')

  const title = `Fado ${Math.random().toString(36).replace(/[^a-z]/g, '').slice(0, 6)}`
  await quick.fill(`${title} 40,50 EUR 25% Erwin 75% larissa`)
  await page.getByRole('button', { name: 'Weiter' }).click()
  await expect(page.getByText('Aus der Schnellerfassung übernommen')).toBeVisible()
  await expect(page.getByLabel('Betrag')).toHaveValue('40,50')
  await expect(page.getByLabel('Titel')).toHaveValue(title)
  await expect(page.getByRole('button', { name: /Roger/ })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByLabel('Prozent für Larissa')).toHaveValue('75')
  await page.getByRole('button', { name: 'Speichern' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
})

test('Android-Teilen öffnet die Schnellerfassung mit dem geteilten Text', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('heading', { name: 'Aktive Reisen' })).toBeVisible()
  await page.goto('/share?text=' + encodeURIComponent('Taxi 12 EUR alle'))
  const pick = page.getByRole('list', { name: 'Für welche Reise?' })
  await expect(pick.or(page.getByLabel('Schnellerfassung'))).toBeVisible()
  if (await pick.isVisible()) await pick.getByText('Lissabon 2026 (Demo)').first().click()
  await expect(page.getByLabel('Schnellerfassung')).toHaveValue('Taxi 12 EUR alle')
})
