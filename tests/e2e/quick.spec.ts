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

test('WhatsApp-Prüffall erscheint in der Reise, öffnet die Schnellerfassung und lässt sich erledigen', async ({ page }) => {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' })
  await client.connect()
  try {
    const { rows } = await client.query(`
      select t.id as trip_id, u.id as user_id from public.trips t
      join public.trip_people p on p.trip_id = t.id join auth.users u on u.id = p.linked_user_id
      where t.title = 'Lissabon 2026 (Demo)' and u.email = 'erwin@dev.travelsplit.local' limit 1`)
    const { trip_id, user_id } = rows[0]
    const ev = await client.query(
      `insert into public.whatsapp_inbound_events (provider_message_id, sender_hash, kind, trip_id, processing_status, reason_code)
       values ($1, repeat('a', 64), 'expense', $2, 'needs_review', 'unknown_person') returning id`,
      [`wamid.e2e.${Date.now()}`, trip_id],
    )
    await client.query(
      `insert into public.whatsapp_review_queue (event_id, trip_id, user_id, reason_code, message_text) values ($1, $2, $3, 'unknown_person', 'Fado 30 EUR Erwin Zora')`,
      [ev.rows[0].id, trip_id, user_id],
    )
  } finally {
    await client.end()
  }

  await login(page)
  await expect(page.getByRole('heading', { name: 'Aktive Reisen' })).toBeVisible()
  await page.getByText('Lissabon 2026 (Demo)').first().click()
  const review = page.getByRole('heading', { name: /WhatsApp-Nachrichten prüfen/ })
  await expect(review).toBeVisible()
  await page.getByRole('button', { name: 'Erfassen' }).first().click()
  await expect(page.getByLabel('Schnellerfassung')).toHaveValue('Fado 30 EUR Erwin Zora')
  await page.getByRole('button', { name: 'Erledigt' }).first().click()
  await expect(review).toBeHidden()
})

test('Reiseleitung setzt einen Reisecode, geteilte Nachricht mit #CODE landet direkt in dieser Reise', async ({ page }) => {
  await login(page)
  await expect(page.getByRole('heading', { name: 'Aktive Reisen' })).toBeVisible()
  await page.getByText('Lissabon 2026 (Demo)').first().click()
  await page.getByRole('link', { name: /Einstellungen/ }).click()
  await page.getByLabel('Reisecode').fill('lis26')
  await page.getByRole('button', { name: 'Speichern' }).nth(1).click()
  await expect(page.getByText('Gespeichert')).toBeVisible()
  await page.goto('/share?text=' + encodeURIComponent('#LIS26 Taxi 12 EUR alle'))
  await expect(page.getByRole('heading', { name: 'Lissabon 2026 (Demo)' })).toBeVisible()
  await expect(page.getByLabel('Schnellerfassung')).toHaveValue('#LIS26 Taxi 12 EUR alle')
})
