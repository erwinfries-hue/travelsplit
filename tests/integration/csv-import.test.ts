// R7 / DATA-03: CSV import is admin-only, atomic, revalidated on the server and not repeatable.
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { balances, closeDb, createUser, db, rpc, rpcFails, setupTrip } from './helpers'

afterAll(closeDb)

const sha = () => createHash('sha256').update(randomUUID()).digest('hex')

function expense(row: string, over: Record<string, unknown> = {}) {
  return {
    row_id: row, date: '2025-07-01', title: `Import ${row}`, currency: 'EUR', original_minor: '9000', split_mode: 'equal',
    paid_by_name: 'Erwin', category: 'food', note: null,
    shares: [{ name: 'Erwin', value: null }, { name: 'Larissa', value: null }, { name: 'Oma Käthi', value: null }],
    ...over,
  }
}

describe('CSV-Import', () => {
  it('bucht alle Zeilen, legt fehlende Personen als Platzhalter an und markiert die Herkunft', async () => {
    const erwin = await createUser('Erwin', { creator: true })
    const larissa = await createUser('Larissa', { google: true })
    const { tripId } = await setupTrip(erwin, [larissa])
    const res = await rpc<{ expenses: number; people_created: number; rates_set: number }>(erwin.client, 'import_expenses_csv', {
      p_trip_id: tripId, p_content_sha256: sha(), p_schema_version: 1,
      p_rates: [{ currency: 'CHF', eur_per_unit: '1.0500000000' }],
      p_expenses: [
        expense('1'),
        expense('2', { paid_by_name: 'oma käthi', currency: 'CHF', original_minor: '10000', split_mode: 'fixed',
          shares: [{ name: 'Larissa', value: '2500' }, { name: 'Oma Käthi', value: '7500' }] }),
      ],
    })
    expect(res).toEqual({ batch_id: expect.any(String), expenses: 2, people_created: 1, rates_set: 1 })

    const { data: people } = await larissa.client.from('trip_people').select('display_name, status').eq('trip_id', tripId).order('display_name')
    expect(people).toContainEqual({ display_name: 'Oma Käthi', status: 'placeholder' })
    const { data: rows } = await larissa.client.from('expenses').select('source, admin_reconstruction, title').eq('trip_id', tripId).order('title')
    expect(rows).toEqual([
      { source: 'csv_import', admin_reconstruction: false, title: 'Import 1' },
      { source: 'csv_import', admin_reconstruction: true, title: 'Import 2' },
    ])
    const sum = Object.values(await balances(larissa, tripId)).reduce((a, b) => a + b, 0n)
    expect(sum).toBe(0n)
    const { data: notices } = await larissa.client.from('in_app_notices').select('kind').eq('trip_id', tripId)
    expect(notices!.filter((n) => n.kind === 'csv_imported')).toHaveLength(1)
    expect(notices!.filter((n) => n.kind === 'expense_created')).toHaveLength(0)
  })

  it('DATA-03: dieselbe Datei ein zweites Mal wird abgelehnt', async () => {
    const erwin = await createUser('Erwin', { creator: true })
    const { tripId } = await setupTrip(erwin, [])
    const args = { p_trip_id: tripId, p_content_sha256: sha(), p_schema_version: 1, p_rates: [], p_expenses: [expense('1', { shares: [{ name: 'Erwin', value: null }] })] }
    await rpc(erwin.client, 'import_expenses_csv', args)
    await rpcFails(erwin.client, 'import_expenses_csv', args, 'import_duplicate')
    const { count } = await erwin.client.from('expenses').select('id', { count: 'exact', head: true }).eq('trip_id', tripId)
    expect(count).toBe(1)
  })

  it('ein fehlerhafter Datensatz rollt die ganze Datei zurück und nennt die Zeile', async () => {
    const erwin = await createUser('Erwin', { creator: true })
    const { tripId } = await setupTrip(erwin, [])
    const { error } = await erwin.client.rpc('import_expenses_csv', {
      p_trip_id: tripId, p_content_sha256: sha(), p_schema_version: 1, p_rates: [],
      p_expenses: [
        expense('ok'),
        expense('bad', { split_mode: 'fixed', shares: [{ name: 'Erwin', value: '100' }, { name: 'Neu', value: '100' }] }),
      ],
    })
    expect(error?.message).toBe('fixed_sum_mismatch')
    expect(error?.details).toBe('row bad')
    const { count: expenses } = await erwin.client.from('expenses').select('id', { count: 'exact', head: true }).eq('trip_id', tripId)
    const { count: people } = await erwin.client.from('trip_people').select('id', { count: 'exact', head: true }).eq('trip_id', tripId)
    const { count: batches } = await erwin.client.from('csv_import_batches').select('id', { count: 'exact', head: true }).eq('trip_id', tripId)
    expect([expenses, people, batches]).toEqual([0, 1, 0])
  })

  it('nur die Reiseleitung darf importieren; Fremde sehen die Reise nicht', async () => {
    const erwin = await createUser('Erwin', { creator: true })
    const larissa = await createUser('Larissa', { google: true })
    const mallory = await createUser('Mallory', { google: true, creator: true })
    const { tripId } = await setupTrip(erwin, [larissa])
    const args = { p_trip_id: tripId, p_content_sha256: sha(), p_schema_version: 1, p_rates: [], p_expenses: [expense('1')] }
    await rpcFails(larissa.client, 'import_expenses_csv', args, 'admin_required')
    await rpcFails(mallory.client, 'import_expenses_csv', args, 'trip_not_found')
  })

  it('abweichender Kurs, falsche Version und archivierte Reise werden abgelehnt', async () => {
    const erwin = await createUser('Erwin', { creator: true })
    const { tripId } = await setupTrip(erwin, [])
    await rpc(erwin.client, 'set_fx_rate', { p_trip_id: tripId, p_currency: 'CHF', p_eur_per_unit: 1.07 })
    const base = { p_trip_id: tripId, p_schema_version: 1, p_rates: [], p_expenses: [expense('1', { shares: [{ name: 'Erwin', value: null }] })] }
    await rpcFails(erwin.client, 'import_expenses_csv', { ...base, p_content_sha256: sha(), p_rates: [{ currency: 'CHF', eur_per_unit: '1.1' }] }, 'import_rate_conflict')
    await rpcFails(erwin.client, 'import_expenses_csv', { ...base, p_content_sha256: sha(), p_schema_version: 2 }, 'import_unsupported_version')
    await rpc(erwin.client, 'archive_trip', { p_trip_id: tripId, p_accept_open_balances: true })
    await rpcFails(erwin.client, 'import_expenses_csv', { ...base, p_content_sha256: sha() }, 'trip_archived')
  })

  it('die Import-Herkunft lässt sich nicht von aussen erzwingen', async () => {
    const erwin = await createUser('Erwin', { creator: true })
    const { tripId } = await setupTrip(erwin, [])
    // set_config is not part of the API; a normal expense is always source=app.
    const { error } = await erwin.client.rpc('set_config', { setting_name: 'travelsplit.import_batch', new_value: 'x', is_local: false })
    expect(error).not.toBeNull()
    const { data: me } = await erwin.client.from('trip_people').select('id').eq('trip_id', tripId).single()
    await rpc(erwin.client, 'create_expense', {
      p_trip_id: tripId, p_idempotency_key: randomUUID(), p_title: 'App', p_expense_date: '2025-07-01', p_currency: 'EUR',
      p_original_minor: '100', p_split_mode: 'equal', p_participants: [{ person_id: me!.id }],
    })
    const { rows } = await db().query('select source from public.expenses where trip_id = $1', [tripId])
    expect(rows).toEqual([{ source: 'app' }])
  })
})
