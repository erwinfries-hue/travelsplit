import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../app/auth'
import { AppError, rpc, toAppError } from '../../lib/rpc'
import { supabase } from '../../lib/supabase'
import type { BaseShare, Expense, Person, Rate, Reversal, Settlement, Split, Trip, TripData } from './types'

async function must<T>(query: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await query
  if (error) throw toAppError(error)
  return data as T
}

export async function loadTrip(tripId: string, userId: string): Promise<TripData> {
  const trip = await must<Trip | null>(supabase.from('trips').select('*').eq('id', tripId).maybeSingle())
  if (!trip) throw new AppError('trip_not_found')
  const [people, rates, expenses, splits, baseShares, balanceRows, settlements, reversals] = await Promise.all([
    must<Person[]>(supabase.from('trip_people').select('id, display_name, linked_user_id, status').eq('trip_id', tripId).order('created_at')),
    must<Rate[]>(supabase.from('trip_fx_rates').select('currency, eur_per_unit::text, revision, rate_date, updated_at').eq('trip_id', tripId).order('currency')),
    must<Expense[]>(supabase.from('expenses').select('*').eq('trip_id', tripId).order('expense_date', { ascending: false }).order('created_at', { ascending: false })),
    must<Split[]>(supabase.from('expense_splits').select('expense_id, person_id, original_minor, input_value').eq('trip_id', tripId)),
    rpc<BaseShare[]>('expense_base_shares', { p_trip_id: tripId }),
    rpc<{ person_id: string; balance_minor: number }[]>('trip_balances', { p_trip_id: tripId }),
    must<Settlement[]>(
      supabase
        .from('settlements')
        .select('*, confirmed_from_rate::text, confirmed_base_rate::text')
        .eq('trip_id', tripId)
        .order('created_at', { ascending: false }),
    ),
    must<Reversal[]>(supabase.from('settlement_reversals').select('id, settlement_id, reason, reversed_base_minor, created_at').eq('trip_id', tripId)),
  ])
  const me = people.find((p) => p.linked_user_id === userId && p.status === 'active')
  return {
    trip,
    people,
    rates,
    expenses,
    splits,
    baseShares,
    balances: new Map(balanceRows.map((b) => [b.person_id, BigInt(b.balance_minor)])),
    settlements,
    reversals,
    myPersonId: me?.id ?? null,
    isAdmin: trip.admin_user_id === userId,
  }
}

const REALTIME_TABLES = ['trips', 'trip_people', 'trip_fx_rates', 'expenses', 'settlements', 'settlement_reversals'] as const

/** Trip data with live refresh: realtime events are only a "changed" signal, data is re-read through RLS. */
export function useTrip(tripId: string | undefined) {
  const { user } = useAuth()
  const [data, setData] = useState<TripData | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reload = useCallback(async () => {
    if (!tripId || !user) return
    try {
      setData(await loadTrip(tripId, user.id))
      setError(null)
    } catch (e) {
      setError(toAppError(e))
    } finally {
      setLoading(false)
    }
  }, [tripId, user])

  useEffect(() => {
    setLoading(true)
    setData(null)
    void reload()
  }, [reload])

  useEffect(() => {
    if (!tripId || !user || data?.trip.status !== 'active') return
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void reload(), 300)
    }
    let channel = supabase.channel(`trip-${tripId}`)
    for (const table of REALTIME_TABLES) {
      const filter = table === 'trips' ? `id=eq.${tripId}` : `trip_id=eq.${tripId}`
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table, filter }, schedule)
    }
    channel.subscribe((status) => setLive(status === 'SUBSCRIBED'))
    return () => {
      setLive(false)
      if (timer.current) clearTimeout(timer.current)
      void supabase.removeChannel(channel)
    }
    // Only resubscribe when the trip or its status changes.
  }, [tripId, user, data?.trip.status, reload])

  return { data, error, loading, live, reload }
}

export function personName(data: TripData, personId: string | null | undefined): string {
  return data.people.find((p) => p.id === personId)?.display_name ?? '?'
}
