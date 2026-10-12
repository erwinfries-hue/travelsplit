import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useSearchParams } from 'react-router'
import { useAuth } from '../../app/auth'
import { Card, Empty, ErrorBox, Loading, PageHeader } from '../../components/ui'
import { parseEntry } from '../../domain/ingest/parse'
import { type AppError, toAppError } from '../../lib/rpc'
import { supabase } from '../../lib/supabase'
import type { Trip } from '../trip/types'

/** Text shared from another app (Android share sheet). Shared text is capped like a quick entry. */
export function sharedText(params: URLSearchParams): string {
  const text = params.get('text')?.trim() || params.get('title')?.trim() || ''
  return text.slice(0, 300)
}

/**
 * Target of the PWA Web Share Target: picks the trip, then hands the text to that trip's quick entry.
 * The expense is only saved after the normal form was reviewed.
 */
export function SharePage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [params] = useSearchParams()
  const text = sharedText(params)
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const [error, setError] = useState<AppError | null>(null)

  useEffect(() => {
    if (!user) return
    void (async () => {
      try {
        const { data: mine, error: e1 } = await supabase.from('trip_people').select('trip_id').eq('linked_user_id', user.id).eq('status', 'active')
        if (e1) throw e1
        const ids = (mine ?? []).map((r) => r.trip_id as string)
        if (ids.length === 0) return setTrips([])
        const { data, error: e2 } = await supabase.from('trips').select('*').in('id', ids).eq('status', 'active').order('created_at', { ascending: false })
        if (e2) throw e2
        setTrips(data as Trip[])
      } catch (e) {
        setError(toAppError(e))
      }
    })()
  }, [user])

  if (error) return <ErrorBox error={error} />
  if (!trips) return <Loading />
  const target = (trip: Trip) => `/trips/${trip.id}?${new URLSearchParams({ quick: text })}`
  const parsed = parseEntry(text)
  const code = parsed.ok ? parsed.entry.tripCode : null
  const byCode = code ? trips.filter((tr) => tr.trip_code?.toUpperCase() === code) : []
  if (byCode.length === 1) return <Navigate to={target(byCode[0])} replace />
  if (trips.length === 1) return <Navigate to={target(trips[0])} replace />

  return (
    <div>
      <PageHeader title={t('quick.shareTitle')} back="/" />
      <Card className="mb-4 text-sm break-words whitespace-pre-wrap">{text || '–'}</Card>
      {trips.length === 0 ? (
        <Empty>{t('quick.noActiveTrip')}</Empty>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('quick.pickTrip')}>
          {trips.map((trip) => (
            <li key={trip.id}>
              <Link to={target(trip)}>
                <Card className="font-semibold">{trip.title} ›</Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
