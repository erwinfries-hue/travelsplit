// Attack tests against the REST/RPC API exactly as a malicious client would call it (Auftrag §6, §12).
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addExpense,
  anonClient,
  balances,
  closeDb,
  createGuest,
  createUser,
  db,
  equal,
  rpc,
  rpcFails,
  setupTrip,
  type TestUser,
  type TripSetup,
} from './helpers'

let ef: TestUser
let lg: TestUser
let ro: TestUser
let mallory: TestUser
let tripA: TripSetup
let tripB: TripSetup

const TRIP_TABLES = [
  'trips',
  'trip_people',
  'trip_fx_rates',
  'expenses',
  'expense_splits',
  'expense_revisions',
  'settlements',
  'settlement_reversals',
  'trip_closures',
  'receipt_files',
  'audit_events',
  'trip_invitations',
  'membership_claims',
] as const

beforeAll(async () => {
  ef = await createUser('Erwin', { creator: true })
  lg = await createUser('Larissa', { google: true })
  ro = await createUser('Roger')
  mallory = await createUser('Mallory', { google: true })
  tripA = await setupTrip(ef, [lg])
  tripB = await setupTrip(ef, [ro])
  await addExpense(ef, tripA.tripId, { currency: 'EUR', minor: 1000, participants: equal(tripA.personIds.Larissa) })
  await addExpense(ef, tripB.tripId, { currency: 'EUR', minor: 2000, participants: equal(tripB.personIds.Roger) })
})
afterAll(closeDb)

describe('SEC-01 / SEC-02: Isolation zwischen Reisen', () => {
  it('Nicht-Mitglied sieht in keiner Tabelle Daten von Reise A', async () => {
    for (const table of TRIP_TABLES) {
      const column = table === 'trips' ? 'id' : 'trip_id'
      const { data, error } = await mallory.client.from(table).select('*').eq(column, tripA.tripId)
      expect(error, table).toBeNull()
      expect(data, table).toEqual([])
    }
    await rpcFails(mallory.client, 'trip_balances', { p_trip_id: tripA.tripId }, 'trip_not_found')
    await rpcFails(mallory.client, 'expense_base_shares', { p_trip_id: tripA.tripId }, 'trip_not_found')
  })

  it('Unangemeldete Besucher sehen nichts und dürfen keine RPC aufrufen', async () => {
    const anon = anonClient()
    for (const table of TRIP_TABLES) {
      const { data } = await anon.from(table).select('*')
      expect(data ?? [], table).toEqual([])
    }
    const { error } = await anon.rpc('trip_balances', { p_trip_id: tripA.tripId })
    expect(error).not.toBeNull()
  })

  it('Mitglied von Reise B kann Reise A weder lesen noch beschreiben (trip_id manipuliert)', async () => {
    const { data } = await ro.client.from('expenses').select('id').eq('trip_id', tripA.tripId)
    expect(data).toEqual([])
    await expect(
      addExpense(ro, tripA.tripId, { currency: 'EUR', minor: 100, participants: equal(tripA.personIds.Larissa) }),
    ).rejects.toThrow('trip_not_found')
    // Participant of trip A smuggled into an expense of trip B.
    await expect(
      addExpense(ro, tripB.tripId, { currency: 'EUR', minor: 100, participants: equal(tripA.personIds.Larissa) }),
    ).rejects.toThrow('invalid_participant')
  })

  it('Direkte Tabellen-Schreibzugriffe sind für alle Rollen gesperrt', async () => {
    const attempts = [
      ef.client.from('expenses').insert({ trip_id: tripA.tripId }),
      ef.client.from('expenses').update({ original_minor: 1 }).eq('trip_id', tripA.tripId),
      ef.client.from('settlements').update({ status: 'confirmed' }).eq('trip_id', tripA.tripId),
      ef.client.from('trips').update({ admin_user_id: mallory.id }).eq('id', tripA.tripId),
      ef.client.from('audit_events').delete().eq('trip_id', tripA.tripId),
      mallory.client.from('trip_people').insert({ trip_id: tripA.tripId, display_name: 'x', linked_user_id: mallory.id, status: 'active' }),
    ]
    for (const attempt of attempts) {
      const { error } = await attempt
      expect(error?.message).toMatch(/permission denied/)
    }
  })
})

