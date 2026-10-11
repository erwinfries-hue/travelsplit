import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useParams } from 'react-router'
import { supabase } from '../lib/supabase'
import { useAuth } from './auth'

const LAST_TRIP_KEY = 'travelsplit.lastTrip'

export function rememberTrip(tripId: string) {
  try {
    localStorage.setItem(LAST_TRIP_KEY, tripId)
  } catch {
    /* ignore */
  }
}

function lastTrip(): string | null {
  try {
    return localStorage.getItem(LAST_TRIP_KEY)
  } catch {
    return null
  }
}

function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

function useUnreadNotices(): number {
  const { user } = useAuth()
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!user) return
    const load = async () => {
      const { count: c } = await supabase
        .from('in_app_notices')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .is('read_at', null)
      setCount(c ?? 0)
    }
    void load()
    const channel = supabase
      .channel(`notices-${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'in_app_notices', filter: `user_id=eq.${user.id}` }, () => void load())
      .subscribe()
    return () => void supabase.removeChannel(channel)
  }, [user])
  return count
}

export function Layout() {
  const { t } = useTranslation()
  const { tripId } = useParams()
  const online = useOnline()
  const unread = useUnreadNotices()
  const currentTrip = tripId ?? lastTrip()

  const tab = (to: string | null, icon: string, label: string, badge?: number) => {
    const base = 'relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold'
    if (!to) {
      return (
        <span className={`${base} text-slate-300`} aria-disabled>
          <span aria-hidden className="text-xl">{icon}</span>
          {label}
        </span>
      )
    }
    return (
      <NavLink to={to} end={to === '/'} className={({ isActive }) => `${base} ${isActive ? 'text-brand-600' : 'text-slate-500'}`}>
        <span aria-hidden className="text-xl">{icon}</span>
        {label}
        {badge ? (
          <span className="absolute top-1 right-1/4 rounded-full bg-red-600 px-1.5 text-[10px] text-white" aria-label={t('nav.unread', { count: badge })}>
            {badge}
          </span>
        ) : null}
      </NavLink>
    )
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col">
      {!online && (
        <div role="status" className="bg-amber-500 px-4 py-2 text-center text-sm font-semibold text-white">
          {t('common.offline')}
        </div>
      )}
      <main className="flex-1 px-4 pt-4 pb-28">
        <Outlet />
      </main>
      <nav
        aria-label={t('nav.main')}
        className="fixed inset-x-0 bottom-0 z-10 mx-auto flex max-w-xl border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)]"
      >
        {tab('/', '🧳', t('nav.trips'))}
        {tab(currentTrip ? `/trips/${currentTrip}/expenses` : null, '🧾', t('nav.expenses'))}
        {tab(currentTrip ? `/trips/${currentTrip}/balances` : null, '📊', t('nav.balances'))}
        {tab('/profile', '👤', t('nav.profile'), unread)}
      </nav>
    </div>
  )
}
