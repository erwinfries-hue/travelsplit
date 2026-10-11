import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../app/auth'
import { Badge, Button, Card, Section } from '../../components/ui'
import { deleteDraft, syncDrafts, useDrafts } from '../../lib/drafts'
import { money } from '../../lib/format'

/** Expenses saved on this device only. They are clearly not booked and do not count in balances (UX-04). */
export function DraftList({ tripId }: { tripId: string }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const drafts = useDrafts(user?.id, tripId)
  const [busy, setBusy] = useState(false)
  if (drafts.length === 0) return null
  return (
    <Section title={t('drafts.title')}>
      <Card tone="amber" className="flex flex-col gap-3 text-sm">
        <p>{t('drafts.explain')}</p>
        <ul className="flex flex-col gap-2">
          {drafts.map((d) => (
            <li key={d.id} className="flex items-center gap-2">
              <span className="flex-1">
                <span className="font-semibold">{d.args.p_title}</span> · {money(BigInt(d.args.p_original_minor), d.args.p_currency)}
                {d.expenseId && <span className="block text-xs">{t('drafts.photoPending')}</span>}
                {d.lastError && <span className="block text-xs text-red-700">{t(`errors.${d.lastError}`, { defaultValue: t('errors.unknown_error') })}</span>}
              </span>
              <Badge tone="amber">{t('drafts.notSent')}</Badge>
              {d.lastError && (
                <button type="button" className="min-h-11 px-2 font-semibold text-red-700 underline" onClick={() => void deleteDraft(d.id)}>
                  {t('drafts.discard')}
                </button>
              )}
            </li>
          ))}
        </ul>
        <Button
          variant="secondary"
          busy={busy}
          onClick={async () => {
            setBusy(true)
            if (user) await syncDrafts(user.id)
            setBusy(false)
          }}
        >
          {t('drafts.sendNow')}
        </Button>
      </Card>
    </Section>
  )
}
