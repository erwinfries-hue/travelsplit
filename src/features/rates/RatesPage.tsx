import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CurrencySelect } from '../../components/CurrencySelect'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Section } from '../../components/ui'
import { parseRate, rateToString } from '../../domain/money'
import { date, money } from '../../lib/format'
import { type AppError, rpc, toAppError } from '../../lib/rpc'
import { currenciesUsed } from '../trip/derive'
import { useTripContext } from '../trip/TripLayout'
import type { Rate } from '../trip/types'
import { personName } from '../trip/useTrip'

interface PreviewRow {
  person_id: string
  current_minor: number
  new_minor: number
}

export function RatesPage() {
  const { t } = useTranslation()
  const { data } = useTripContext()
  const canEdit = data.isAdmin && data.trip.status === 'active'
  const used = currenciesUsed(data).filter((c) => c !== 'EUR')
  const missing = used.filter((c) => c !== data.trip.base_currency && !data.rates.some((r) => r.currency === c))
  const baseNeedsRate = data.trip.base_currency !== 'EUR'

  return (
    <div>
      <PageHeader title={t('rates.title')} subtitle={data.trip.title} back={`/trips/${data.trip.id}`} />
      <Card tone="blue" className="text-sm">
        <p>{t('rates.explain')}</p>
        {baseNeedsRate && <p className="mt-1">{t('rates.baseNotEur', { base: data.trip.base_currency })}</p>}
      </Card>
      {missing.length > 0 && (
        <Card tone="red" className="mt-3 text-sm">
          {t('trip.missingRates', { currencies: missing.join(', ') })}
        </Card>
      )}
      <Section title={t('rates.current')}>
        {data.rates.length === 0 ? (
          <Empty>{t('rates.none')}</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.rates.map((r) => (
              <RateRow key={r.currency} rate={r} canEdit={canEdit} />
            ))}
          </ul>
        )}
      </Section>
      {canEdit && <NewRate existing={data.rates.map((r) => r.currency)} />}
    </div>
  )
}

function RateRow({ rate, canEdit }: { rate: Rate; canEdit: boolean }) {
  const { t } = useTranslation()
  const { data, reload } = useTripContext()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(rateToString(parseRate(rate.eur_per_unit)))
  const [preview, setPreview] = useState<PreviewRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const normalized = () => rateToString(parseRate(value))

  const showPreview = async () => {
    setError(null)
    try {
      setBusy(true)
      setPreview(await rpc<PreviewRow[]>('preview_fx_change', { p_trip_id: data.trip.id, p_currency: rate.currency, p_eur_per_unit: normalized() }))
    } catch (e) {
      setError(toAppError(e instanceof Error && 'code' in e ? { message: (e as { code: string }).code } : e))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await rpc('set_fx_rate', { p_trip_id: data.trip.id, p_currency: rate.currency, p_eur_per_unit: normalized(), p_expected_revision: rate.revision })
      setEditing(false)
      setPreview(null)
      await reload()
    } catch (e) {
      setError(toAppError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li>
      <Card>
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-lg font-bold">
              1 {rate.currency} = {rateToString(parseRate(rate.eur_per_unit)).replace('.', t('common.decimalSep'))} EUR
            </p>
            <p className="text-xs text-slate-500">
              {t('rates.manual')} · {t('rates.revision', { n: rate.revision })} · {date(rate.updated_at)}
            </p>
          </div>
          {canEdit && !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {t('common.edit')}
            </Button>
          )}
        </div>
        {editing && (
          <div className="mt-3 flex flex-col gap-3">
            <Field label={t('rates.newValue', { currency: rate.currency })} htmlFor={`rate-${rate.currency}`}>
              <Input id={`rate-${rate.currency}`} inputMode="decimal" value={value} onChange={(e) => { setValue(e.target.value); setPreview(null) }} />
            </Field>
            {!preview ? (
              <Button variant="secondary" busy={busy} onClick={() => void showPreview()}>
                {t('rates.previewButton')}
              </Button>
            ) : (
              <div className="flex flex-col gap-2 rounded-xl bg-amber-50 p-3 text-sm">
                <p className="font-semibold text-amber-900">{t('rates.changeWarning')}</p>
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-xs text-slate-500">
                      <th>{t('people.name')}</th>
                      <th className="text-right">{t('rates.before')}</th>
                      <th className="text-right">{t('rates.after')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((p) => (
                      <tr key={p.person_id}>
                        <td>{personName(data, p.person_id)}</td>
                        <td className="text-right">{money(p.current_minor, data.trip.base_currency, { signed: true })}</td>
                        <td className="text-right font-semibold">{money(p.new_minor, data.trip.base_currency, { signed: true })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex gap-2">
                  <Button busy={busy} onClick={() => void save()}>
                    {t('rates.confirmChange')}
                  </Button>
                  <Button variant="ghost" onClick={() => { setEditing(false); setPreview(null) }}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            )}
            <ErrorBox error={error} />
          </div>
        )}
      </Card>
    </li>
  )
}

function NewRate({ existing }: { existing: string[] }) {
  const { t } = useTranslation()
  const { data, reload } = useTripContext()
  const suggestions = currenciesUsed(data).filter((c) => c !== 'EUR' && !existing.includes(c))
  const [currency, setCurrency] = useState(suggestions[0] ?? (data.trip.base_currency !== 'EUR' && !existing.includes(data.trip.base_currency) ? data.trip.base_currency : 'CHF'))
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const save = async () => {
    setError(null)
    let normalized: string
    try {
      normalized = rateToString(parseRate(value))
    } catch (e) {
      setError(toAppError({ message: (e as { code?: string }).code ?? 'invalid_rate' }))
      return
    }
    setBusy(true)
    try {
      await rpc('set_fx_rate', { p_trip_id: data.trip.id, p_currency: currency, p_eur_per_unit: normalized })
      setValue('')
      await reload()
    } catch (e) {
      setError(toAppError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={t('rates.add')}>
      <Card>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="grid grid-cols-[8rem_1fr] items-end gap-2">
            <Field label={t('expenses.currency')} htmlFor="new-rate-cur">
              <CurrencySelect id="new-rate-cur" value={currency} onChange={setCurrency} preferred={suggestions} />
            </Field>
            <Field label={t('rates.eurPerUnit', { currency })} htmlFor="new-rate-val">
              <Input id="new-rate-val" inputMode="decimal" required placeholder="0,34" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
          </div>
          {existing.includes(currency) && <Badge tone="amber">{t('rates.alreadySet')}</Badge>}
          <p className="text-xs text-slate-500">{t('rates.noLiveRates')}</p>
          <ErrorBox error={error} />
          <Button type="submit" busy={busy} disabled={!value || existing.includes(currency) || currency === 'EUR'}>
            {t('rates.setButton')}
          </Button>
        </form>
      </Card>
    </Section>
  )
}
