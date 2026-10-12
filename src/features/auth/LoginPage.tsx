import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router'
import { rememberAfterLogin } from '../../app/afterLogin'
import { useAuth } from '../../app/auth'
import logo from '../../assets/logo.png'
import { LanguageSwitch } from '../../components/LanguageSwitch'
import { Button, Card, ErrorBox, Field, Input } from '../../components/ui'
import { type AppError, toAppError } from '../../lib/rpc'
import { devLoginEnabled, isConfigured, supabase } from '../../lib/supabase'

export function LoginPage() {
  const { t } = useTranslation()
  const { user, capabilities } = useAuth()
  const location = useLocation()
  const [error, setError] = useState<AppError | null>(null)
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const from = (location.state as { from?: string } | null)?.from ?? '/'

  if (user && !(capabilities?.is_anonymous ?? false)) return <Navigate to={from} replace />
  if (user && capabilities?.is_anonymous) return <Navigate to="/" replace />

  const google = async () => {
    setBusy(true)
    setError(null)
    // Only the path goes through Google and the redirect allowlist; a query (e.g. shared text) stays in this tab.
    const [path, query = ''] = from.split('?')
    if (query) rememberAfterLogin(from)
    const { error: e } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}${path}`, scopes: 'openid email profile' },
    })
    if (e) {
      setError(toAppError(e))
      setBusy(false)
    }
  }

  const devLogin = async () => {
    setBusy(true)
    setError(null)
    const { error: e } = await supabase.auth.signInWithPassword({ email, password })
    if (e) setError(toAppError({ message: 'login_failed' }))
    setBusy(false)
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-8">
      <div className="flex justify-end">
        <LanguageSwitch />
      </div>
      <img src={logo} alt="TravelSplit" className="mx-auto w-72" />
      <Card>
        <h1 className="mb-1 text-xl font-bold">{t('login.title')}</h1>
        <p className="mb-4 text-sm text-slate-600">{t('login.intro')}</p>
        {!isConfigured && <ErrorBox error={{ code: 'not_configured' }} />}
        <Button className="w-full" onClick={() => void google()} busy={busy} disabled={!isConfigured}>
          {t('login.google')}
        </Button>
        <p className="mt-4 text-sm text-slate-600">{t('login.guestHint')}</p>
        <ErrorBox error={error} />
      </Card>
      {devLoginEnabled && (
        <Card tone="amber">
          <h2 className="mb-2 font-bold">{t('login.devTitle')}</h2>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void devLogin()
            }}
          >
            <Field label={t('login.email')} htmlFor="dev-email">
              <Input id="dev-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t('login.password')} htmlFor="dev-password">
              <Input id="dev-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" variant="secondary" busy={busy}>
              {t('login.devSubmit')}
            </Button>
          </form>
        </Card>
      )}
    </div>
  )
}
