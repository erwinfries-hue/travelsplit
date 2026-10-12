import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useAuth } from '../../app/auth'
import { CurrencySelect } from '../../components/CurrencySelect'
import { Avatar, Button, Card, ErrorBox, Field, Input, Select, TextArea } from '../../components/ui'
import {
  convertMinor,
  currencyExponent,
  MoneyError,
  parseAmount,
  parsePercent,
  parseRate,
  PERCENT_SCALE,
  ratePairFor,
  splitBase,
  splitOriginal,
  type SplitInput,
  type SplitMode,
} from '../../domain/money'
import { type ExpenseArgs, saveDraft } from '../../lib/drafts'
import { minorToInput, money } from '../../lib/format'
import { newId } from '../../lib/ids'
import { uploadReceipt } from '../../lib/receipts'
import { type AppError, rpc, toAppError } from '../../lib/rpc'
import { CATEGORIES, CATEGORY_ICON } from '../trip/derive'
import type { Expense, TripData } from '../trip/types'
import { ReceiptPicker } from './ReceiptPicker'

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Values from the quick entry; the user still reviews and saves the normal form. */
export interface ExpensePrefill {
  title: string
  currency: string
  amount: string
  mode: SplitMode
  selected: string[]
  values: Record<string, string>
}

export function ExpenseForm({ data, existing, prefill }: { data: TripData; existing?: Expense; prefill?: ExpensePrefill }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const people = data.people.filter((p) => p.status !== 'removed')
  const existingSplits = existing ? data.splits.filter((s) => s.expense_id === existing.id) : []
  const exp0 = currencyExponent(existing?.currency ?? data.trip.base_currency)

  const [title, setTitle] = useState(existing?.title ?? prefill?.title ?? '')
  const [currency, setCurrency] = useState(existing?.currency ?? prefill?.currency ?? data.trip.base_currency)
  const [amount, setAmount] = useState(existing ? minorToInput(existing.original_minor, exp0) : (prefill?.amount ?? ''))
  const [expenseDate, setExpenseDate] = useState(existing?.expense_date ?? today())
  const [category, setCategory] = useState<string | null>(existing?.category ?? null)
  const [note, setNote] = useState(existing?.note ?? '')
  const [mode, setMode] = useState<SplitMode>(existing?.split_mode ?? prefill?.mode ?? 'equal')
  const [advanced, setAdvanced] = useState(existing ? existing.split_mode !== 'equal' : prefill?.mode === 'percent')
  const [selected, setSelected] = useState<Set<string>>(
    new Set(existing ? existingSplits.map((s) => s.person_id) : (prefill?.selected ?? people.map((p) => p.id))),
  )
  const [values, setValues] = useState<Record<string, string>>(() => {
    if (!existing) return prefill?.values ?? {}
    if (existing.split_mode === 'equal') return {}
    return Object.fromEntries(
      existingSplits.map((s) => [
        s.person_id,
        existing.split_mode === 'fixed'
          ? minorToInput(s.input_value ?? s.original_minor, exp0)
          : String(Number(s.input_value ?? 0) / Number(PERCENT_SCALE)).replace('.', t('common.decimalSep')),
      ]),
    )
  })
  const ownPayer = existing ? existing.paid_by_person_id : data.myPersonId
  const [payer, setPayer] = useState<string>(ownPayer ?? '')
  const [foreignPayer, setForeignPayer] = useState(existing ? existing.paid_by_person_id !== data.myPersonId : false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const idempotencyKey = useRef(newId())
  const [photo, setPhoto] = useState<Blob | null>(null)

  const rateSheet = useMemo(() => new Map(data.rates.map((r) => [r.currency, parseRate(r.eur_per_unit)])), [data.rates])
  const missingRate = currency !== data.trip.base_currency && [currency, data.trip.base_currency].some((c) => c !== 'EUR' && !rateSheet.has(c))

  // Live preview with the same algorithms the server uses; the server result is authoritative.
  const preview = useMemo(() => {
    try {
      const total = parseAmount(amount, currency)
      const inputs: SplitInput[] = [...selected].map((personId) => {
        if (mode === 'equal') return { personId }
        const raw = values[personId] ?? ''
        return { personId, value: raw.trim() === '' ? 0n : mode === 'fixed' ? parseAmountOrZero(raw, currency) : parsePercent(raw) }
      })
      const shares = splitOriginal(total, mode, inputs)
      if (missingRate) return { total, shares, base: null, error: null }
      const baseTotal = convertMinor(total, currency, data.trip.base_currency, ratePairFor(currency, data.trip.base_currency, rateSheet))
      return { total, shares, base: { total: baseTotal, shares: splitBase(baseTotal, shares) }, error: null }
    } catch (e) {
      return { total: null, shares: null, base: null, error: e instanceof MoneyError ? e.code : 'invalid_amount' }
    }
  }, [amount, currency, selected, mode, values, missingRate, rateSheet, data.trip.base_currency])

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  const submit = async () => {
    if (!preview.shares || preview.total === null) {
      setError(toAppError({ message: preview.error ?? 'invalid_amount' }))
      return
    }
    setBusy(true)
    setError(null)
    const participants = [...selected].map((person_id) => ({
      person_id,
      value: mode === 'equal' ? null : mode === 'fixed' ? parseAmountOrZero(values[person_id] ?? '', currency).toString() : parsePercent(values[person_id] || '0').toString(),
    }))
    const common: ExpenseArgs = {
      p_title: title.trim(),
      p_expense_date: expenseDate,
      p_currency: currency,
      p_original_minor: preview.total.toString(),
      p_split_mode: mode,
      p_participants: participants,
      p_paid_by_person_id: payer || null,
      p_category: category,
      p_note: note.trim() || null,
    }
    try {
      if (existing) {
        await rpc('update_expense', { ...common, p_expense_id: existing.id, p_expected_revision: existing.revision, p_reason: reason.trim() || null })
        navigate(`/trips/${data.trip.id}/expenses/${existing.id}`, { replace: true })
      } else {
        await createNew(common)
      }
    } catch (e) {
      setError(toAppError(e))
      setBusy(false)
    }
  }

  // New expenses survive a missing connection as a local draft (sent later with the same idempotency key).
  const createNew = async (args: ExpenseArgs) => {
    const draft = {
      id: idempotencyKey.current, userId: user!.id, tripId: data.trip.id, createdAt: new Date().toISOString(),
      args, photo, expenseId: null as string | null, lastError: null,
    }
    const keepAsDraft = async (expenseId: string | null) => {
      await saveDraft({ ...draft, expenseId })
      navigate(`/trips/${data.trip.id}/expenses`, { replace: true })
    }
    if (!navigator.onLine) return keepAsDraft(null)
    let id: string
    try {
      id = await rpc<string>('create_expense', { ...args, p_trip_id: data.trip.id, p_idempotency_key: idempotencyKey.current })
    } catch (e) {
      if (toAppError(e).code === 'network_error') return keepAsDraft(null)
      throw e
    }
    if (photo) {
      try {
        await uploadReceipt(data.trip.id, id, photo)
      } catch {
        return keepAsDraft(id)
      }
    }
    navigate(`/trips/${data.trip.id}/expenses/${id}`, { replace: true })
  }

  const baseCur = data.trip.base_currency
  const shareOf = (id: string) => preview.shares?.find((s) => s.personId === id)
  const baseShareOf = (id: string) => preview.base?.shares.find((s) => s.personId === id)

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Card className="flex flex-col gap-4">
        <div className="grid grid-cols-[1fr_8rem] gap-2">
          <Field label={t('expenses.amount')} htmlFor="exp-amount">
            <Input
              id="exp-amount"
              inputMode="decimal"
              autoFocus={!existing}
              required
              className="text-2xl font-bold"
              placeholder={currencyExponent(currency) ? `0${t('common.decimalSep')}00` : '0'}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label={t('expenses.currency')} htmlFor="exp-currency">
            <CurrencySelect id="exp-currency" value={currency} onChange={setCurrency} preferred={[baseCur, ...data.rates.map((r) => r.currency)]} />
          </Field>
        </div>
        {missingRate && <p className="rounded-xl bg-red-50 p-2 text-sm text-red-800">{t('expenses.missingRate', { currency })}</p>}
        {preview.base && currency !== baseCur && (
          <p className="text-sm text-slate-600">
            ≈ {money(preview.base.total, baseCur)} · {t('expenses.tripRate')}
          </p>
        )}
        <Field label={t('expenses.title')} htmlFor="exp-title">
          <Input id="exp-title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('expenses.titlePlaceholder')} />
        </Field>

        <Field label={t('expenses.paidByLabel')} htmlFor="exp-payer">
          {!foreignPayer ? (
            <div className="flex items-center gap-2 rounded-xl bg-navy-50 px-3 py-2">
              {ownPayer && <Avatar name={data.people.find((p) => p.id === ownPayer)?.display_name ?? '?'} id={ownPayer} size="sm" />}
              <span className="font-semibold">{ownPayer === data.myPersonId ? t('common.me') : data.people.find((p) => p.id === ownPayer)?.display_name}</span>
            </div>
          ) : (
            <Select id="exp-payer" value={payer} onChange={(e) => setPayer(e.target.value)}>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                  {p.status === 'placeholder' ? ` (${t('people.placeholder')})` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {data.isAdmin && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5"
              checked={foreignPayer}
              onChange={(e) => {
                setForeignPayer(e.target.checked)
                if (!e.target.checked) setPayer(data.myPersonId ?? '')
              }}
            />
            <span>
              <span className="font-semibold">{t('expenses.foreignPayer')}</span>
              <br />
              <span className="text-slate-500">{t('expenses.foreignPayerHint')}</span>
            </span>
          </label>
        )}
      </Card>

      <Card className="flex flex-col gap-3">
        <div>
          <p className="text-sm font-semibold">{t('expenses.participants')}</p>
          <p className="text-xs text-slate-500">{t('expenses.participantsHint')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {people.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={selected.has(p.id)}
              onClick={() => toggle(p.id)}
              className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-semibold ${selected.has(p.id) ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-300 bg-white text-slate-500'}`}
            >
              <Avatar name={p.display_name} id={p.id} size="sm" />
              {p.display_name}
              {selected.has(p.id) && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>

        <div role="radiogroup" aria-label={t('expenses.split')} className="grid grid-cols-3 gap-1 rounded-xl bg-navy-50 p-1">
          {(['equal', ...(advanced ? (['fixed', 'percent'] as const) : [])] as SplitMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-lg px-2 text-sm font-semibold ${mode === m ? 'bg-brand-500 text-white' : 'text-navy-800'}`}
            >
              {t(`expenses.mode.${m}`)}
            </button>
          ))}
          {!advanced && (
            <button type="button" onClick={() => setAdvanced(true)} className="col-span-2 rounded-lg px-2 text-sm text-navy-600 underline">
              {t('expenses.advanced')}
            </button>
          )}
        </div>

        <ul className="flex flex-col gap-1">
          {people
            .filter((p) => selected.has(p.id))
            .map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <span className="flex-1 truncate text-sm">{p.display_name}</span>
                {mode !== 'equal' && (
                  <Input
                    aria-label={t(mode === 'fixed' ? 'expenses.fixedFor' : 'expenses.percentFor', { name: p.display_name })}
                    inputMode="decimal"
                    className="w-28 text-right"
                    placeholder={mode === 'percent' ? '%' : '0'}
                    value={values[p.id] ?? ''}
                    onChange={(e) => setValues({ ...values, [p.id]: e.target.value })}
                  />
                )}
                <span className="w-28 text-right text-sm">
                  {shareOf(p.id) ? money(shareOf(p.id)!.minor, currency) : '–'}
                  {baseShareOf(p.id) && currency !== baseCur && <span className="block text-xs text-slate-500">{money(baseShareOf(p.id)!.minor, baseCur)}</span>}
                </span>
              </li>
            ))}
        </ul>
        {preview.error && amount && <ErrorBox error={{ code: preview.error }} />}
      </Card>

      <Card className="flex flex-col gap-4">
        <Field label={t('expenses.date')} htmlFor="exp-date">
          <Input id="exp-date" type="date" required value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} />
        </Field>
        <div>
          <p className="mb-1 text-sm font-semibold">{t('expenses.category')}</p>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={category === c}
                onClick={() => setCategory(category === c ? null : c)}
                className={`rounded-full border px-3 py-1 text-sm ${category === c ? 'border-brand-500 bg-brand-50 font-semibold text-brand-700' : 'border-slate-300 bg-white'}`}
              >
                {CATEGORY_ICON[c]} {t(`categories.${c}`)}
              </button>
            ))}
          </div>
        </div>
        <Field label={t('expenses.noteOptional')} htmlFor="exp-note">
          <TextArea id="exp-note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {!existing && (
          <Field label={t('receipts.title')} htmlFor="exp-receipt">
            <ReceiptPicker id="exp-receipt" value={photo} onChange={setPhoto} />
          </Field>
        )}
        {existing && (
          <Field label={t('expenses.changeReason')} htmlFor="exp-reason">
            <Input id="exp-reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
      </Card>

      <ErrorBox error={error} />
      <Button type="submit" busy={busy} disabled={!preview.shares || !title.trim() || missingRate || !user} className="py-3 text-lg">
        ✓ {t('common.save')}
      </Button>
    </form>
  )
}

function parseAmountOrZero(raw: string, currency: string): bigint {
  const trimmed = raw.trim()
  if (trimmed === '' || /^0+([.,]0*)?$/.test(trimmed)) return 0n
  return parseAmount(trimmed, currency)
}