describe('SEC-03: Reise erstellen nur mit freigeschaltetem Google-Konto', () => {
  const args = { p_title: 'X', p_base_currency: 'EUR', p_admin_display_name: 'X' }
  it('Google ohne Freigabe, Passwort-Konto ohne Google und Gast werden abgelehnt', async () => {
    await rpcFails(lg.client, 'create_trip', args, 'creator_not_allowed')
    await rpcFails(ro.client, 'create_trip', args, 'creator_not_allowed')
    const guest = await createGuest('Gast')
    await rpcFails(guest.client, 'create_trip', args, 'creator_not_allowed')
  })

  it('E-Mail in bearbeitbaren User-Metadaten gilt nicht als Freigabe', async () => {
    await mallory.client.auth.updateUser({ data: { email: ef.email, role: 'admin', is_creator: true } })
    await mallory.client.auth.refreshSession()
    await rpcFails(mallory.client, 'create_trip', args, 'creator_not_allowed')
  })

  it('Widerruf der Freigabe wirkt sofort, bestehende Mitgliedschaften bleiben', async () => {
    const temp = await createUser('Temp', { creator: true })
    const trip = await rpc<string>(temp.client, 'create_trip', args)
    await db().query(`select private.operator_revoke_creator($1)`, [temp.email])
    await rpcFails(temp.client, 'create_trip', args, 'creator_not_allowed')
    const { data } = await temp.client.from('trips').select('id').eq('id', trip)
    expect(data).toHaveLength(1)
  })
})

describe('SEC-04 / SEC-05: Zahler (R2)', () => {
  it('Normalmitglied kann keinen fremden Zahler setzen', async () => {
    await expect(
      addExpense(lg, tripA.tripId, {
        currency: 'EUR',
        minor: 500,
        participants: equal(tripA.personIds.Larissa),
        paidBy: tripA.personIds.Erwin,
      }),
    ).rejects.toThrow('payer_not_allowed')
  })

  it('Normalmitglied kann den Zahler beim Ändern nicht umschreiben', async () => {
    const id = await addExpense(lg, tripA.tripId, { currency: 'EUR', minor: 500, participants: equal(tripA.personIds.Erwin) })
    await rpcFails(
      lg.client,
      'update_expense',
      {
        p_expense_id: id,
        p_expected_revision: 1,
        p_title: 'x',
        p_expense_date: '2026-10-01',
        p_currency: 'EUR',
        p_original_minor: '500',
        p_split_mode: 'equal',
        p_participants: equal(tripA.personIds.Erwin),
        p_paid_by_person_id: tripA.personIds.Erwin,
      },
      'payer_not_allowed',
    )
  })

  it('Admin-Rekonstruktion für Platzhalter ist markiert und auditiert', async () => {
    const placeholder = await rpc<string>(ef.client, 'add_trip_person', { p_trip_id: tripA.tripId, p_display_name: 'Barbara' })
    const id = await addExpense(ef, tripA.tripId, {
      currency: 'EUR',
      minor: 4000,
      participants: equal(tripA.personIds.Erwin, placeholder),
      paidBy: placeholder,
    })
    const { data } = await lg.client.from('expenses').select('admin_reconstruction, paid_by_person_id').eq('id', id).single()
    expect(data).toEqual({ admin_reconstruction: true, paid_by_person_id: placeholder })
    const { data: audit } = await lg.client.from('audit_events').select('action').eq('entity_id', id)
    expect(audit!.map((a) => a.action)).toEqual(['expense.created_admin_reconstruction'])
  })

  it('Fremdes Mitglied darf fremde Ausgabe nicht ändern oder löschen', async () => {
    const id = await addExpense(ef, tripA.tripId, { currency: 'EUR', minor: 700, participants: equal(tripA.personIds.Erwin) })
    await rpcFails(lg.client, 'delete_expense', { p_expense_id: id, p_expected_revision: 1 }, 'not_allowed')
  })
})

