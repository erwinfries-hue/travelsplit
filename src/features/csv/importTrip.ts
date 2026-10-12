// Turns a parsed TravelSplit CSV into the import payload and a preview. The server validates everything again.
import { currencyExponent, isSupportedCurrency, MoneyError, splitOriginal, type SplitInput, type SplitMode } from '../../domain/money'
import type { TripData } from '../trip/types'
import { CSV_SCHEMA_VERSION, parseCsv, unneutralize } from './csv'

export interface ImportExpense {
  row_id: string
  date: string
  title: string
  currency: string
  original_minor: string
  split_mode: SplitMode
  paid_by_name: string
  category: string | null
  note: string | null
  shares: { name: string; value: string | null }[]
}

export interface ImportPreview {
  expenses: ImportExpense[]
  rates: { currency: string; eur_per_unit: string }[]
  newPeople: string[]
  ignored: { settlements: number; deleted: number; other: number }
  errors: { line: number; code: string }[]
}

const CATEGORIES = new Set(['transport', 'accommodation', 'food', 'activities', 'shopping', 'other'])
const MODES = new Set(['equal', 'fixed', 'percent'])
const INT = /^\d+$/

/** ISO date; also accepts d.m.yyyy, which Excel (DE/CH) writes after "save as CSV". */
export function normalizeDate(raw: string): string {
  const v = raw.trim()
  const ch = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v)
  return ch ? `${ch[3]}-${ch[2].padStart(2, '0')}-${ch[1].padStart(2, '0')}` : v
}

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v)
}

function rateFromScaled(scaled: string): string {
  const padded = scaled.padStart(11, '0')
  return `${padded.slice(0, -10)}.${padded.slice(-10)}`
}

export function buildImport(text: string, data: TripData): ImportPreview {
  const { rows } = parseCsv(text)
  const errors: ImportPreview['errors'] = []
  const ignored = { settlements: 0, deleted: 0, other: 0 }
  const rates: ImportPreview['rates'] = []
  const heads = new Map<string, { line: number; exp: ImportExpense }>()
  const shareRows: { line: number; ref: string; name: string; value: string | null }[] = []
  const deleted = new Set<string>()
  const txt = (s: string | undefined) => unneutralize((s ?? '').trim())

  for (const { line, cells } of rows) {
    if (cells.schema_version !== String(CSV_SCHEMA_VERSION)) {
      errors.push({ line, code: 'import_unsupported_version' })
      continue
    }
    switch (cells.row_type) {
      case 'trip_fx': {
        const currency = cells.currency?.trim().toUpperCase() ?? ''
        if (!isSupportedCurrency(currency) || !INT.test(cells.rate_scaled ?? '') || BigInt(cells.rate_scaled) === 0n) {
          errors.push({ line, code: 'import_invalid_row' })
        } else if (currency !== 'EUR') rates.push({ currency, eur_per_unit: rateFromScaled(cells.rate_scaled) })
        break
      }
      case 'expense': {
        if (cells.status === 'deleted') {
          deleted.add(cells.row_id)
          ignored.deleted++
          break
        }
        const currency = cells.currency?.trim().toUpperCase() ?? ''
        const exp: ImportExpense = {
          row_id: cells.row_id?.trim() ?? '',
          date: normalizeDate(cells.date ?? ''),
          title: txt(cells.title),
          currency,
          original_minor: cells.amount_minor?.trim() ?? '',
          split_mode: (cells.split_mode?.trim() || 'equal') as SplitMode,
          paid_by_name: txt(cells.person_name),
          category: cells.category?.trim() || null,
          note: txt(cells.note) || null,
          shares: [],
        }
        const valid =
          exp.row_id !== '' && exp.row_id.length <= 64 && !heads.has(exp.row_id) &&
          isIsoDate(exp.date) &&
          exp.title.length >= 1 && exp.title.length <= 120 &&
          isSupportedCurrency(currency) && INT.test(exp.original_minor) && BigInt(exp.original_minor) > 0n &&
          MODES.has(exp.split_mode) && exp.paid_by_name !== '' && exp.paid_by_name.length <= 60 &&
          (exp.category === null || CATEGORIES.has(exp.category)) && (exp.note?.length ?? 0) <= 1000
        if (valid) heads.set(exp.row_id, { line, exp })
        else errors.push({ line, code: 'import_invalid_row' })
        break
      }
      case 'expense_share':
        shareRows.push({ line, ref: cells.ref_id?.trim() ?? '', name: txt(cells.person_name), value: cells.share_value?.trim() || null })
        break
      case 'settlement':
      case 'settlement_reversal':
        ignored.settlements++
        break
      default:
        ignored.other++
    }
  }

  for (const s of shareRows) {
    if (deleted.has(s.ref)) continue
    const head = heads.get(s.ref)
    if (!head || s.name === '' || s.name.length > 60 || (s.value !== null && !INT.test(s.value))) {
      errors.push({ line: s.line, code: 'import_invalid_row' })
      continue
    }
    head.exp.shares.push({ name: s.name, value: s.value })
  }

  // Same split rules as the server, so errors show up in the preview and not only on booking.
  for (const { line, exp } of heads.values()) {
    try {
      const names = exp.shares.map((s) => s.name.toLowerCase())
      if (new Set(names).size !== names.length) throw new MoneyError('duplicate_participant', 'duplicate participant name')
      const inputs: SplitInput[] = exp.shares.map((s) => ({ personId: s.name.toLowerCase(), value: exp.split_mode === 'equal' ? undefined : BigInt(s.value ?? '0') }))
      currencyExponent(exp.currency)
      splitOriginal(BigInt(exp.original_minor), exp.split_mode, inputs)
    } catch (e) {
      errors.push({ line, code: e instanceof MoneyError ? e.code : 'import_invalid_row' })
    }
  }

  const known = new Set(data.people.filter((p) => p.status !== 'removed').map((p) => p.display_name.trim().toLowerCase()))
  const newPeople = new Map<string, string>()
  for (const { exp } of heads.values()) {
    for (const n of [exp.paid_by_name, ...exp.shares.map((s) => s.name)]) {
      if (!known.has(n.toLowerCase()) && !newPeople.has(n.toLowerCase())) newPeople.set(n.toLowerCase(), n)
    }
  }
  const expenses = [...heads.values()].map((h) => h.exp)
  if (expenses.length === 0 && errors.length === 0) errors.push({ line: 1, code: 'import_empty' })
  return { expenses, rates, newPeople: [...newPeople.values()], ignored, errors: errors.sort((a, b) => a.line - b.line) }
}
