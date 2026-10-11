import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useAuth } from '../../app/auth'
import logo from '../../assets/logo.png'
import { LanguageSwitch } from '../../components/LanguageSwitch'
import { Button, Card, ErrorBox, Field, Input } from '../../components/ui'
import { type AppError, rpc, toAppError } from '../../lib/rpc'
import { supabase } from '../../lib/supabase'

const TOKEN_KEY = 'travelsplit.pendingInvite'

/** The token travels in the URL fragment (#…), which browsers never send to the server. */
function readToken(): string | null {
  const fromHash = window.location.hash.replace(/^#/, '')
  if (/^[A-Za-z0-9_-]{43}$/.test(fromHash)) {
    sessionStorage.setItem(TOKEN_KEY, fromHash)
    history.replaceState(null, '', window.location.pathname)
    return fromHash
  }
  return sessionStorage.getItem(TOKEN_KEY)
}

export function JoinPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user, capabilities, refreshCapabilities } = useAuth()
  const [token] = useState(readToken)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [guestAck, setGuestAck] = useState(false)

  useEffect(() => {
    const meta = user?.user_metadata as { full_name?: string; name?: string } | undefined
    if (!name && meta) setName(meta.full_name ?? meta.name ?? '')
  }, [user, name])

  if (!token) {
    return (
      <Shell>
        <ErrorBox error={{ code: 'invitation_invalid' }} />
      </Shell>
    )
  }

  const joinAsGuest = async () => {
    setBusy(true)
    setError(null)
    const { error: e } = await supabase.auth.signInAnonymously()
    if (e) setError(toAppError(e))
    await refreshCapabilities()
    setBusy(false)
  }

  const joinWithGoogle = async () => {
    setBusy(true)
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/join`, scopes: 'openid email profile' },
    })
  }

  const redeem = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await rpc<{ status: string; trip_id?: string; trip_title: string }>('redeem_invitation', {
        p_token: token,
        p_display_name: name.trim(),
      })
      sessionStorage.removeItem(TOKEN_KEY)
      if (result.status === 'joined' && result.trip_id) navigate(`/trips/${result.trip_id}`, { replace: true })
      else setPending(result.trip_title)
    } catch (e) {
      const err = toAppError(e)
      if (['invitation_used', 'invitation_revoked', 'invitation_expired', 'invitation_invalid'].includes(err.code)) {
        sessionStorage.removeItem(TOKEN_KEY)
      }
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (pending) {
    return (
      <Shell>
        <Card tone="amber">
          <h1 className="mb-2 text-lg font-bold">{t('join.pendingTitle')}</h1>
          <p>{t('join.pendingText', { trip: pending })}</p>
        </Card>
        <Button variant="secondary" onClick={() => navigate('/')}>
          {t('join.toTrips')}
        </Button>
      </Shell>
    )
  }

  return (
    <Shell>
      <Card>
        <h1 className="mb-2 text-xl font-bold">{t('join.title')}</h1>
        {!user ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-600">{t('join.chooseHow')}</p>
            <Button onClick={() => void joinWithGoogle()} busy={busy}>
              {t('join.withGoogle')}
            </Button>
            <div className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
              <p className="font-semibold">{t('join.guestWarningTitle')}</p>
              <p>{t('join.guestWarning')}</p>
              <label className="mt-2 flex items-center gap-2">
                <input type="checkbox" className="h-5 w-5" checked={guestAck} onChange={(e) => setGuestAck(e.target.checked)} />
                {t('join.guestAck')}
              </label>
            </div>
            <Button variant="secondary" onClick={() => void joinAsGuest()} busy={busy} disabled={!guestAck}>
              {t('join.asGuest')}
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void redeem()
            }}
          >
            {capabilities?.is_anonymous && <p className="text-sm text-amber-800">{t('join.guestWarning')}</p>}
            <Field label={t('join.yourName')} htmlFor="join-name">
              <Input id="join-name" value={name} maxLength={60} required onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button type="submit" busy={busy} disabled={!name.trim()}>
              {t('join.submit')}
            </Button>
          </form>
        )}
        <div className="mt-3">
          <ErrorBox error={error} />
        </div>
      </Card>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-8">
      <div className="flex justify-end">
        <LanguageSwitch />
      </div>
      <img src={logo} alt="TravelSplit" className="mx-auto w-64" />
      {children}
    </div>
  )
}
