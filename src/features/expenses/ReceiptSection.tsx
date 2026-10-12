import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Card, Empty, ErrorBox, Section } from '../../components/ui'
import { receiptUrl, removeReceipt, uploadReceipt } from '../../lib/receipts'
import { type AppError, toAppError } from '../../lib/rpc'
import type { TripData } from '../trip/types'
import { ReceiptPicker } from './ReceiptPicker'

/** Shows the receipt through a short-lived signed URL; creator/admin may replace or remove it. */
export function ReceiptSection({ data, expenseId, editable, onChanged }: { data: TripData; expenseId: string; editable: boolean; onChanged: () => Promise<void> }) {
  const { t } = useTranslation()
  const receipt = data.receipts.find((r) => r.expense_id === expenseId)
  const [url, setUrl] = useState<string | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [photo, setPhoto] = useState<Blob | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  useEffect(() => {
    setUrl(null)
    if (!receipt) return
    let cancelled = false
    receiptUrl(receipt.storage_path).then(
      (u) => !cancelled && setUrl(u),
      (e) => !cancelled && setError(toAppError(e)),
    )
    return () => {
      cancelled = true
    }
  }, [receipt?.storage_path])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
      setReplacing(false)
      setPhoto(null)
      await onChanged()
    } catch (e) {
      setError(toAppError(e))
    } finally {
      setBusy(false)
    }
  }

  if (!receipt && !editable) return null
  return (
    <Section title={t('receipts.title')}>
      <Card>
        {receipt ? (
          url ? (
            <a href={url} target="_blank" rel="noreferrer" className="block">
              <img src={url} alt={t('receipts.preview')} className="max-h-80 w-full rounded-lg object-contain" />
            </a>
          ) : (
            <p className="text-sm text-slate-500">{t('common.loading')}</p>
          )
        ) : (
          !replacing && <Empty>{t('receipts.none')}</Empty>
        )}
        {editable && (replacing || !receipt) && (
          <div className="mt-3 flex flex-col gap-2">
            <ReceiptPicker value={photo} onChange={setPhoto} />
            {photo && (
              <Button busy={busy} onClick={() => void run(() => uploadReceipt(data.trip.id, expenseId, photo))}>
                {t('receipts.upload')}
              </Button>
            )}
          </div>
        )}
        {editable && receipt && !replacing && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => setReplacing(true)}>
              {t('receipts.replace')}
            </Button>
            <Button variant="danger" busy={busy} onClick={() => void run(() => removeReceipt(expenseId))}>
              {t('receipts.remove')}
            </Button>
          </div>
        )}
        <ErrorBox error={error} />
      </Card>
    </Section>
  )
}
