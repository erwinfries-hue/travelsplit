import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useAuth } from '../../app/auth'
import { LanguageSwitch } from '../../components/LanguageSwitch'
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Section } from '../../components/ui'
import { dateTime } from '../../lib/format'
import { isStandalone, useInstallPrompt } from '../../lib/install'
import { type AppError, rpc, toAppError } from '../../lib/rpc'
import { supabase } from '../../lib/supabase'

interface Notice {
  id: string
  trip_id: string | null
  kind: string
  payload: Record<string, unknown>
  created_at: string
  read_at: string | null
  trips: { title: string } | null
}

export function ProfilePage() {
  const { t, i18n } = useTranslation()
  const { user, capabilities, signOut } = useAuth()
  const [name, setName] = useState('')
  const [notices, setNotices] = useState<Notice[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const [saved, setSaved] = useState(false)
  const install = useInstallPrompt()
  const [linkError, setLinkError] = useState<AppError | null>(null)

  const load = useCallback(async () => {
    if (!user) return
    const [{ data: profile }, { data: rows }] = await Promise.all([
      supabase.from('profiles').select('display_name').eq('user_id', user.id).maybeSingle(),
      supabase.from('in_app_notices').select('*, trips(title)').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
    ])
    if (profile) setName(profile.display_name)
    setNotices((rows ?? []) as Notice[])
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await rpc('upsert_my_profile', { p_display_name: name.trim(), p_locale: i18n.language === 'en' ? 'en' : 'de' })
      setSaved(true)
    } catch (e) {
      setError(toAppError(e))
    } finally {
      setBusy(false)
    }
  }

  // Guest → Google upgrade (R6): links a Google identity to the SAME user, so memberships stay.
  const linkGoogle = async () => {
    setBusy(true)
    setLinkError(null)
    const { error: e } = await supabase.auth.linkIdentity({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/profile`, scopes: 'openid email profile' },
    })
    if (e) {
      setLinkError(toAppError({ message: /already|exists/i.test(e.message) ? 'google_already_used' : 'link_failed' }))
      setBusy(false)
    }
  }

  const unread = notices.filter((n) => !n.read_at).map((n) => n.id)
  const markRead = async () => {
    await rpc('mark_notices_read', { p_ids: unread })
    await load()
  }

  return (
    <div>
      <PageHeader title={t('profile.title')} />
      {capabilities?.is_anonymous && (
        <Card tone="amber" className="mb-3 text-sm">
          <p className="font-semibold">{t('join.guestWarningTitle')}</p>
          <p>{t('profile.guestWarning')}</p>
          <p className="mt-2">{t('profile.upgradeHint')}</p>
          <Button className="mt-3 w-full" onClick={() => void linkGoogle()} busy={busy}>
            {t('profile.upgradeGoogle')}
          </Button>
          <ErrorBox error={linkError} />
        </Card>
      )}

      <Section
        title={t('profile.notices')}
        action={
          unread.length > 0 ? (
            <button type="button" className="text-sm font-semibold text-navy-600 underline" onClick={() => void markRead()}>
              {t('profile.markRead')}
            </button>
          ) : null
        }
      >
        {notices.length === 0 ? (
          <Empty>{t('profile.noNotices')}</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {notices.map((n) => (
              <li key={n.id}>
                <Link to={n.trip_id ? `/trips/${n.trip_id}` : '/'}>
                  <Card tone={n.read_at ? undefined : 'blue'} className="py-3 text-sm">
                    <p className="font-semibold">
                      {t(`notices.${n.kind}`, { ...n.payload, defaultValue: n.kind })} {!n.read_at && <Badge tone="blue">{t('profile.new')}</Badge>}
                    </p>
                    <p className="text-xs text-slate-500">
                      {n.trips?.title ? `${n.trips.title} · ` : ''}
                      {dateTime(n.created_at)}
                    </p>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('profile.settings')}>
        <Card className="flex flex-col gap-3">
          <Field label={t('profile.language')}>
            <LanguageSwitch />
          </Field>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <Field label={t('profile.displayName')} htmlFor="profile-name">
              <Input id="profile-name" maxLength={60} required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <ErrorBox error={error} />
            {saved && <p className="text-sm text-brand-700">{t('common.saved')}</p>}
            <Button type="submit" variant="secondary" busy={busy}>
              {t('common.save')}
            </Button>
          </form>
          <p className="text-xs text-slate-500">
            {capabilities?.is_anonymous ? t('profile.accountGuest') : t('profile.accountGoogle', { email: user?.email ?? '' })}
            {capabilities?.can_create_trips && ` · ${t('profile.creator')}`}
          </p>
        </Card>
      </Section>

      {!isStandalone() && (
        <Section title={t('profile.install')}>
          <Card className="flex flex-col gap-2 text-sm">
            {install && <Button onClick={() => void install()}>📲 {t('profile.installNow')}</Button>}
            <p>{t('profile.installAndroid')}</p>
            <p>{t('profile.installIos')}</p>
          </Card>
        </Section>
      )}

      <Button variant="ghost" className="mt-6 w-full text-red-700" onClick={() => void signOut()}>
        {capabilities?.is_anonymous ? t('profile.signOutGuest') : t('profile.signOut')}
      </Button>
    </div>
  )
}
