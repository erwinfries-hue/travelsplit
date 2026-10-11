import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useAuth } from '../../app/auth'
import logo from '../../assets/logo.png'
import { Avatar, Badge, Card, Empty, ErrorBox, LinkButton, Loading, Section } from '../../components/ui'
import { dateRange, money } from '../../lib/format'
import { type AppError, rpc, toAppError } from '../../lib/rpc'
import { supabase } from '../../lib/supabase'
import type { Person, Trip } from '../trip/types'

interface TripRow {
  trip: Trip
  people: Person[]
  myBalance: bigint | null
}

interface Claim {
  id: string
  claimant_display_name: string
  status: string
  trips: { title: string } | null
}

export function TripsPage() {
  const { t } = useTranslation()
  const { user, capabilities } = useAuth()
  const [rows, setRows] = useState<TripRow[] | null>(null)
  const [claims, setClaims] = useState<Claim[]>([])
  const [error, setError] = useState<AppError | null>(null)

  const load = useCallback(async () => {
    if (!user) return
    try {
      const { data: trips, error: e1 } = await supabase.from('trips').select('*').order('created_at', { ascending: false })
      if (e1) throw e1
      const { data: people, error: e2 } = await supabase.from('trip_people').select('id, trip_id, display_name, linked_user_id, status')
      if (e2) throw e2
      const result = await Promise.all(
        (trips as Trip[]).map(async (trip) => {
          const tripPeople = (people as (Person & { trip_id: string })[]).filter((p) => p.trip_id === trip.id)
          const me = tripPeople.find((p) => p.linked_user_id === user.id)
          let myBalance: bigint | null = null
          try {
            const balances = await rpc<{ person_id: string; balance_minor: number }[]>('trip_balances', { p_trip_id: trip.id })
            const mine = balances.find((b) => b.person_id === me?.id)
            myBalance = mine ? BigInt(mine.balance_minor) : null
          } catch {
            myBalance = null
          }
          return { trip, people: tripPeople, myBalance }
        }),
      )
      setRows(result)
      const { data: claimRows } = await supabase
        .from('membership_claims')
        .select('id, claimant_display_name, status, trips(title)')
        .eq('claimant_user_id', user.id)
        .eq('status', 'pending_admin_approval')
      setClaims((claimRows ?? []) as unknown as Claim[])
      setError(null)
    } catch (e) {
      setError(toAppError(e))
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const active = rows?.filter((r) => r.trip.status === 'active') ?? []
  const archived = rows?.filter((r) => r.trip.status === 'archived') ?? []

  return (
    <div>
      <header className="mb-2 flex items-center justify-between">
        <img src={logo} alt="TravelSplit" className="h-12" />
      </header>
      <ErrorBox error={error} onRetry={() => void load()} />
      {capabilities?.is_anonymous && (
        <Card tone="amber" className="mt-2 text-sm">
          {t('profile.guestWarning')}
        </Card>
      )}
      {claims.map((c) => (
        <Card key={c.id} tone="amber" className="mt-3 text-sm">
          {t('trips.claimPending', { trip: c.trips?.title ?? '' })}
        </Card>
      ))}
      {!rows && !error ? (
        <Loading />
      ) : (
        <>
          <Section title={t('trips.active')} action={<Badge tone="blue">{t('trips.count', { count: active.length })}</Badge>}>
            {active.length === 0 ? <Empty>{t('trips.noneActive')}</Empty> : <TripList rows={active} />}
          </Section>
          {archived.length > 0 && (
            <Section title={t('trips.archived')} action={<Badge>{t('trips.count', { count: archived.length })}</Badge>}>
              <TripList rows={archived} />
            </Section>
          )}
        </>
      )}
      {capabilities?.can_create_trips && (
        <LinkButton to="/trips/new" className="mt-6 w-full">
          ＋ {t('trips.new')}
        </LinkButton>
      )}
    </div>
  )
}

function TripList({ rows }: { rows: TripRow[] }) {
  const { t } = useTranslation()
  return (
    <ul className="flex flex-col gap-3">
      {rows.map(({ trip, people, myBalance }) => {
        const members = people.filter((p) => p.status !== 'removed')
        return (
          <li key={trip.id}>
            <Link to={`/trips/${trip.id}`} className="block">
              <Card className="hover:border-brand-500">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-lg font-bold">{trip.title}</h3>
                    <p className="text-sm text-slate-500">{dateRange(trip.start_date, trip.end_date)}</p>
                  </div>
                  <span aria-hidden className="text-2xl text-slate-400">›</span>
                </div>
                <div className="mt-2 flex items-center gap-1">
                  {members.slice(0, 5).map((p) => (
                    <Avatar key={p.id} name={p.display_name} id={p.id} size="sm" />
                  ))}
                  <span className="ml-2 text-sm text-slate-500">{t('trips.participants', { count: members.length })}</span>
                </div>
                {myBalance !== null && (
                  <div className={`mt-3 flex items-center justify-between rounded-xl px-3 py-2 ${myBalance === 0n ? 'bg-slate-100' : 'bg-brand-50'}`}>
                    <span className="text-sm">{myBalance === 0n ? t('balances.settled') : t('trips.openBalance')}</span>
                    <span className={`font-bold ${myBalance < 0n ? 'text-red-700' : myBalance > 0n ? 'text-brand-700' : ''}`}>
                      {money(myBalance, trip.base_currency, { signed: true })}
                    </span>
                  </div>
                )}
              </Card>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
