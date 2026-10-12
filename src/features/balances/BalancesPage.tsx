import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router'
import { CurrencySelect } from '../../components/CurrencySelect'
import { Avatar, Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Section, Select, TextArea } from '../../components/ui'
import { currencyExponent, parseAmount } from '../../domain/money'
import { dateTime, minorToInput, money } from '../../lib/format'
import { newId } from '../../lib/ids'
import { type AppError, rpc, toAppError } from '../../lib/rpc'
import { isReversed, suggestions } from '../trip/derive'
import { useTripContext } from '../trip/TripLayout'
import type { Settlement, TripData } from '../trip/types'
import { personName } from '../trip/useTrip'
import { TransferRow } from './TransferRow'

export function BalancesPage() {
  const { t } = useTranslation()
  const { data } = useTripContext()
  const base = data.trip.base_currency
  const people = data.people.filter((p) => p.status !== 'removed')
  const pending = data.settlements.filter((s) => s.status === 'pending')
  const history = data.settlements.filter((s) => s.status !== 'pending')

  return (
    <div>
      <PageHeader title={t('balances.title')} subtitle={data.trip.title} back={`/trips/${data.trip.id}`} />

      <Section title={t('balances.perPerson')}>
        <ul className="flex flex-col gap-2">
          {people.map((p) => {
            const b = data.balances.get(p.id) ?? 0n
            return (
              <li key={p.id}>
                <Card className="flex items-center gap-3 py-3">
                  <Avatar name={p.display_name} id={p.id} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">
                      {p.display_name} {p.id === data.myPersonId && <span className="text-slate-500">({t('common.me')})</span>}
                    </p>
                    <p className="text-sm text-slate-500">
                      {b > 0n ? t('balances.getsBack') : b < 0n ? t('balances.stillOwes') : t('balances.settled')}
                      {p.status === 'placeholder' && ` · ${t('people.placeholder')}`}
                    </p>
                  </div>
                  <span className={`text-lg font-extrabold ${b < 0n ? 'text-red-700' : b > 0n ? 'text-brand-700' : 'text-slate-500'}`}>
                    {money(b, base, { signed: true })}
                  </span>
                </Card>
              </li>
            )
          })}
        </ul>
      </Section>

      <Section title={t('balances.suggestions')}>
        {suggestions(data).length === 0 ? (
          <Empty>{t('balances.allSettled')}</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {suggestions(data).map((s) => (
              <TransferRow key={`${s.fromPersonId}-${s.toPersonId}`} data={data} transfer={s} />
            ))}
          </ul>
        )}
        <p className="mt-2 rounded-xl bg-navy-50 p-3 text-sm text-navy-800">ℹ️ {t('balances.suggestionsInfo')}</p>
      </Section>

      <Section title={t('settlements.pending')}>
        {pending.length === 0 ? (
          <Empty>{t('settlements.nonePending')}</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {pending.map((s) => (
              <SettlementCard key={s.id} data={data} settlement={s} />
            ))}
          </ul>
        )}
      </Section>

      {data.trip.status === 'active' && data.myPersonId && <ReportForm data={data} />}

      <Section title={t('settlements.history')}>
        {history.length === 0 ? (
          <Empty>{t('settlements.noneHistory')}</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {history.map((s) => (
              <SettlementCard key={s.id} data={data} settlement={s} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function SettlementCard({ data, settlement: s }: { data: TripData; settlement: Settlement }) {
  const { t } = useTranslation()
  const { reload } = useTripContext()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [reversing, setReversing] = useState(false)
  const [reason, setReason] = useState('')
  const reversed = isReversed(data, s.id)
  const reversal = data.reversals.find((r) => r.settlement_id === s.id)
  const isReceiver = s.receiver_person_id === data.myPersonId
  const isSender = s.sender_person_id === data.myPersonId
  const active = data.trip.status === 'active'

  const act = async (fn: string, args: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await rpc(fn, args)
      await reload()
    } catch (e) {
      setError(toAppError(e))
    } finally {
      setBusy(false)
    }
  }

  const statusBadge = {
    pending: <Badge tone="amber">{t('settlements.status.pending')}</Badge>,
    confirmed: reversed ? <Badge tone="red">{t('settlements.status.reversed')}</Badge> : <Badge tone="green">{t('settlements.status.confirmed')}</Badge>,
    rejected: <Badge tone="red">{t('settlements.status.rejected')}</Badge>,
    withdrawn: <Badge>{t('settlements.status.withdrawn')}</Badge>,
  }[s.status]

  return (
    <li>
      <Card tone={s.status === 'pending' ? 'amber' : undefined}>
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-semibold">
              {personName(data, s.sender_person_id)} → {personName(data, s.receiver_person_id)}
            </p>
            <p className="text-lg font-bold">{money(s.original_minor, s.currency)}</p>
            {s.status === 'confirmed' && s.confirmed_base_minor !== null && (
              <p className="text-xs text-slate-600">
                {t('settlements.frozen', {
                  amount: money(s.confirmed_base_minor, s.confirmed_base_currency ?? data.trip.base_currency),
                  date: s.confirmed_at ? dateTime(s.confirmed_at) : '',
                })}
              </p>
            )}
            {s.note && <p className="mt-1 text-sm text-slate-600">„{s.note}“</p>}
            {reversal && <p className="mt-1 text-sm text-red-700">{t('settlements.reversalReason', { reason: reversal.reason })}</p>}
          </div>
          {statusBadge}
        </div>
        {s.status === 'pending' && isReceiver && active && (
          <p className="mt-2 text-sm text-amber-900">{t('settlements.confirmHint')}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {s.status === 'pending' && isReceiver && active && (
            <>
              <Button busy={busy} onClick={() => void act('confirm_settlement', { p_settlement_id: s.id })}>
                ✓ {t('settlements.confirm')}
              </Button>
              <Button variant="secondary" busy={busy} onClick={() => void act('reject_settlement', { p_settlement_id: s.id })}>
                {t('settlements.reject')}
              </Button>
            </>
          )}
          {s.status === 'pending' && isSender && active && (
            <Button variant="secondary" busy={busy} onClick={() => void act('withdraw_settlement', { p_settlement_id: s.id })}>
              {t('settlements.withdraw')}
            </Button>
          )}
          {s.status === 'confirmed' && !reversed && data.isAdmin && active && !reversing && (
            <Button variant="ghost" onClick={() => setReversing(true)}>
              {t('settlements.reverse')}
            </Button>
          )}
        </div>
        {reversing && (
          <form
            className="mt-3 flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void act('reverse_settlement', { p_settlement_id: s.id, p_reason: reason.trim() }).then(() => setReversing(false))
            }}
          >
            <p className="text-sm text-red-800">{t('settlements.reverseWarning')}</p>
            <Field label={t('settlements.reverseReason')} htmlFor={`reason-${s.id}`}>
              <TextArea id={`reason-${s.id}`} required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="danger" busy={busy} disabled={reason.trim().length < 3}>
                {t('settlements.reverseConfirm')}
              </Button>
              <Button variant="ghost" onClick={() => setReversing(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        )}
        <div className="mt-2">
          <ErrorBox error={error} />
        </div>
      </Card>
    </li>
  )
}

function ReportForm({ data }: { data: TripData }) {
  const { t } = useTranslation()
  const { reload } = useTripContext()
  const [params, setParams] = useSearchParams()
  const receivers = data.people.filter((p) => p.status === 'active' && p.id !== data.myPersonId)
  const [receiver, setReceiver] = useState(params.get('pay') ?? receivers[0]?.id ?? '')
  const [currency, setCurrency] = useState(data.trip.base_currency)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [done, setDone] = useState(false)
  const key = useMemo(() => ({ current: newId() }), [])

  useEffect(() => {
    const pay = params.get('pay')
    const prefill = params.get('amount')
    if (pay) setReceiver(pay)
    if (prefill && /^\d+$/.test(prefill)) {
      setCurrency(data.trip.base_currency)
      setAmount(minorToInput(BigInt(prefill), currencyExponent(data.trip.base_currency)))
    }
  }, [params, data.trip.base_currency])

  if (receivers.length === 0) return null

  const submit = async () => {
    setError(null)
    let minor: bigint
    try {
      minor = parseAmount(amount, currency)
    } catch (e) {
      setError(toAppError({ message: (e as { code?: string }).code ?? 'invalid_amount' }))
      return
    }
    setBusy(true)
    try {
      await rpc('report_settlement', {
        p_trip_id: data.trip.id,
        p_idempotency_key: key.current,
        p_receiver_person_id: receiver,
        p_currency: currency,
        p_original_minor: minor.toString(),
        p_note: note.trim() || null,
      })
      key.current = newId()
      setAmount('')
      setNote('')
      setDone(true)
      setParams({}, { replace: true })
      await reload()
    } catch (e) {
      setError(toAppError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={t('settlements.report')}>
      <Card>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <p className="text-sm text-slate-600">{t('settlements.reportIntro')}</p>
          <Field label={t('settlements.to')} htmlFor="settle-to">
            <Select id="settle-to" value={receiver} onChange={(e) => setReceiver(e.target.value)}>
              {receivers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-[1fr_8rem] gap-2">
            <Field label={t('expenses.amount')} htmlFor="settle-amount">
              <Input id="settle-amount" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label={t('expenses.currency')} htmlFor="settle-currency">
              <CurrencySelect id="settle-currency" value={currency} onChange={setCurrency} preferred={[data.trip.base_currency, ...data.rates.map((r) => r.currency)]} />
            </Field>
          </div>
          <Field label={t('expenses.note')} htmlFor="settle-note">
            <Input id="settle-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <ErrorBox error={error} />
          {done && <p className="text-sm text-brand-700">{t('settlements.reported')}</p>}
          <Button type="submit" busy={busy} disabled={!amount}>
            {t('settlements.reportSubmit')}
          </Button>
        </form>
      </Card>
    </Section>
  )
}
