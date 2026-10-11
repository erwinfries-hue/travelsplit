import type { Session, User } from '@supabase/supabase-js'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { rpc } from '../lib/rpc'
import { supabase } from '../lib/supabase'

export interface Capabilities {
  can_create_trips: boolean
  is_anonymous: boolean
  has_google: boolean
}

interface AuthState {
  session: Session | null
  user: User | null
  ready: boolean
  capabilities: Capabilities | null
  refreshCapabilities: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      setReady(true)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const userId = session?.user.id
  // Re-read capabilities when a guest becomes a Google user (same id, new identity).
  const identityCount = session?.user.identities?.length ?? 0
  const refreshCapabilities = useCallback(async () => {
    if (!userId) {
      setCapabilities(null)
      return
    }
    try {
      setCapabilities(await rpc<Capabilities>('my_capabilities'))
    } catch {
      setCapabilities(null)
    }
  }, [userId, identityCount])

  useEffect(() => {
    void refreshCapabilities()
  }, [refreshCapabilities])

  const value = useMemo<AuthState>(
    () => ({
      session,
      user: session?.user ?? null,
      ready,
      capabilities,
      refreshCapabilities,
      signOut: async () => {
        await supabase.auth.signOut()
      },
    }),
    [session, ready, capabilities, refreshCapabilities],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
