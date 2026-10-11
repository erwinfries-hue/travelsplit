import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router'
import { CurrencySelect } from '../../components/CurrencySelect'
import { Button, Card, ErrorBox, Field, Input, PageHeader, Section, Select } from '../../components/ui'
import { money } from '../../lib/format'
import { type AppError, rpc, toAppError } from '../../lib/rpc'
import { useTripContext } from '../trip/TripLayout'

export function SettingsPage() {
  const { t } = useTranslation()
  const { data, reload } = useTripContext()
  const { trip } = data
  const [title, setTitle] = useState(trip.title)
  const [currency, setCurrency] = useState(trip.base_currency)
  const [start, setStart] = useState(trip.start_date ?? '')
  const [end, setEnd] = useState(trip.end_date ?? '')
  const [target, setTarget] = useState('')
  const [acceptOpen, setAcceptOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [saved, setSaved] = useState(false)

  if (!data.isAdmin) return <Navigate to={`/trips/${trip.id}`} replace />

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await fn()
      await reload()
      setSaved(true)
    } catch (e) {
      setError(toAppError(e))
    } finally {
      setBusy(false)
    }
  }

  const openBalances = [...data.balances.entries()].filter(([, v]) => v !== 0n)
  const pending = data.settlements.filter((s) => s.status === 'pending').length
  const candidates = data.people.filter((p) => p.status === 'active' && p.id !== data.myPersonId)

  return (
    <div>
      <PageHeader title={t('settings.title')} subtitle={trip.title} back={`/trips/${trip.id}`} />
      <ErrorBox error={error} />
      {saved && <p className="mb-2 text-sm text-brand-700">{t('common.saved')}</p>}

      {trip.status === 'active' && (
        <Section title={t('settings.details')}>
          <Card>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void act(() =>
                  rpc('update_trip', {
                    p_trip_id: trip.id,
                    p_expected_version: trip.version,
                    p_title: title.trim(),
                    p_base_currency: currency,
                    p_start_date: start || null,
                    p_end_date: end || null,
                  }),
                )
              }}
            >
              <Field label={t('trip.title')} htmlFor="set-title">
                <Input id="set-title" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
              </Field>
              <Field label={t('trip.baseCurrency')} hint={t('settings.baseCurrencyLock')} htmlFor="set-cur">
                <CurrencySelect id="set-cur" value={currency} onChange={setCurrency} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('trip.start')} htmlFor="set-start">
                  <Input id="set-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
                </Field>
                <Field label={t('trip.end')} htmlFor="set-end">
                  <Input id="set-end" type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
                </Field>
              </div>
              <Button type="submit" busy={busy}>
                {t('common.save')}
              </Button>
            </form>
          </Card>
        </Section>
      )}

      {trip.status === 'active' && (
        <Section title={t('settings.transferAdmin')}>
          <Card className="flex flex-col gap-3">
            <p className="text-sm text-slate-600">{t('settings.transferHint')}</p>
            {candidates.length === 0 ? (
              <p className="text-sm text-slate-500">{t('settings.noCandidates')}</p>
            ) : (
              <>
                <Select aria-label={t('settings.newAdmin')} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">{t('settings.chooseAdmin')}</option>
                  {candidates.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="secondary"
                  busy={busy}
                  disabled={!target}
                  onClick={() => void act(() => rpc('transfer_admin', { p_trip_id: trip.id, p_new_admin_person_id: target }))}
                >
                  {t('settings.transferButton')}
                </Button>
              </>
            )}
          </Card>
        </Section>
      )}

      <Section title={trip.status === 'active' ? t('settings.archive') : t('settings.reopen')}>
        {trip.status === 'active' ? (
          <Card tone={openBalances.length ? 'amber' : undefined} className="flex flex-col gap-3">
            <p className="text-sm">{t('settings.archiveHint')}</p>
            {pending > 0 && <p className="text-sm font-semibold text-red-700">{t('settings.pendingBlock', { count: pending })}</p>}
            {openBalances.length > 0 && (
              <>
                <p className="text-sm font-semibold text-amber-900">{t('settings.openBalances')}</p>
                <ul className="text-sm">
                  {openBalances.map(([id, v]) => (
                    <li key={id}>
                      {data.people.find((p) => p.id === id)?.display_name}: {money(v, trip.base_currency, { signed: true })}
                    </li>
                  ))}
                </ul>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-5 w-5" checked={acceptOpen} onChange={(e) => setAcceptOpen(e.target.checked)} />
                  {t('settings.acceptOpen')}
                </label>
              </>
            )}
            <Button
              variant="danger"
              busy={busy}
              disabled={pending > 0 || (openBalances.length > 0 && !acceptOpen)}
              onClick={() => void act(() => rpc('archive_trip', { p_trip_id: trip.id, p_accept_open_balances: acceptOpen }))}
            >
              {t('settings.archiveButton')}
            </Button>
          </Card>
        ) : (
          <Card className="flex flex-col gap-3">
            <p className="text-sm">{t('settings.reopenHint')}</p>
            <Button variant="secondary" busy={busy} onClick={() => void act(() => rpc('reopen_trip', { p_trip_id: trip.id }))}>
              {t('settings.reopenButton')}
            </Button>
          </Card>
        )}
      </Section>
    </div>
  )
}
