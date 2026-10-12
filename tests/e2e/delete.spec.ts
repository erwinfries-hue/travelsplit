import { expect, test } from '@playwright/test'

test('Reiseleitung schliesst eine Reise ab und löscht sie nach Namensbestätigung endgültig', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('E-Mail').fill('erwin@dev.travelsplit.local')
  await page.getByLabel('Passwort').fill('travelsplit-dev')
  await page.getByRole('button', { name: 'Test-Login' }).click()
  await expect(page.getByRole('heading', { name: 'Aktive Reisen' })).toBeVisible()
  await page.goto('/trips/new')
  const title = `Wegwerf ${Date.now()}`
  await page.getByLabel('Name der Reise').fill(title)
  await page.getByLabel('Dein Name in dieser Reise').fill('Erwin')
  await page.getByRole('button', { name: 'Reise erstellen' }).click()
  await page.getByRole('link', { name: /Einstellungen/ }).click()
  await page.getByRole('button', { name: 'Abschliessen' }).click()
  await expect(page.getByRole('heading', { name: 'Reise endgültig löschen' })).toBeVisible()

  const button = page.getByRole('button', { name: 'Endgültig löschen' })
  await expect(button).toBeDisabled()
  await page.getByLabel(/Namen der Reise eingeben/).fill(title)
  await button.click()
  await expect(page.getByRole('heading', { name: 'Aktive Reisen' })).toBeVisible()
  await expect(page.getByText(title)).toHaveCount(0)
})
