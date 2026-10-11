// Ledger behaviour through the real database RPCs (DATA-01/02/03/05, SEC-11/12, R1).
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  addExpense,
  balances,
  closeDb,
  createUser,
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

beforeAll(async () => {
  ef = await createUser('Erwin', { creator: true })
  lg = await createUser('Larissa', { google: true })
  ro = await createUser('Roger')
})
afterAll(closeDb)

describe('Pflichtbeispiele über die Datenbank', () => {
  let t: TripSetup
  beforeAll(async () => {
    t = await setupTrip(ef, [lg, ro])
  })

  it('100 EUR auf drei Personen → Summe exakt, Salden summieren 0', async () => {
    const id = await addExpense(ef, t.tripId, {
      currency: 'EUR',
      minor: 10000,
      participants: equal(t.personIds.Erwin, t.personIds.Larissa, t.personIds.Roger),
    })
    const { data: splits } = await ef.client.from('expense_splits').select('person_id, original_minor').eq('expense_id', id)
    const amounts = splits!.map((s) => s.original_minor).sort()
    expect(amounts).toEqual([3333, 3333, 3334])
    const b = await balances(lg, t.tripId)
    expect(Object.values(b).reduce((a, x) => a + x, 0n)).toBe(0n)
    // The extra cent goes to the smallest person id (stable tie-break).
    const erwinShare = splits!.find((s) => s.person_id === t.personIds.Erwin)!.original_minor
    const smallest = [t.personIds.Erwin, t.personIds.Larissa, t.personIds.Roger].sort()[0]
    expect(erwinShare).toBe(smallest === t.personIds.Erwin ? 3334 : 3333)
    expect(b[t.personIds.Erwin]).toBe(10000n - BigInt(erwinShare))
  })
})

describe('R1: Kursänderung bewertet Ausgaben neu, bestätigte Zahlungen bleiben fix', () => {
  let t: TripSetup
  beforeAll(async () => {
    t = await setupTrip(ef, [lg])
  })

  it('Fehlender Kurs → Buchung abgelehnt', async () => {
    await expect(
      addExpense(ef, t.tripId, { currency: 'CHF', minor: 10000, participants: equal(t.personIds.Erwin, t.personIds.Larissa) }),
    ).rejects.toThrow('missing_fx_rate')
  })

  it('100 CHF 50/50 bei 1,10 → ±55; Kurs 1,20 → ±60; Zahlung 20 EUR erst nach Bestätigung wirksam', async () => {
    await rpc(ef.client, 'set_fx_rate', { p_trip_id: t.tripId, p_currency: 'CHF', p_eur_per_unit: '1.10' })
    await addExpense(ef, t.tripId, { currency: 'CHF', minor: 10000, participants: equal(t.personIds.Erwin, t.personIds.Larissa) })
    expect(await balances(ef, t.tripId)).toEqual({ [t.personIds.Erwin]: 5500n, [t.personIds.Larissa]: -5500n })

    // Change must name the revision it replaces (deliberate change).
    await rpcFails(ef.client, 'set_fx_rate', { p_trip_id: t.tripId, p_currency: 'CHF', p_eur_per_unit: '1.20' }, 'revision_conflict')
    const preview = await rpc<{ person_id: string; current_minor: number; new_minor: number }[]>(ef.client, 'preview_fx_change', {
      p_trip_id: t.tripId,
      p_currency: 'CHF',
      p_eur_per_unit: '1.20',
    })
    expect(preview.find((p) => p.person_id === t.personIds.Erwin)).toMatchObject({ current_minor: 5500, new_minor: 6000 })
    await rpc(ef.client, 'set_fx_rate', { p_trip_id: t.tripId, p_currency: 'CHF', p_eur_per_unit: '1.20', p_expected_revision: 1 })
    expect(await balances(ef, t.tripId)).toEqual({ [t.personIds.Erwin]: 6000n, [t.personIds.Larissa]: -6000n })

    const sid = await rpc<string>(lg.client, 'report_settlement', {
      p_trip_id: t.tripId,
      p_idempotency_key: randomUUID(),
      p_receiver_person_id: t.personIds.Erwin,
      p_currency: 'EUR',
      p_original_minor: '2000',
    })
    expect(await balances(ef, t.tripId)).toEqual({ [t.personIds.Erwin]: 6000n, [t.personIds.Larissa]: -6000n })
    await rpc(ef.client, 'confirm_settlement', { p_settlement_id: sid })
    expect(await balances(ef, t.tripId)).toEqual({ [t.personIds.Erwin]: 4000n, [t.personIds.Larissa]: -4000n })
  })

  it('SEC-12: 100 CHF bestätigt bei 1,07 = 107,00 EUR; nach Kurs 1,10 weiterhin 107,00', async () => {
    const t2 = await setupTrip(ef, [lg])
    await rpc(ef.client, 'set_fx_rate', { p_trip_id: t2.tripId, p_currency: 'CHF', p_eur_per_unit: '1.07' })
    const sid = await rpc<string>(lg.client, 'report_settlement', {
      p_trip_id: t2.tripId,
      p_idempotency_key: randomUUID(),
      p_receiver_person_id: t2.personIds.Erwin,
      p_currency: 'CHF',
      p_original_minor: '10000',
    })
    expect(await rpc(ef.client, 'confirm_settlement', { p_settlement_id: sid })).toBe(10700)
    await rpc(ef.client, 'set_fx_rate', { p_trip_id: t2.tripId, p_currency: 'CHF', p_eur_per_unit: '1.10', p_expected_revision: 1 })
    const { data } = await ef.client.from('settlements').select('confirmed_base_minor, confirmed_from_rate').eq('id', sid).single()
    expect(data).toEqual({ confirmed_base_minor: 10700, confirmed_from_rate: 1.07 })
    expect(await balances(ef, t2.tripId)).toEqual({ [t2.personIds.Erwin]: -10700n, [t2.personIds.Larissa]: 10700n })
  })
})

