import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Button, Card, ErrorBox, Field, Input, Section } from '../../components/ui'
import { type AppError, rpc, toAppError } from '../../lib/rpc'
import { supabase } from '../../lib/supabase'
import type { Trip } from '../trip/types'

/** OPS-03: permanent deletion of an archived trip, photos first, then all data. */
export function DeleteTripSection({ trip }: { trip: Trip }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      const paths = await rpc<string[]>('request_trip_deletion', { p_trip_id: trip.id, p_confirm_title: confirm })
      for (let i = 0; i < paths.length; i += 500) {
        const { error: e } = await supabase.storage.from('receipts').remove(paths.slice(i, i + 500))
        if (e) throw toAppError(e)
      }
      await rpc('delete_trip', { p_trip_id: trip.id })
      navigate('/', { replace: true })
    } catch (e) {
      setError(toAppError(e))
      setBusy(false)
    }
  }

  return (
    <Section title={t('deletion.title')}>
      <Card tone="red" className="flex flex-col gap-3 text-sm">
        <p>{t('deletion.warning')}</p>
        <p className="font-semibold">{t('deletion.exportFirst')}</p>
        <Field label={t('deletion.typeTitle', { title: trip.title })} htmlFor="delete-confirm">
          <Input id="delete-confirm" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button variant="danger" busy={busy} disabled={confirm !== trip.title} onClick={() => void remove()}>
          {t('deletion.button')}
        </Button>
        <ErrorBox error={error} />
      </Card>
    </Section>
  )
}
