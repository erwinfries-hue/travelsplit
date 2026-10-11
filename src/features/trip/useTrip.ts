import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../app/auth'
import { AppError, rpc, toAppError } from '../../lib/rpc'
import { supabase } from '../../lib/supabase'
import type { BaseShare, Expense, Person, Rate, Receipt, Reversal, Settlement, Split, Trip, TripData } from './types'

async function must<T>(query: PromiseLike<{ data: T | null; error: unknown }>): Promise<T> {
  const { data, error } = await query
  if (error) throw toAppError(error)
  return data as T
}

export async function loadTrip(tripId: string, userId: string): Promise<TripData> {
  const trip = await must<Trip | null>(supabase.from('trips').select('*').eq('id', tripId).maybeSingle())
  if (!trip) throw new AppError('trip_not_found')
  const [people, rates, expenses, splits, baseShares, balanceRows, settlements, reversals, receipts] = await Promise.all([
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
    must<Receipt[]>(supabase.from('receipt_files').select('expense_id, storage_path, size_bytes, created_by').eq('trip_id', tripId)),
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
    receipts,
    myPersonId: me?.id ?? null,
    isAdmin: trip.admin_user_id === userId,
  }
}

// Last good copy per user and trip, so the trip (and the expense form) still opens without a connection.
// Removed on sign-out. Never used while the server is reachable.
export const TRIP_CACHE_PREFIX = 'travelsplit.trip.'
const cacheKey = (userId: string, tripId: string) => `${TRIP_CACHE_PREFIX}${userId}.${tripId}`

function writeCache(userId: string, data: TripData) {
  try {
    const json = JSON.stringify({ savedAt: new Date().toISOString(), data: { ...data, balances: [...data.balances].map(([k, v]) => [k, v.toString()]) } })
    localStorage.setItem(cacheKey(userId, data.trip.id), json)
  } catch {
    /* storage full or unavailable */
  }
}

function readCache(userId: string, tripId: string): { savedAt: string; data: TripData } | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId, tripId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { savedAt: string; data: Omit<TripData, 'balances'> & { balances: [string, string][] } }
    return { savedAt: parsed.savedAt, data: { ...parsed.data, balances: new Map(parsed.data.balances.map(([k, v]) => [k, BigInt(v)])) } }
  } catch {
    return null
  }
}

export function clearTripCache() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(TRIP_CACHE_PREFIX)) localStorage.removeItem(key)
  } catch {
    /* ignore */
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
  const [staleSince, setStaleSince] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reload = useCallback(async () => {
    if (!tripId || !user) return
    // Known offline: show the last copy at once instead of waiting for requests to time out.
    const offlineCopy = typeof navigator !== 'undefined' && !navigator.onLine ? readCache(user.id, tripId) : null
    if (offlineCopy) {
      setData((current) => current ?? offlineCopy.data)
      setStaleSince(offlineCopy.savedAt)
      setLoading(false)
      return
    }
    try {
      const fresh = await loadTrip(tripId, user.id)
      setData(fresh)
      setStaleSince(null)
      setError(null)
      writeCache(user.id, fresh)
    } catch (e) {
      const err = toAppError(e)
      const cached = err.code === 'network_error' ? readCache(user.id, tripId) : null
      if (cached) {
        setData((current) => current ?? cached.data)
        setStaleSince(cached.savedAt)
      } else {
        setError(err)
      }
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
    const onOnline = () => void reload()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
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

  return { data, error, loading, live, staleSince, reload }
}

export function personName(data: TripData, personId: string | null | undefined): string {
  return data.people.find((p) => p.id === personId)?.display_name ?? '?'
}