describe('Doppelbuchungen und Nebenläufigkeit (DATA-03, SEC-11)', () => {
  it('Gleicher Idempotenz-Schlüssel 5× parallel → genau eine Ausgabe', async () => {
    const t = await setupTrip(ef, [lg])
    const key = randomUUID()
    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        addExpense(lg, t.tripId, { key, currency: 'EUR', minor: 1234, participants: equal(t.personIds.Erwin, t.personIds.Larissa) }),
      ),
    )
    expect(new Set(ids).size).toBe(1)
    const { count } = await ef.client.from('expenses').select('*', { count: 'exact', head: true }).eq('trip_id', t.tripId)
    expect(count).toBe(1)
  })

  it('Bestätigung doppelt und parallel → genau eine Saldowirkung', async () => {
    const t = await setupTrip(ef, [lg])
    await addExpense(ef, t.tripId, { currency: 'EUR', minor: 10000, participants: equal(t.personIds.Larissa) })
    const sid = await rpc<string>(lg.client, 'report_settlement', {
      p_trip_id: t.tripId,
      p_idempotency_key: randomUUID(),
      p_receiver_person_id: t.personIds.Erwin,
      p_currency: 'EUR',
      p_original_minor: '3000',
    })
    const results = await Promise.all(Array.from({ length: 4 }, () => rpc(ef.client, 'confirm_settlement', { p_settlement_id: sid })))
    expect(results).toEqual([3000, 3000, 3000, 3000])
    expect(await balances(ef, t.tripId)).toEqual({ [t.personIds.Erwin]: 7000n, [t.personIds.Larissa]: -7000n })
    const { count } = await ef.client
      .from('audit_events')
      .select('*', { count: 'exact', head: true })
      .eq('entity_id', sid)
      .eq('action', 'settlement.confirmed')
    expect(count).toBe(1)
  })
})

