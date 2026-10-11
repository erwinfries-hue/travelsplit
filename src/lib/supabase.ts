import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export const isConfigured = Boolean(url && key)

// Only the publishable key ships to the browser; every table is protected by RLS.
export const supabase = createClient(url ?? 'http://127.0.0.1:54321', key ?? 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
})

export const devLoginEnabled = import.meta.env.DEV && import.meta.env.VITE_DEV_LOGIN === 'true'
