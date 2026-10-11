import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useAuth } from '../../app/auth'
import { Button, Card, Section } from '../../components/ui'
import { rpc } from '../../lib/rpc'
import { supabase } from '../../lib/supabase'

interface ReviewItem {
  id: string
  trip_id: string | null
  reason_code: string
  message_text: string | null
  created_at: string
}

/**
 * Unbooked WhatsApp messages (no balance effect). "Erfassen" opens the normal quick entry with the text;
 * the item stays until it is marked done or discarded. Empty (and invisible) while WhatsApp is off.
 */
export function WhatsAppReview({ tripId }: { tripId: string | null }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [items, setItems] = useState<ReviewItem[]>([])

  const load = useCallback(async () => {
    if (!user) return
    let query = supabase.from('whatsapp_review_queue').select('id, trip_id, reason_code, message_text, created_at').eq('status', 'needs_review')
    query = tripId ? query.eq('trip_id', tripId) : query.is('trip_id', null).eq('user_id', user.id)
    const { data } = await query.order('created_at')
    setItems((data ?? []) as ReviewItem[])
  }, [user, tripId])

  useEffect(() => {
    void load()
  }, [load])

  if (items.length === 0) return null
  const resolve = async (id: string, status: 'done' | 'dismissed') => {
    await rpc('resolve_whatsapp_review', { p_review_id: id, p_status: status })
    await load()
  }
  const open = (item: ReviewItem) => {
    const quick = new URLSearchParams({ quick: item.message_text ?? '' })
    navigate(item.trip_id ? `/trips/${item.trip_id}?${quick}` : `/share?${new URLSearchParams({ text: item.message_text ?? '' })}`)
  }

  return (
    <Section title={`💬 ${t('whatsapp.reviewTitle')}`}>
      <p className="mb-2 text-xs text-slate-500">{t('whatsapp.reviewHint')}</p>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.id}>
            <Card tone="amber" className="flex flex-col gap-2 text-sm">
              <p className="font-semibold break-words">{item.message_text ?? t('whatsapp.noText')}</p>
              <p className="text-xs text-slate-600">
                {t([`whatsapp.reasons.${item.reason_code}`, `quick.errors.${item.reason_code}`, `errors.${item.reason_code}`, 'whatsapp.reasons.other'], { name: '' })}
              </p>
              <div className="flex gap-2">
                {item.message_text && (
                  <Button variant="secondary" onClick={() => open(item)}>
                    {t('whatsapp.open')}
                  </Button>
                )}
                <Button variant="secondary" onClick={() => void resolve(item.id, 'done')}>
                  {t('whatsapp.done')}
                </Button>
                <Button variant="secondary" onClick={() => void resolve(item.id, 'dismissed')}>
                  {t('whatsapp.dismiss')}
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </Section>
  )
}
