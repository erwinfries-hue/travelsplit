import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate } from 'react-router'
import { useAuth } from '../../app/auth'
import { CurrencySelect } from '../../components/CurrencySelect'
import { Button, Card, ErrorBox, Field, Input, PageHeader } from '../../components/ui'
import { type AppError, rpc, toAppError } from '../../lib/rpc'

export function NewTripPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user, capabilities } = useAuth()
  const meta = user?.user_metadata as { full_name?: string; name?: string } | undefined
  const [title, setTitle] = useState('')
  const [currency, setCurrency] = useState('EUR')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [myName, setMyName] = useState(meta?.full_name ?? meta?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  if (capabilities && !capabilities.can_create_trips) return <Navigate to="/" replace />

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const id = await rpc<string>('create_trip', {
        p_title: title.trim(),
        p_base_currency: currency,
        p_admin_display_name: myName.trim(),
        p_start_date: start || null,
        p_end_date: end || null,
      })
      navigate(`/trips/${id}`, { replace: true })
    } catch (e) {
      setError(toAppError(e))
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader title={t('trips.new')} back="/" />
      <Card>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field label={t('trip.title')} htmlFor="trip-title">
            <Input id="trip-title" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('trip.titlePlaceholder')} />
          </Field>
          <Field label={t('trip.baseCurrency')} hint={t('trip.baseCurrencyHint')} htmlFor="trip-currency">
            <CurrencySelect id="trip-currency" value={currency} onChange={setCurrency} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('trip.start')} htmlFor="trip-start">
              <Input id="trip-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Field>
            <Field label={t('trip.end')} htmlFor="trip-end">
              <Input id="trip-end" type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
            </Field>
          </div>
          <Field label={t('trip.myName')} htmlFor="trip-myname">
            <Input id="trip-myname" required maxLength={60} value={myName} onChange={(e) => setMyName(e.target.value)} />
          </Field>
          <ErrorBox error={error} />
          <Button type="submit" busy={busy} disabled={!title.trim() || !myName.trim()}>
            {t('trips.create')}
          </Button>
        </form>
      </Card>
    </div>
  )
}
