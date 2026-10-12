// WA1 test catalogue (WhatsApp spec §8, cases 1–12) with synthetic, signed Meta payloads against the local
// database. No Meta account, number or network access is involved; the handler is the deployed code.
import { createHmac, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRequest, senderHash, type IngestEvent, type WebhookConfig } from '../../supabase/functions/whatsapp-webhook/handler'
import { addExpense, balances, closeDb, createUser, db, equal, rpc, rpcFails, serviceClient, setupTrip, type TestUser } from './helpers'

const config: WebhookConfig = {
  mode: 'sandbox',
  appSecret: 'test-app-secret-not-real',
  verifyToken: 'test-verify-token',
  phoneNumberId: '100200300400',
  idPepper: 'test-pepper-0123456789abcdef0123456789abcdef',
}

const service = serviceClient()
const ingest = async (event: IngestEvent) => {
  const { data, error } = await service.rpc('whatsapp_ingest', { p_event: event })
  if (error) throw new Error(error.message)
  return data
}

function payload(messages: { from: string; id?: string; text?: string; type?: string }[], phoneNumberId = config.phoneNumberId) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '999888777',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '41000000000', phone_number_id: phoneNumberId },
              contacts: messages.map((m) => ({ wa_id: m.from, profile: { name: 'Irgendwer' } })),
              messages: messages.map((m) => ({
                from: m.from,
                id: m.id ?? `wamid.${randomUUID().replaceAll('-', '')}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: m.type ?? 'text',
                ...(m.type && m.type !== 'text' ? { [m.type]: { id: 'media' } } : { text: { body: m.text ?? '' } }),
              })),
            },
          },
        ],
      },
    ],
  }
}

function signed(body: string, secret = config.appSecret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

async function post(body: unknown, opts: { signature?: string | null; raw?: string; cfg?: WebhookConfig } = {}) {
  const raw = opts.raw ?? JSON.stringify(body)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const sig = opts.signature === undefined ? signed(raw) : opts.signature
  if (sig !== null) headers['x-hub-signature-256'] = sig
  return handleRequest(new Request('https://example.invalid/functions/v1/whatsapp-webhook', { method: 'POST', headers, body: raw }), opts.cfg ?? config, ingest)
}

/** Send one text message and return the stored inbox row. */
async function send(from: string, text: string, id = `wamid.${randomUUID().replaceAll('-', '')}`) {
  const res = await post(payload([{ from, id, text }]))
  expect(res.status).toBe(200)
  const { rows } = await db().query(`select * from public.whatsapp_inbound_events where provider_message_id = $1`, [id])
  return { id, event: rows[0] as { processing_status: string; reason_code: string | null; expense_id: string | null; trip_id: string | null } | undefined }
}

const expenseCount = async (tripId: string) =>
  Number((await db().query(`select count(*) from public.expenses where trip_id = $1`, [tripId])).rows[0].count)

async function link(admin: TestUser, personId: string, from: string) {
  const res = await rpc<{ code: string }>(admin.client, 'create_whatsapp_link', { p_person_id: personId })
  const sent = await send(from, res.code)
  return { code: res.code, ...sent }
}

// Random range per run: numbers linked in earlier runs stay linked in the local database.
let phone = 41_700_000_000 + Math.floor(Math.random() * 90_000_000) * 10
const newPhone = () => String(phone++)

beforeAll(async () => {
  await db().query(
    `update private.whatsapp_config set mode = 'sandbox', allowed_phone_number_id = $1, max_events_per_sender_hour = 30, max_events_per_day = 500 where id = 1`,
    [config.phoneNumberId],
  )
})
beforeEach(async () => {
  // Every test starts below the volume limits.
  await db().query(`update public.whatsapp_inbound_events set received_at = received_at - interval '2 days'`)
})
afterAll(async () => {
  await db().query(`update private.whatsapp_config set mode = 'off', allowed_phone_number_id = null where id = 1`)
  await closeDb()
})

describe('WA1-1: Signatur', () => {
  it('fehlende, falsche, mit anderem Schlüssel erstellte oder nach dem Signieren veränderte Nachricht → kein Eintrag', async () => {
    const id = `wamid.${randomUUID()}`
    const body = JSON.stringify(payload([{ from: newPhone(), id, text: 'Taxi 10 EUR alle' }]))
    expect((await post(null, { raw: body, signature: null })).status).toBe(401)
    expect((await post(null, { raw: body, signature: 'sha256=' + '0'.repeat(64) })).status).toBe(401)
    expect((await post(null, { raw: body, signature: signed(body, 'other-secret') })).status).toBe(401)
    expect((await post(null, { raw: body.replace('Taxi 10', 'Taxi 99'), signature: signed(body) })).status).toBe(401)
    expect((await post(null, { raw: body, signature: signed(body).toUpperCase() })).status).toBe(401)
    const { rows } = await db().query(`select 1 from public.whatsapp_inbound_events where provider_message_id = $1`, [id])
    expect(rows).toEqual([])
  })

  it('GET-Challenge nur mit richtigem Verify-Token; Modus off = Route existiert nicht', async () => {
    const get = (q: string, cfg = config) => handleRequest(new Request(`https://example.invalid/?${q}`), cfg, ingest)
    const ok = await get('hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=12345')
    expect([ok.status, await ok.text()]).toEqual([200, '12345'])
    expect((await get('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345')).status).toBe(403)
    expect((await get('hub.mode=unsubscribe&hub.verify_token=test-verify-token&hub.challenge=1')).status).toBe(403)
    expect((await get('hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=1', { ...config, mode: 'off' })).status).toBe(404)
    const body = JSON.stringify(payload([{ from: newPhone(), text: 'Taxi 10 EUR alle' }]))
    expect((await post(null, { raw: body, cfg: { ...config, mode: 'off' } })).status).toBe(404)
  })

  it('Datenbank lehnt ab, solange WHATSAPP_MODE in der Datenbank off ist, und Clients können die Funktion nicht aufrufen', async () => {
    await db().query(`update private.whatsapp_config set mode = 'off' where id = 1`)
    try {
      const { id, event } = await send(newPhone(), 'Taxi 10 EUR alle')
      expect(event).toBeUndefined()
      expect(id).toBeTruthy()
    } finally {
      await db().query(`update private.whatsapp_config set mode = 'sandbox' where id = 1`)
    }
    const user = await createUser('Mallory')
    await rpcFails(user.client, 'whatsapp_ingest', { p_event: {} }, 'whatsapp_ingest')
  })

  it('fremde phone_number_id, Status-Updates und Nicht-Text-Nachrichten legen keine Ausgabe an', async () => {
    const id = `wamid.${randomUUID()}`
    expect((await post(payload([{ from: newPhone(), id, text: 'Taxi 10 EUR alle' }], '555555555'))).status).toBe(200)
    expect((await db().query(`select 1 from public.whatsapp_inbound_events where provider_message_id = $1`, [id])).rows).toEqual([])
    const statusOnly = {
      object: 'whatsapp_business_account',
      entry: [{ id: '1', changes: [{ field: 'messages', value: { metadata: { phone_number_id: config.phoneNumberId }, statuses: [{ id: 'x', status: 'read' }] } }] }],
    }
    expect((await post(statusOnly)).status).toBe(200)
    const img = `wamid.${randomUUID()}`
    await post(payload([{ from: newPhone(), id: img, type: 'image' }]))
    const { rows } = await db().query(`select processing_status, reason_code, expense_id from public.whatsapp_inbound_events where provider_message_id = $1`, [img])
    expect(rows).toEqual([{ processing_status: 'ignored', reason_code: 'unsupported_type', expense_id: null }])
    expect((await post({ object: 'page', entry: [] })).status).toBe(400)
    expect((await post(null, { raw: '{not json' })).status).toBe(400)
  })
})

