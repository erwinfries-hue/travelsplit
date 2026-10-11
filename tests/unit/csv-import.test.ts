import { describe, expect, it } from 'vitest'
import { serializeCsv } from '../../src/features/csv/csv'
import { exportRows } from '../../src/features/csv/exportTrip'
import { buildImport, normalizeDate } from '../../src/features/csv/importTrip'
import type { TripData } from '../../src/features/trip/types'

const P = { erwin: '00000000-0000-4000-8000-000000000001', larissa: '00000000-0000-4000-8000-000000000002' }

function trip(): TripData {
  const expense = (id: string, over: Partial<TripData['expenses'][number]> = {}) => ({
    id, created_by: 'u1', paid_by_person_id: P.erwin, title: `=Titel ${id}`, category: 'food', note: 'Zeile 1\nZeile 2; "x"',
    expense_date: '2025-07-01', currency: 'CHF', original_minor: 1000, split_mode: 'equal' as const, source: 'app',
    admin_reconstruction: false, revision: 1, created_at: '2025-07-01T10:00:00Z', deleted_at: null, ...over,
  })
  return {
    trip: { id: 't1', title: 'Bern', base_currency: 'EUR', start_date: '2025-07-01', end_date: null, status: 'active', admin_user_id: 'u1', version: 1, created_at: '' },
    people: [
      { id: P.erwin, display_name: 'Erwin', linked_user_id: 'u1', status: 'active' },
      { id: P.larissa, display_name: 'Larissa', linked_user_id: null, status: 'placeholder' },
    ],
    rates: [{ currency: 'CHF', eur_per_unit: '1.0500000000', revision: 1, rate_date: null, updated_at: '' }],
    expenses: [expense('e1'), expense('e2', { deleted_at: '2025-07-02T00:00:00Z' }), expense('e3', { split_mode: 'fixed', currency: 'EUR', original_minor: 300 })],
    splits: [
      { expense_id: 'e1', person_id: P.erwin, original_minor: 500, input_value: null },
      { expense_id: 'e1', person_id: P.larissa, original_minor: 500, input_value: null },
      { expense_id: 'e3', person_id: P.erwin, original_minor: 100, input_value: 100 },
      { expense_id: 'e3', person_id: P.larissa, original_minor: 200, input_value: 200 },
    ],
    baseShares: [],
    balances: new Map(),
    settlements: [
      { id: 's1', sender_person_id: P.larissa, receiver_person_id: P.erwin, currency: 'EUR', original_minor: 100, note: null, status: 'confirmed',
        created_at: '2025-07-03T00:00:00Z', decided_at: null, confirmed_base_minor: 100, confirmed_base_currency: 'EUR', confirmed_from_rate: '1', confirmed_base_rate: '1', confirmed_at: '2025-07-03T00:00:00Z' },
    ],
    reversals: [],
    receipts: [],
    myPersonId: P.erwin,
    isAdmin: true,
  }
}

describe('CSV Export → Import', () => {
  it('liefert dieselben Ausgaben, Anteile und Kurse zurück; Gelöschtes und Rückzahlungen werden nicht übernommen', () => {
    const data = trip()
    const preview = buildImport(serializeCsv(exportRows(data)), { ...data, people: [] })
    expect(preview.errors).toEqual([])
    expect(preview.rates).toEqual([{ currency: 'CHF', eur_per_unit: '1.0500000000' }])
    expect(preview.ignored).toEqual({ settlements: 1, deleted: 1, other: 3 })
    expect(preview.newPeople.sort()).toEqual(['Erwin', 'Larissa'])
    expect(preview.expenses).toEqual([
      expect.objectContaining({ row_id: 'e1', title: '=Titel e1', note: 'Zeile 1\nZeile 2; "x"', currency: 'CHF', original_minor: '1000', split_mode: 'equal',
        shares: [{ name: 'Erwin', value: null }, { name: 'Larissa', value: null }] }),
      expect.objectContaining({ row_id: 'e3', split_mode: 'fixed', shares: [{ name: 'Erwin', value: '100' }, { name: 'Larissa', value: '200' }] }),
    ])
  })

  it('meldet Fehler mit Zeilennummer schon in der Vorschau', () => {
    const csv = serializeCsv([
      { schema_version: 1, row_type: 'expense', row_id: 'x', date: '2025-02-30', title: 'A', person_name: 'E', currency: 'EUR', amount_minor: 100, split_mode: 'equal' },
      { schema_version: 1, row_type: 'expense', row_id: 'y', date: '2025-02-01', title: 'B', person_name: 'E', currency: 'EUR', amount_minor: 100, split_mode: 'fixed' },
      { schema_version: 1, row_type: 'expense_share', ref_id: 'y', person_name: 'E', share_value: 99 },
      { schema_version: 2, row_type: 'expense' },
    ])
    expect(buildImport(csv, trip()).errors).toEqual([
      { line: 2, code: 'import_invalid_row' },
      { line: 3, code: 'fixed_sum_mismatch' },
      { line: 5, code: 'import_unsupported_version' },
    ])
  })

  it('Excel-Datumsformat wird akzeptiert', () => {
    expect(normalizeDate('1.7.2025')).toBe('2025-07-01')
    expect(normalizeDate('2025-07-01')).toBe('2025-07-01')
  })
})
