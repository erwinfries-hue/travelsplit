import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useOutletContext, useParams } from 'react-router'
import { rememberTrip } from '../../app/Layout'
import { ErrorBox, Loading } from '../../components/ui'
import { dateTime } from '../../lib/format'
import type { TripData } from './types'
import { useTrip } from './useTrip'

export interface TripContext {
  data: TripData
  live: boolean
  reload: () => Promise<void>
}

export function TripLayout() {
  const { tripId } = useParams()
  const { t } = useTranslation()
  const { data, error, loading, live, staleSince, reload } = useTrip(tripId)

  useEffect(() => {
    if (data) rememberTrip(data.trip.id)
  }, [data])

  if (loading && !data) return <Loading />
  if (error && !data) return <ErrorBox error={error} onRetry={() => void reload()} />
  if (!data) return null
  return (
    <>
      {staleSince && (
        <div role="status" className="mb-3 rounded-xl bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-900">
          {t('trip.offlineCopy', { date: dateTime(staleSince) })}
        </div>
      )}
      {data.trip.status === 'archived' && (
        <div className="mb-3 rounded-xl bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">{t('trip.archivedBanner')}</div>
      )}
      <Outlet context={{ data, live, reload } satisfies TripContext} />
    </>
  )
}

export function useTripContext(): TripContext {
  return useOutletContext<TripContext>()
}
