import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Avatar, Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Section } from '../../components/ui'
import { dateTime } from '../../lib/format'
import { type AppError, rpc, toAppError } from '../../lib/rpc'
import { supabase } from '../../lib/supabase'
import { useTripContext } from '../trip/TripLayout'
import type { Person } from '../trip/types'
import { personName } from '../trip/useTrip'

interface Invitation {
  id: string
  target_person_id: string
  expires_at: string
  consumed_at: string | null
  revoked_at: string | null
  created_at: string
}

interface Claim {
  id: string
  person_id: string
  claimant_display_name: string
  status: string
  created_at: string
}

export function PeoplePage() {
  const { t } = useTranslation()
  const { data, reload } = useTripContext()
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [claims, setClaims] = useState<Claim[]>([])
  const [newName, setNewName] = useState('')
  const [links, setLinks] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)
  const active = data.trip.status === 'active'

  const loadAdminData = useCallback(async () => {
    if (!data.isAdmin) return
    const [inv, cl] = await Promise.all([
      supabase.from('trip_invitations').select('*').eq('trip_id', data.trip.id).order('created_at', { ascending: false }),
      supabase.from('membership_claims').select('*').eq('trip_id', data.trip.id).eq('status', 'pending_admin_approval'),
    ])
    setInvitations((inv.data ?? []) as Invitation[])
    setClaims((cl.data ?? []) as Claim[])
  }, [data.isAdmin, data.trip.id])

  useEffect(() => {
    void loadAdminData()
  }, [loadAdminData, data.people])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await reload()
      await loadAdminData()
    } catch (e) {
      setError(toAppError(e))
    } finally {
      setBusy(false)
    }
  }

  const invite = (person: Person) =>
    act(async () => {
      const res = await rpc<{ token: string }>('create_invitation', { p_person_id: person.id })
      setLinks((l) => ({ ...l, [person.id]: `${window.location.origin}/join#${res.token}` }))
    })

  const share = async (person: Person, link: string) => {
    const text = t('people.inviteMessage', { name: person.display_name, trip: data.trip.title, link })
    if (navigator.share) {
      try {
        await navigator.share({ text })
        return
      } catch {
        /* cancelled: fall back to copy */
      }
    }
    await navigator.clipboard.writeText(text)
  }

  const openInvitation = (personId: string) =>
    invitations.find((i) => i.target_person_id === personId && !i.consumed_at && !i.revoked_at && new Date(i.expires_at) > new Date())

  return (
    <div>
      <PageHeader title={t('people.title')} subtitle={data.trip.title} back={`/trips/${data.trip.id}`} />
      <ErrorBox error={error} />

      {data.isAdmin && claims.length > 0 && (
        <Section title={t('people.claims')}>
          <ul className="flex flex-col gap-2">
            {claims.map((c) => (
              <li key={c.id}>
                <Card tone="amber" className="flex flex-col gap-2">
                  <p className="text-sm">
                    {t('people.claimText', { claimant: c.claimant_display_name, person: personName(data, c.person_id), date: dateTime(c.created_at) })}
                  </p>
                  <p className="text-sm font-semibold text-amber-900">{t('people.claimWarning')}</p>
                  <div className="flex gap-2">
                    <Button busy={busy} onClick={() => void act(() => rpc('decide_claim', { p_claim_id: c.id, p_approve: true }))}>
                      {t('people.approve')}
                    </Button>
                    <Button variant="secondary" busy={busy} onClick={() => void act(() => rpc('decide_claim', { p_claim_id: c.id, p_approve: false }))}>
                      {t('people.rejectClaim')}
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title={t('people.members')}>
        <ul className="flex flex-col gap-2">
          {data.people
            .filter((p) => p.status !== 'removed')
            .map((p) => {
              const link = links[p.id]
              const open = openInvitation(p.id)
              return (
                <li key={p.id}>
                  <Card className="flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <Avatar name={p.display_name} id={p.id} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{p.display_name}</p>
                        <div className="flex flex-wrap gap-1">
                          {p.linked_user_id === data.trip.admin_user_id && <Badge tone="blue">{t('people.admin')}</Badge>}
                          {p.status === 'placeholder' ? <Badge tone="amber">{t('people.placeholder')}</Badge> : <Badge tone="green">{t('people.joined')}</Badge>}
                          {p.id === data.myPersonId && <Badge>{t('common.me')}</Badge>}
                        </div>
                      </div>
                    </div>
                    {data.isAdmin && active && p.status === 'placeholder' && (
                      <div className="flex flex-col gap-2">
                        {open && !link && (
                          <p className="text-xs text-slate-500">
                            {t('people.inviteOpen', { date: dateTime(open.expires_at) })}{' '}
                            <button type="button" className="underline" onClick={() => void act(() => rpc('revoke_invitation', { p_invitation_id: open.id }))}>
                              {t('people.revoke')}
                            </button>
                          </p>
                        )}
                        {link ? (
                          <div className="flex flex-col gap-2 rounded-xl bg-brand-50 p-2">
                            <p className="text-xs text-slate-600">{t('people.linkOnce')}</p>
                            <Input readOnly value={link} onFocus={(e) => e.target.select()} aria-label={t('people.inviteLink')} />
                            <Button onClick={() => void share(p, link)}>{t('people.shareLink')}</Button>
                          </div>
                        ) : (
                          <Button variant="secondary" busy={busy} onClick={() => void invite(p)}>
                            {open ? t('people.newInvite') : t('people.createInvite')}
                          </Button>
                        )}
                      </div>
                    )}
                  </Card>
                </li>
              )
            })}
        </ul>
      </Section>

      {data.isAdmin && active && (
        <Section title={t('people.addPlaceholder')}>
          <Card>
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault()
                void act(async () => {
                  await rpc('add_trip_person', { p_trip_id: data.trip.id, p_display_name: newName.trim() })
                  setNewName('')
                })
              }}
            >
              <p className="text-sm text-slate-600">{t('people.placeholderHint')}</p>
              <Field label={t('people.name')} htmlFor="new-person">
                <Input id="new-person" required maxLength={60} value={newName} onChange={(e) => setNewName(e.target.value)} />
              </Field>
              <Button type="submit" busy={busy} disabled={!newName.trim()}>
                ＋ {t('people.add')}
              </Button>
            </form>
          </Card>
        </Section>
      )}
    </div>
  )
}
