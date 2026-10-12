import { minorToDecimalString, parseRate, rateToString } from '../../domain/money'
import type { TripData } from '../trip/types'
import { CSV_SCHEMA_VERSION, type CsvRow } from './csv'

const display = (minor: number | bigint, currency: string) => `${minorToDecimalString(BigInt(minor), currency)} ${currency}`

/** All rows of one trip, built only from data the signed-in member is allowed to read (RLS). */
export function exportRows(data: TripData): CsvRow[] {
  const v = CSV_SCHEMA_VERSION
  const base = data.trip.base_currency
  const name = (id: string | null) => data.people.find((p) => p.id === id)?.display_name ?? ''
  const rows: CsvRow[] = [
    {
      schema_version: v, row_type: 'trip', row_id: data.trip.id, date: data.trip.start_date, title: data.trip.title,
      base_currency: base, status: data.trip.status, note: data.trip.end_date ? `end ${data.trip.end_date}` : null,
    },
  ]
  for (const p of data.people) {
    rows.push({ schema_version: v, row_type: 'person', row_id: p.id, person_name: p.display_name, status: p.status })
  }
  for (const r of data.rates) {
    const scaled = parseRate(r.eur_per_unit)
    rows.push({
      schema_version: v, row_type: 'trip_fx', row_id: r.currency, date: r.rate_date, currency: r.currency,
      rate_scaled: scaled, status: `revision ${r.revision}`, amount_display: `1 ${r.currency} = ${rateToString(scaled)} EUR`,
    })
  }
  const baseShares = new Map(data.baseShares.map((s) => [`${s.expense_id}:${s.person_id}`, s]))
  const baseTotal = new Map(data.baseShares.map((s) => [s.expense_id, s.base_total]))
  for (const e of [...data.expenses].sort((a, b) => a.expense_date.localeCompare(b.expense_date) || a.created_at.localeCompare(b.created_at))) {
    rows.push({
      schema_version: v, row_type: 'expense', row_id: e.id, date: e.expense_date, title: e.title,
      person_name: name(e.paid_by_person_id), currency: e.currency, amount_minor: e.original_minor,
      base_currency: base, base_amount_minor: e.deleted_at ? null : (baseTotal.get(e.id) ?? null), split_mode: e.split_mode,
      status: e.deleted_at ? 'deleted' : e.admin_reconstruction ? 'admin_reconstruction' : 'active',
      category: e.category, note: e.note, amount_display: display(e.original_minor, e.currency), source: e.source,
    })
    for (const s of data.splits.filter((x) => x.expense_id === e.id).sort((a, b) => name(a.person_id).localeCompare(name(b.person_id)))) {
      rows.push({
        schema_version: v, row_type: 'expense_share', row_id: s.person_id, ref_id: e.id, person_name: name(s.person_id),
        currency: e.currency, amount_minor: s.original_minor, base_currency: base,
        base_amount_minor: e.deleted_at ? null : (baseShares.get(`${e.id}:${s.person_id}`)?.base_minor ?? null),
        split_mode: e.split_mode, share_value: s.input_value, amount_display: display(s.original_minor, e.currency),
      })
    }
  }
  for (const s of data.settlements) {
    const reversal = data.reversals.find((r) => r.settlement_id === s.id)
    rows.push({
      schema_version: v, row_type: 'settlement', row_id: s.id, date: (s.confirmed_at ?? s.created_at).slice(0, 10),
      person_name: name(s.sender_person_id), counterparty_name: name(s.receiver_person_id), currency: s.currency,
      amount_minor: s.original_minor, base_currency: s.confirmed_base_currency, base_amount_minor: s.confirmed_base_minor,
      rate_scaled: s.confirmed_from_rate ? parseRate(s.confirmed_from_rate) : null,
      status: reversal ? 'reversed' : s.status, note: s.note, amount_display: display(s.original_minor, s.currency),
    })
    if (reversal) {
      rows.push({
        schema_version: v, row_type: 'settlement_reversal', row_id: reversal.id, ref_id: s.id, date: reversal.created_at.slice(0, 10),
        base_currency: s.confirmed_base_currency, base_amount_minor: reversal.reversed_base_minor, note: reversal.reason,
      })
    }
  }
  return rows
}

export function exportFileName(data: TripData): string {
  const slug = data.trip.title.normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'reise'
  return `travelsplit-${slug}-${new Date().toISOString().slice(0, 10)}.csv`
}