describe('SEC-06 / SEC-07: Einladungen und Claims (R3)', () => {
  it('Weitergeleiteter Link zu bebuchtem Platzhalter: kein Zugriff bis Admin-Freigabe', async () => {
    const t = await setupTrip(ef, [])
    const ph = await rpc<string>(ef.client, 'add_trip_person', { p_trip_id: t.tripId, p_display_name: 'Larissa' })
    await addExpense(ef, t.tripId, { currency: 'EUR', minor: 900, participants: equal(ph), paidBy: t.personIds.Erwin })
    const inv = await rpc<{ token: string }>(ef.client, 'create_invitation', { p_person_id: ph })

    // The link reaches the wrong person.
    const res = await rpc<{ status: string }>(mallory.client, 'redeem_invitation', { p_token: inv.token, p_display_name: 'Larissa' })
    expect(res.status).toBe('pending_admin_approval')
    const { data } = await mallory.client.from('expenses').select('id').eq('trip_id', t.tripId)
    expect(data).toEqual([])
    await rpcFails(mallory.client, 'trip_balances', { p_trip_id: t.tripId }, 'trip_not_found')
    await expect(addExpense(mallory, t.tripId, { currency: 'EUR', minor: 1, participants: equal(ph) })).rejects.toThrow(
      'trip_not_found',
    )

    // Admin checks identity outside the app and rejects; then re-invites the real person.
    const { data: claims } = await ef.client.from('membership_claims').select('id').eq('trip_id', t.tripId)
    await rpcFails(mallory.client, 'decide_claim', { p_claim_id: claims![0].id, p_approve: true }, 'trip_not_found')
    await rpc(ef.client, 'decide_claim', { p_claim_id: claims![0].id, p_approve: false })
    const { data: still } = await mallory.client.from('expenses').select('id').eq('trip_id', t.tripId)
    expect(still).toEqual([])

    const inv2 = await rpc<{ token: string }>(ef.client, 'create_invitation', { p_person_id: ph })
    await rpc(lg.client, 'redeem_invitation', { p_token: inv2.token, p_display_name: 'Larissa' })
    const { data: claims2 } = await ef.client.from('membership_claims').select('id, status').eq('trip_id', t.tripId)
    const open = claims2!.find((c) => c.status === 'pending_admin_approval')!
    await rpc(ef.client, 'decide_claim', { p_claim_id: open.id, p_approve: true })
    expect((await balances(lg, t.tripId))[ph]).toBe(-900n)
  })

  it('Einladung zweimal, abgelaufen, widerrufen, gefälscht → abgelehnt', async () => {
    const t = await setupTrip(ef, [])
    const p1 = await rpc<string>(ef.client, 'add_trip_person', { p_trip_id: t.tripId, p_display_name: 'A' })
    const inv = await rpc<{ token: string }>(ef.client, 'create_invitation', { p_person_id: p1 })
    // Two parallel redemptions of the same link: exactly one wins.
    const g1 = await createGuest('G1')
    const g2 = await createGuest('G2')
    const results = await Promise.allSettled([
      rpc(g1.client, 'redeem_invitation', { p_token: inv.token, p_display_name: 'A' }),
      rpc(g2.client, 'redeem_invitation', { p_token: inv.token, p_display_name: 'A' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)

    const p2 = await rpc<string>(ef.client, 'add_trip_person', { p_trip_id: t.tripId, p_display_name: 'B' })
    const expired = await rpc<{ token: string; invitation_id: string }>(ef.client, 'create_invitation', { p_person_id: p2 })
    await db().query(`update public.trip_invitations set expires_at = now() - interval '1 minute' where id = $1`, [
      expired.invitation_id,
    ])
    await rpcFails(mallory.client, 'redeem_invitation', { p_token: expired.token, p_display_name: 'B' }, 'invitation_expired')

    const revoked = await rpc<{ token: string; invitation_id: string }>(ef.client, 'create_invitation', { p_person_id: p2 })
    await rpc(ef.client, 'revoke_invitation', { p_invitation_id: revoked.invitation_id })
    await rpcFails(mallory.client, 'redeem_invitation', { p_token: revoked.token, p_display_name: 'B' }, 'invitation_revoked')

    await rpcFails(mallory.client, 'redeem_invitation', { p_token: 'A'.repeat(43), p_display_name: 'B' }, 'invitation_invalid')

    // Only the hash is stored, never the token.
    const { rows } = await db().query(`select token_hash from public.trip_invitations where id = $1`, [revoked.invitation_id])
    expect(Buffer.from(rows[0].token_hash).toString('utf8')).not.toContain(revoked.token)
  })

  it('Nur der Admin erstellt Einladungen und Platzhalter', async () => {
    await rpcFails(lg.client, 'add_trip_person', { p_trip_id: tripA.tripId, p_display_name: 'X' }, 'admin_required')
    await rpcFails(lg.client, 'create_invitation', { p_person_id: tripA.personIds.Larissa }, 'admin_required')
  })
})

describe('SEC-10 / SEC-11: Zahlungsbestätigung', () => {
  it('Nicht-Empfänger (auch Admin) kann fremde Zahlung nicht bestätigen', async () => {
    const t = await setupTrip(ef, [lg, ro])
    await addExpense(lg, t.tripId, { currency: 'EUR', minor: 6000, participants: equal(t.personIds.Roger) })
    const sid = await rpc<string>(ro.client, 'report_settlement', {
      p_trip_id: t.tripId,
      p_idempotency_key: randomUUID(),
      p_receiver_person_id: t.personIds.Larissa,
      p_currency: 'EUR',
      p_original_minor: '6000',
    })
    await rpcFails(ef.client, 'confirm_settlement', { p_settlement_id: sid }, 'only_receiver_can_confirm')
    await rpcFails(ro.client, 'confirm_settlement', { p_settlement_id: sid }, 'only_receiver_can_confirm')
    await rpcFails(mallory.client, 'confirm_settlement', { p_settlement_id: sid }, 'trip_not_found')
    expect((await balances(ef, t.tripId))[t.personIds.Roger]).toBe(-6000n)
  })

  it('Zahlung an Platzhalter oder an sich selbst ist ungültig', async () => {
    const t = await setupTrip(ef, [lg])
    const ph = await rpc<string>(ef.client, 'add_trip_person', { p_trip_id: t.tripId, p_display_name: 'P' })
    const base = { p_trip_id: t.tripId, p_currency: 'EUR', p_original_minor: '100' }
    await rpcFails(lg.client, 'report_settlement', { ...base, p_idempotency_key: randomUUID(), p_receiver_person_id: ph }, 'invalid_receiver')
    await rpcFails(
      lg.client,
      'report_settlement',
      { ...base, p_idempotency_key: randomUUID(), p_receiver_person_id: t.personIds.Larissa },
      'settlement_to_self',
    )
  })
})

describe('SEC-14: Admin-Übergabe', () => {
  it('Parallele Übergaben ergeben immer genau einen Admin; Gast kann nicht Admin werden', async () => {
    const t = await setupTrip(ef, [lg, mallory])
    const guest = await createGuest('Gast')
    const ph = await rpc<string>(ef.client, 'add_trip_person', { p_trip_id: t.tripId, p_display_name: 'Gast' })
    const inv = await rpc<{ token: string }>(ef.client, 'create_invitation', { p_person_id: ph })
    await rpc(guest.client, 'redeem_invitation', { p_token: inv.token, p_display_name: 'Gast' })
    await rpcFails(ef.client, 'transfer_admin', { p_trip_id: t.tripId, p_new_admin_person_id: ph }, 'admin_requires_google')

    const results = await Promise.allSettled([
      rpc(ef.client, 'transfer_admin', { p_trip_id: t.tripId, p_new_admin_person_id: t.personIds.Larissa }),
      rpc(ef.client, 'transfer_admin', { p_trip_id: t.tripId, p_new_admin_person_id: t.personIds.Mallory }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const { data } = await lg.client.from('trips').select('admin_user_id').eq('id', t.tripId).single()
    expect([lg.id, mallory.id]).toContain(data!.admin_user_id)
    // Self-appointment is impossible.
    await rpcFails(ro.client, 'transfer_admin', { p_trip_id: t.tripId, p_new_admin_person_id: t.personIds.Erwin }, 'trip_not_found')
  })
})

describe('SEC-16: Jede Tabelle hat RLS, keine Tabelle ist für anon/authenticated beschreibbar', () => {
  it('Katalogprüfung', async () => {
    const { rows: noRls } = await db().query(`
      select n.nspname || '.' || c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('public', 'private') and not c.relrowsecurity`)
    expect(noRls).toEqual([])
    const { rows: writable } = await db().query(`
      select table_schema || '.' || table_name || ':' || grantee || ':' || privilege_type as grant
      from information_schema.role_table_grants
      where table_schema in ('public', 'private') and grantee in ('anon', 'authenticated')
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`)
    expect(writable).toEqual([])
    const { rows: anonFns } = await db().query(`
      select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')
        and p.proname not in ('currency_exponent')`)
    expect(anonFns).toEqual([])
    const { rows: definerNoPath } = await db().query(`
      select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and p.prosecdef
        and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')`)
    expect(definerNoPath).toEqual([])
  })
})

describe('Audit ist unveränderlich', () => {
  it('Auch der Datenbank-Owner kann Audit-Einträge nicht ändern', async () => {
    await expect(db().query(`update public.audit_events set action = 'x' where trip_id = $1`, [tripA.tripId])).rejects.toThrow(
      'append-only',
    )
    await expect(db().query(`delete from public.audit_events where trip_id = $1`, [tripA.tripId])).rejects.toThrow('append-only')
  })
})