describe('WA1-2/3: Verbindung', () => {
  let admin: TestUser
  let larissa: TestUser
  let t: Awaited<ReturnType<typeof setupTrip>>
  beforeAll(async () => {
    admin = await createUser('Erwin', { creator: true })
    larissa = await createUser('Larissa')
    t = await setupTrip(admin, [larissa])
  })

  it('nicht eingeladener Absender, falscher, widerrufener, abgelaufener und doppelt benutzter Code → keine Ausgabe', async () => {
    const before = await expenseCount(t.tripId)
    expect((await send(newPhone(), 'Taxi 10 EUR alle')).event).toMatchObject({ processing_status: 'rejected', reason_code: 'unknown_sender' })
    expect((await send(newPhone(), `LINK ${'A'.repeat(32)}`)).event).toMatchObject({ processing_status: 'link_failed', reason_code: 'link_unknown' })

    const first = await rpc<{ code: string }>(admin.client, 'create_whatsapp_link', { p_person_id: t.personIds.Larissa })
    await rpc(admin.client, 'create_whatsapp_link', { p_person_id: t.personIds.Larissa }) // replaces the first one
    expect((await send(newPhone(), first.code)).event).toMatchObject({ processing_status: 'link_failed', reason_code: 'link_used_or_revoked' })

    const expired = await rpc<{ code: string }>(admin.client, 'create_whatsapp_link', { p_person_id: t.personIds.Larissa })
    await db().query(`update public.whatsapp_link_tokens set expires_at = now() - interval '1 minute' where used_at is null and revoked_at is null and person_id = $1`, [t.personIds.Larissa])
    expect((await send(newPhone(), expired.code)).event).toMatchObject({ processing_status: 'link_failed', reason_code: 'link_expired' })

    const nr = newPhone()
    const ok = await link(admin, t.personIds.Larissa, nr)
    expect(ok.event).toMatchObject({ processing_status: 'linked' })
    expect((await send(newPhone(), ok.code)).event).toMatchObject({ processing_status: 'link_failed', reason_code: 'link_used_or_revoked' })
    expect(await expenseCount(t.tripId)).toBe(before)

    // Only the owner and the trip admin see the (masked) connection; the number itself is never stored.
    const { data } = await larissa.client.from('whatsapp_connections').select('wa_id_masked, wa_id_lookup_hash, status')
    expect(data).toEqual([{ wa_id_masked: `••••${nr.slice(-3)}`, wa_id_lookup_hash: await senderHash(nr, config.idPepper), status: 'active' }])
    const { rows } = await db().query(`select count(*) from public.whatsapp_connections where wa_id_lookup_hash like $1 or wa_id_masked like $1`, [`%${nr}%`])
    expect(rows[0].count).toBe('0')
  })

  it('eine bereits verbundene Nummer kann nicht für eine andere Person übernommen werden; Codes nur für Admins und Beigetretene', async () => {
    const nr = newPhone()
    await link(admin, t.personIds.Larissa, nr)
    const res = await link(admin, t.personIds.Erwin, nr)
    expect(res.event).toMatchObject({ processing_status: 'link_failed', reason_code: 'sender_taken' })
    await rpcFails(larissa.client, 'create_whatsapp_link', { p_person_id: t.personIds.Erwin }, 'admin_required')
    const ph = await rpc<string>(admin.client, 'add_trip_person', { p_trip_id: t.tripId, p_display_name: 'Platzhalter' })
    await rpcFails(admin.client, 'create_whatsapp_link', { p_person_id: ph }, 'whatsapp_person_not_joined')
  })

  it('WA1-3: Platzhalter mit alten Buchungen: kein Code vor der Admin-Freigabe des Beitritts, danach richtige Person', async () => {
    const roger = await createUser('Roger')
    const ph = await rpc<string>(admin.client, 'add_trip_person', { p_trip_id: t.tripId, p_display_name: 'Roger' })
    await addExpense(admin, t.tripId, { currency: 'EUR', minor: 1000, participants: equal(t.personIds.Erwin, ph) })
    const inv = await rpc<{ token: string }>(admin.client, 'create_invitation', { p_person_id: ph })
    const claim = await rpc<{ status: string }>(roger.client, 'redeem_invitation', { p_token: inv.token, p_display_name: 'Roger' })
    expect(claim.status).toBe('pending_admin_approval')
    await rpcFails(admin.client, 'create_whatsapp_link', { p_person_id: ph }, 'whatsapp_person_not_joined')

    const { data: claims } = await admin.client.from('membership_claims').select('id').eq('trip_id', t.tripId).eq('status', 'pending_admin_approval')
    await rpc(admin.client, 'decide_claim', { p_claim_id: claims![0].id, p_approve: true })
    const nr = newPhone()
    expect((await link(admin, ph, nr)).event).toMatchObject({ processing_status: 'linked' })
    const booked = await send(nr, 'Glace 9 EUR Roger Erwin')
    expect(booked.event).toMatchObject({ processing_status: 'booked' })
    const { rows } = await db().query(`select created_by, paid_by_person_id, source from public.expenses where id = $1`, [booked.event!.expense_id])
    expect(rows[0]).toEqual({ created_by: roger.id, paid_by_person_id: ph, source: 'whatsapp' })
  })
})

