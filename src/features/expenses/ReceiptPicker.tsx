import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorBox } from '../../components/ui'
import { compressReceipt, ImageError } from '../../lib/image'

/** Lets the user pick or shoot a receipt photo; hands back a compressed JPEG without metadata. */
export function ReceiptPicker({ id, value, onChange }: { id?: string; value: Blob | null; onChange: (blob: Blob | null) => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    if (!value) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(value)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [value])

  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      onChange(await compressReceipt(file))
    } catch (e) {
      setError(e instanceof ImageError ? e.code : 'image_unreadable')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {preview ? (
        <div className="flex items-center gap-3">
          <img src={preview} alt={t('receipts.preview')} className="h-20 w-20 rounded-lg border border-slate-200 object-cover" />
          <div className="text-sm">
            <p className="text-slate-600">{t('receipts.size', { kb: Math.round((value?.size ?? 0) / 1024) })}</p>
            <button type="button" className="min-h-11 font-semibold text-red-700 underline" onClick={() => onChange(null)}>
              {t('receipts.remove')}
            </button>
          </div>
        </div>
      ) : (
        <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 px-4 py-3 font-semibold text-navy-700">
          📷 {busy ? t('receipts.processing') : t('receipts.add')}
          <input id={id} type="file" accept="image/*" className="sr-only" disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
      )}
      <p className="mt-1 text-xs text-slate-500">{t('receipts.privacy')}</p>
      {error && <ErrorBox error={{ code: error }} />}
    </div>
  )
}