describe('Korrekturen (R9, DATA-05)', () => {
  it('Storno einer bestätigten Zahlung: Historie bleibt, Wirkung neutralisiert, nur einmal möglich', async () => {
    const t = await setupTrip(ef, [lg])
    await addExpense(ef, t.tripId, { currency: 'EUR', minor: 5000, participants: equal(t.personIds.Larissa) })
    const sid = await rpc<string>(lg.client, 'report_settlement', {
      p_trip_id: t.tripId,
      p_idempotency_key: randomUUID(),
      p_receiver_person_id: t.personIds.Erwin,
      p_currency: 'EUR',
      p_original_minor: '5000',
    })
    await rpc(ef.client, 'confirm_settlement', { p_settlement_id: sid })
    expect(await balances(ef, t.tripId)).toEqual({ [t.personIds.Erwin]: 0n, [t.personIds.Larissa]: 0n })

    await rpcFails(lg.client, 'reverse_settlement', { p_settlement_id: sid, p_reason: 'falsch' }, 'admin_required')
    await rpc(ef.client, 'reverse_settlement', { p_settlement_id: sid, p_reason: 'Doppelt erfasst' })
    expect(await balances(ef, t.tripId)).toEqual({ [t.personIds.Erwin]: 5000n, [t.personIds.Larissa]: -5000n })
    await rpcFails(ef.client, 'reverse_settlement', { p_settlement_id: sid, p_reason: 'nochmal' }, 'settlement_already_reversed')

    const { data } = await lg.client.from('settlements').select('status, confirmed_base_minor').eq('id', sid).single()
    expect(data).toEqual({ status: 'confirmed', confirmed_base_minor: 5000 })
    const { data: notices } = await lg.client.from('in_app_notices').select('kind').eq('trip_id', t.tripId)
    expect(notices!.map((n) => n.kind)).toContain('settlement_reversed')
  })

  it('Ausgabe ändern erzeugt Revision; veraltete Revision wird abgelehnt (Optimistic Locking)', async () => {
    const t = await setupTrip(ef, [lg])
    const id = await addExpense(lg, t.tripId, { currency: 'EUR', minor: 1000, participants: equal(t.personIds.Erwin, t.personIds.Larissa) })
    const args = {
      p_expense_id: id,
      p_expected_revision: 1,
      p_title: 'Taxi korrigiert',
      p_expense_date: '2026-10-02',
      p_currency: 'EUR',
      p_original_minor: '1200',
      p_split_mode: 'equal',
      p_participants: equal(t.personIds.Erwin, t.personIds.Larissa),
      p_reason: 'Trinkgeld vergessen',
    }
    expect(await rpc(lg.client, 'update_expense', args)).toBe(2)
    await rpcFails(lg.client, 'update_expense', args, 'revision_conflict')
    const { data } = await ef.client.from('expense_revisions').select('revision, snapshot').eq('expense_id', id)
    expect(data).toHaveLength(1)
    expect(data![0].snapshot.original_minor).toBe(1000)

    await rpc(lg.client, 'delete_expense', { p_expense_id: id, p_expected_revision: 2, p_reason: 'Doppelt' })
    expect(await balances(ef, t.tripId)).toEqual({ [t.personIds.Erwin]: 0n, [t.personIds.Larissa]: 0n })
    const { data: kept } = await ef.client.from('expenses').select('deleted_at').eq('id', id).single()
    expect(kept!.deleted_at).not.toBeNull()
  })
})

describe('Archiv (OPS-02, SEC-13)', () => {
  it('Abschluss mit Restschuld nur nach Bestätigung; Snapshot unveränderlich; danach keine Buchungen', async () => {
    const t = await setupTrip(ef, [lg])
    await addExpense(ef, t.tripId, { currency: 'EUR', minor: 1000, participants: equal(t.personIds.Larissa) })
    const sid = await rpc<string>(lg.client, 'report_settlement', {
      p_trip_id: t.tripId,
      p_idempotency_key: randomUUID(),
      p_receiver_person_id: t.personIds.Erwin,
      p_currency: 'EUR',
      p_original_minor: '100',
    })
    await rpcFails(ef.client, 'archive_trip', { p_trip_id: t.tripId, p_accept_open_balances: true }, 'pending_settlements_exist')
    await rpc(lg.client, 'withdraw_settlement', { p_settlement_id: sid })
    await rpcFails(ef.client, 'archive_trip', { p_trip_id: t.tripId, p_accept_open_balances: false }, 'open_balances_need_confirmation')
    expect(await rpc(ef.client, 'archive_trip', { p_trip_id: t.tripId, p_accept_open_balances: true })).toBe(1)

    await expect(
      addExpense(lg, t.tripId, { currency: 'EUR', minor: 100, participants: equal(t.personIds.Larissa) }),
    ).rejects.toThrow('trip_archived')
    await rpcFails(ef.client, 'set_fx_rate', { p_trip_id: t.tripId, p_currency: 'CHF', p_eur_per_unit: '1' }, 'trip_archived')
    await rpcFails(
      lg.client,
      'report_settlement',
      {
        p_trip_id: t.tripId,
        p_idempotency_key: randomUUID(),
        p_receiver_person_id: t.personIds.Erwin,
        p_currency: 'EUR',
        p_original_minor: '100',
      },
      'trip_archived',
    )

    const { data: closure } = await lg.client.from('trip_closures').select('version, snapshot').eq('trip_id', t.tripId).single()
    const snapBalances = closure!.snapshot.balances as { person_id: string; balance_minor: number }[]
    expect(snapBalances.find((b) => b.person_id === t.personIds.Erwin)!.balance_minor).toBe(1000)

    await rpc(ef.client, 'reopen_trip', { p_trip_id: t.tripId })
    await addExpense(lg, t.tripId, { currency: 'EUR', minor: 100, participants: equal(t.personIds.Erwin) })
    expect(await rpc(ef.client, 'archive_trip', { p_trip_id: t.tripId, p_accept_open_balances: true })).toBe(2)
    const { data: all } = await lg.client.from('trip_closures').select('version').eq('trip_id', t.tripId).order('version')
    expect(all!.map((c) => c.version)).toEqual([1, 2])
  })
})