describe('WA1-4..12: Buchung', () => {
  let admin: TestUser
  let larissa: TestUser
  let t: Awaited<ReturnType<typeof setupTrip>>
  let larissaPhone: string
  beforeAll(async () => {
    admin = await createUser('Erwin', { creator: true })
    larissa = await createUser('Larissa')
    t = await setupTrip(admin, [larissa])
    await rpc(admin.client, 'set_fx_rate', { p_trip_id: t.tripId, p_currency: 'GEL', p_eur_per_unit: '0.34' })
    larissaPhone = newPhone()
    await link(admin, t.personIds.Larissa, larissaPhone)
  })

  it('WA1-4: «Taxi 100 GEL alle» → genau eine Ausgabe mit Originalbetrag, eigenem Zahler und gleichen Teilen', async () => {
    const res = await send(larissaPhone, 'Taxi 100 GEL alle')
    expect(res.event).toMatchObject({ processing_status: 'booked', trip_id: t.tripId })
    const { data: exp } = await larissa.client.from('expenses').select('*').eq('id', res.event!.expense_id!).single()
    expect(exp).toMatchObject({ title: 'Taxi', currency: 'GEL', original_minor: 10000, split_mode: 'equal', source: 'whatsapp', paid_by_person_id: t.personIds.Larissa, created_by: larissa.id, admin_reconstruction: false })
    const { data: splits } = await larissa.client.from('expense_splits').select('person_id, original_minor').eq('expense_id', exp!.id).order('original_minor')
    expect(splits!.map((s) => s.original_minor)).toEqual([5000, 5000])
    // 100 GEL × 0,34 = 34,00 EUR; Larissa paid, so she gets 17,00 back.
    expect(await balances(larissa, t.tripId)).toEqual({ [t.personIds.Erwin]: -1700n, [t.personIds.Larissa]: 1700n })
    const { data: audit } = await admin.client.from('audit_events').select('new_values').eq('entity_id', exp!.id).single()
    expect(audit!.new_values).toMatchObject({ source: 'whatsapp', participants: [t.personIds.Erwin, t.personIds.Larissa] })
  })

  it('WA1-4: Namen und Prozente', async () => {
    const names = await send(larissaPhone, 'Essen 85 EUR erwin')
    const { data: s1 } = await admin.client.from('expense_splits').select('person_id, original_minor').eq('expense_id', names.event!.expense_id!)
    expect(s1).toEqual([{ person_id: t.personIds.Erwin, original_minor: 8500 }])
    const pct = await send(larissaPhone, 'Hotel 200 EUR 25% Erwin 75% Larissa')
    const { data: s2 } = await admin.client.from('expense_splits').select('person_id, original_minor').eq('expense_id', pct.event!.expense_id!).order('original_minor')
    expect(s2).toEqual([{ person_id: t.personIds.Erwin, original_minor: 5000 }, { person_id: t.personIds.Larissa, original_minor: 15000 }])
  })

  it('WA1-5: zwei Reisen ohne Code → nur Reisewahl offen, kein Saldo; mit Code genau in einer Reise', async () => {
    const t2 = await setupTrip(admin, [larissa])
    await link(admin, t2.personIds.Larissa, larissaPhone)
    const before = [await balances(admin, t.tripId), await balances(admin, t2.tripId)]
    const open = await send(larissaPhone, 'Bus 4 EUR alle')
    expect(open.event).toMatchObject({ processing_status: 'needs_trip_selection', expense_id: null, trip_id: null })
    expect([await balances(admin, t.tripId), await balances(admin, t2.tripId)]).toEqual(before)
    const { data: review } = await larissa.client.from('whatsapp_review_queue').select('reason_code, trip_id, message_text, status').eq('event_id', (await eventId(open.id)))
    expect(review).toEqual([{ reason_code: 'needs_trip_selection', trip_id: null, message_text: 'Bus 4 EUR alle', status: 'needs_review' }])
    // The trip admin of neither trip sees a trip-less item of someone else.
    expect((await admin.client.from('whatsapp_review_queue').select('id').eq('event_id', await eventId(open.id))).data).toEqual([])

    await rpc(admin.client, 'set_trip_code', { p_trip_id: t2.tripId, p_code: 'geo27' })
    const coded = await send(larissaPhone, '#GEO27 Bus 4 EUR alle')
    expect(coded.event).toMatchObject({ processing_status: 'booked', trip_id: t2.tripId })
    expect(await balances(admin, t.tripId)).toEqual(before[0])
    // A code of a trip the sender is not connected to gives nothing.
    expect((await send(larissaPhone, '#XYZ99 Bus 4 EUR alle')).event).toMatchObject({ processing_status: 'needs_trip_selection' })
    await rpc(larissa.client, 'revoke_whatsapp_connection', {
      p_connection_id: (await larissa.client.from('whatsapp_connections').select('id').eq('trip_id', t2.tripId).eq('status', 'active').single()).data!.id,
    })
  })

  it('WA1-6: derselbe wamid zweimal, auch nach verlorener Antwort → genau eine Ausgabe', async () => {
    const id = `wamid.${randomUUID()}`
    const before = await expenseCount(t.tripId)
    const body = payload([{ from: larissaPhone, id, text: 'Metro 3 EUR alle' }])
    await post(body)
    await post(body)
    // Lost response after commit: the same message arrives in a new delivery with another message next to it.
    await post(payload([{ from: larissaPhone, id, text: 'Metro 3 EUR alle' }, { from: larissaPhone, text: 'Kaffee 2 EUR alle' }]))
    // Concurrent duplicates.
    await Promise.all([post(body), post(body), post(body)])
    expect(await expenseCount(t.tripId)).toBe(before + 2)
    const { rows } = await db().query(`select count(*) from public.expenses where trip_id = $1 and title = 'Metro'`, [t.tripId])
    expect(rows[0].count).toBe('1')
  })

  it('WA1-7: unklare Nachrichten werden nie gebucht, sondern landen als Prüffall', async () => {
    const before = await balances(admin, t.tripId)
    const cases: [string, string][] = [
      ['Taxi 10/100 GEL alle', 'ambiguous_amount'],
      ['Taxi 100 oder 150 GEL alle', 'ambiguous_amount'],
      ['Taxi 100 alle', 'missing_currency'],
      ['Taxi 100 XYZ alle', 'unknown_currency'],
      ['Taxi 100 GEL Erwin Erwin', 'duplicate_participant'],
      ['Taxi 100 GEL Zora', 'unknown_person'],
      ['Taxi 100 GEL', 'participants_missing'],
      ['Hotel 100 EUR 50% Erwin 40% Larissa', 'percent_sum_mismatch'],
      ['Taxi 0 EUR alle', 'invalid_amount'],
      ['Taxi 100 CHF alle', 'fx_rate_missing'],
      ['Erwin hat für alle bezahlt 30 EUR', 'payer_in_text'],
      ['Paid by someone else 30 EUR all', 'payer_in_text'],
    ]
    for (const [text, reason] of cases) {
      const res = await send(larissaPhone, text)
      expect([text, res.event?.processing_status, res.event?.expense_id]).toEqual([text, 'needs_review', null])
      expect([text, res.event?.reason_code]).toEqual([text, expect.stringMatching(new RegExp(reason === 'fx_rate_missing' ? 'rate' : reason))])
    }
    expect(await balances(admin, t.tripId)).toEqual(before)
    const { data } = await admin.client.from('whatsapp_review_queue').select('id').eq('trip_id', t.tripId).eq('status', 'needs_review')
    expect(data!.length).toBeGreaterThanOrEqual(cases.length)
  })

  it('WA1-8: per WhatsApp kein fremder Zahler, keine Kurse, keine Rückzahlungen, keine Admin-Aktionen', async () => {
    // The service has exactly one entry point; the payer is always the sender's own person.
    const { rows } = await db().query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('service_role', p.oid, 'execute') and p.proname like '%whatsapp%'`)
    expect(rows.map((r) => r.proname).sort()).toEqual(['create_whatsapp_link', 'resolve_whatsapp_review', 'revoke_whatsapp_connection', 'whatsapp_ingest'])
    const res = await send(larissaPhone, 'Erwin 30 EUR alle')
    const { data } = await admin.client.from('expenses').select('paid_by_person_id, admin_reconstruction').eq('id', res.event!.expense_id!).single()
    expect(data).toEqual({ paid_by_person_id: t.personIds.Larissa, admin_reconstruction: false })
    // Even a forged event cannot make the service book for someone else.
    await expect(
      db().query(`select private.create_expense_as($1, 'whatsapp', $2, gen_random_uuid(), 'x', current_date, 'EUR', 100, 'equal', $3, $4, null, null, false)`, [
        larissa.id, t.tripId, JSON.stringify(equal(t.personIds.Larissa)), t.personIds.Erwin,
      ]),
    ).rejects.toThrow('payer_not_allowed')
  })

  it('WA1-9: archivierte Reise, gesperrte oder entfernte Person, widerrufene Verbindung → keine Ausgabe', async () => {
    const roger = await createUser('Roger')
    const t3 = await setupTrip(admin, [roger])
    const nr = newPhone()
    await link(admin, t3.personIds.Roger, nr)
    expect((await send(nr, 'Brot 3 EUR alle')).event).toMatchObject({ processing_status: 'booked' })

    const conn = (await admin.client.from('whatsapp_connections').select('id').eq('trip_id', t3.tripId).eq('status', 'active').single()).data!
    await rpc(admin.client, 'revoke_whatsapp_connection', { p_connection_id: conn.id })
    expect((await send(nr, 'Brot 3 EUR alle')).event).toMatchObject({ processing_status: 'rejected', reason_code: 'unknown_sender' })
    // Blocked by the admin: the same number cannot simply be linked again in this trip.
    expect((await link(admin, t3.personIds.Roger, nr)).event).toMatchObject({ processing_status: 'link_failed', reason_code: 'sender_blocked' })

    const nr2 = newPhone()
    await link(admin, t3.personIds.Roger, nr2)
    await db().query(`update public.trip_people set status = 'removed' where id = $1`, [t3.personIds.Roger])
    expect((await send(nr2, 'Brot 3 EUR alle')).event).toMatchObject({ processing_status: 'rejected', reason_code: 'unknown_sender' })
    await db().query(`update public.trip_people set status = 'active' where id = $1`, [t3.personIds.Roger])

    await rpc(admin.client, 'archive_trip', { p_trip_id: t3.tripId, p_accept_open_balances: true })
    expect((await send(nr2, 'Brot 3 EUR alle')).event).toMatchObject({ processing_status: 'rejected', reason_code: 'unknown_sender' })
    expect(await expenseCount(t3.tripId)).toBe(1)
  })

  it('WA1-10: Kursänderung bewertet WhatsApp-Ausgaben neu, bestätigte Rückzahlung bleibt eingefroren', async () => {
    const roger = await createUser('Roger')
    const t4 = await setupTrip(admin, [roger])
    await rpc(admin.client, 'set_fx_rate', { p_trip_id: t4.tripId, p_currency: 'GEL', p_eur_per_unit: '0.34' })
    const nr = newPhone()
    await link(admin, t4.personIds.Roger, nr)
    await send(nr, 'Taxi 100 GEL alle')
    expect(await balances(admin, t4.tripId)).toEqual({ [t4.personIds.Erwin]: -1700n, [t4.personIds.Roger]: 1700n })
    const sid = await rpc<string>(admin.client, 'report_settlement', {
      p_trip_id: t4.tripId, p_idempotency_key: randomUUID(), p_receiver_person_id: t4.personIds.Roger, p_currency: 'EUR', p_original_minor: '1700',
    })
    await rpc(roger.client, 'confirm_settlement', { p_settlement_id: sid })
    await rpc(admin.client, 'set_fx_rate', { p_trip_id: t4.tripId, p_currency: 'GEL', p_eur_per_unit: '0.40', p_expected_revision: 1 })
    // 100 GEL now 40,00 EUR → share 20,00; the confirmed 17,00 stays.
    expect(await balances(admin, t4.tripId)).toEqual({ [t4.personIds.Erwin]: -300n, [t4.personIds.Roger]: 300n })
  })

  it('WA1-11: WhatsApp-Ausgabe bleibt in der App sichtbar und änderbar, auch nach dem Abschalten', async () => {
    const res = await send(larissaPhone, 'Museum 24 EUR alle')
    await db().query(`update private.whatsapp_config set mode = 'off' where id = 1`)
    try {
      const { data: exp } = await larissa.client.from('expenses').select('id, revision, source').eq('id', res.event!.expense_id!).single()
      expect(exp!.source).toBe('whatsapp')
      await rpc(larissa.client, 'update_expense', {
        p_expense_id: exp!.id, p_expected_revision: exp!.revision, p_title: 'Museum Gulbenkian', p_expense_date: '2026-10-02', p_currency: 'EUR',
        p_original_minor: '2400', p_split_mode: 'equal', p_participants: equal(t.personIds.Erwin, t.personIds.Larissa),
        p_paid_by_person_id: null, p_category: 'activities', p_note: null, p_reason: 'Name ergänzt',
      })
      const { data: after } = await admin.client.from('expenses').select('title, revision, source').eq('id', exp!.id).single()
      expect(after).toEqual({ title: 'Museum Gulbenkian', revision: 2, source: 'whatsapp' })
    } finally {
      await db().query(`update private.whatsapp_config set mode = 'sandbox' where id = 1`)
    }
  })

  it('WA1-12: kein Versand an WhatsApp möglich; Mengenlimits greifen fail-closed', async () => {
    // The handler itself makes no network call at all (the database call is the injected ingest).
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const seen: IngestEvent[] = []
    const raw = JSON.stringify(payload([{ from: larissaPhone, text: 'Wasser 1 EUR alle' }]))
    const res = await handleRequest(
      new Request('https://example.invalid/', { method: 'POST', headers: { 'x-hub-signature-256': signed(raw) }, body: raw }),
      config,
      async (e) => void seen.push(e),
    )
    expect([res.status, seen.length]).toEqual([200, 1])
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    // The raw phone number never leaves the handler.
    expect(JSON.stringify(seen)).not.toContain(larissaPhone)
    await expect(db().query(`update private.whatsapp_config set outbound_enabled = true where id = 1`)).rejects.toThrow('check')

    await db().query(`update private.whatsapp_config set max_events_per_sender_hour = 2 where id = 1`)
    try {
      await db().query(`update public.whatsapp_inbound_events set received_at = received_at - interval '2 days'`)
      const results = []
      for (let i = 0; i < 4; i++) results.push((await send(larissaPhone, 'Wasser 1 EUR alle')).event!.processing_status)
      expect(results).toEqual(['booked', 'booked', 'rejected', 'rejected'])
    } finally {
      await db().query(`update private.whatsapp_config set max_events_per_sender_hour = 30 where id = 1`)
    }
  })

  it('Prüffall erledigen oder verwerfen löscht den gespeicherten Text', async () => {
    const res = await send(larissaPhone, 'Taxi 100 GEL Zora')
    const { data: item } = await larissa.client.from('whatsapp_review_queue').select('id').eq('event_id', await eventId(res.id)).single()
    await rpcFails(createdOutsider, 'resolve_whatsapp_review', { p_review_id: item!.id, p_status: 'done' }, 'not_found')
    await rpc(admin.client, 'resolve_whatsapp_review', { p_review_id: item!.id, p_status: 'dismissed' })
    const { data } = await larissa.client.from('whatsapp_review_queue').select('status, message_text').eq('id', item!.id).single()
    expect(data).toEqual({ status: 'dismissed', message_text: null })
  })
})

describe('Aufbewahrung', () => {
  it('alte Nachrichtentexte werden auch bei ausgeschaltetem Modus gelöscht; der Betreiber kann jederzeit aufräumen', async () => {
    const admin = await createUser('Erwin', { creator: true })
    const t = await setupTrip(admin, [])
    const ev = await db().query(
      `insert into public.whatsapp_inbound_events (provider_message_id, sender_hash, kind, processing_status) values ($1, repeat('b', 64), 'expense', 'needs_review') returning id`,
      [`wamid.old.${randomUUID()}`],
    )
    const item = await db().query(
      `insert into public.whatsapp_review_queue (event_id, trip_id, user_id, reason_code, message_text, created_at)
       values ($1, $2, $3, 'unknown_person', 'Taxi 5 EUR Zora', now() - interval '31 days') returning id`,
      [ev.rows[0].id, t.tripId, admin.id],
    )
    await db().query(`update private.whatsapp_config set mode = 'off' where id = 1`)
    try {
      await send(newPhone(), 'Taxi 10 EUR alle')
    } finally {
      await db().query(`update private.whatsapp_config set mode = 'sandbox' where id = 1`)
    }
    const { rows } = await db().query(`select message_text from public.whatsapp_review_queue where id = $1`, [item.rows[0].id])
    expect(rows[0].message_text).toBeNull()
    const purged = await db().query(`select private.operator_purge_whatsapp_texts() as n`)
    expect(purged.rows[0].n).toBeGreaterThanOrEqual(0)
  })
})

let createdOutsider: TestUser['client']
beforeAll(async () => {
  createdOutsider = (await createUser('Mallory')).client
})

async function eventId(providerMessageId: string): Promise<string> {
  const { rows } = await db().query(`select id from public.whatsapp_inbound_events where provider_message_id = $1`, [providerMessageId])
  return rows[0].id
}
