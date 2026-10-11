import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, ErrorBox, LinkButton, PageHeader, Section } from '../../components/ui'
import { money } from '../../lib/format'
import { type AppError, rpc, toAppError } from '../../lib/rpc'
import { useTripContext } from '../trip/TripLayout'
import { CSV_SCHEMA_VERSION, CsvParseError, serializeCsv, sha256Text } from './csv'
import { exportFileName, exportRows } from './exportTrip'
import { buildImport, type ImportPreview } from './importTrip'

function download(text: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

interface ImportResult {
  expenses: number
  people_created: number
  rates_set: number
}

export function DataPage() {
  const { t } = useTranslation()
  const { data, reload } = useTripContext()
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [error, setError] = useState<AppError | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const canImport = data.isAdmin && data.trip.status === 'active'

  const pick = async (f: File | undefined) => {
    setPreview(null)
    setResult(null)
    setError(null)
    if (!f) return
    if (f.size > 2 * 1024 * 1024) {
      setError(toAppError({ message: 'import_too_large' }))
      return
    }
    const text = await f.text()
    setFile({ name: f.name, text })
    try {
      setPreview(buildImport(text, data))
    } catch (e) {
      setError(toAppError({ message: e instanceof CsvParseError ? e.code : 'import_invalid_file' }))
    }
  }

  const confirm = async () => {
    if (!file || !preview) return
    setBusy(true)
    setError(null)
    try {
      const res = await rpc<ImportResult>('import_expenses_csv', {
        p_trip_id: data.trip.id,
        p_content_sha256: await sha256Text(file.text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n')),
        p_schema_version: CSV_SCHEMA_VERSION,
        p_rates: preview.rates,
        p_expenses: preview.expenses,
      })
      setResult(res)
      setPreview(null)
      setFile(null)
      await reload()
    } catch (e) {
      setError(toAppError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader title={t('data.title')} subtitle={data.trip.title} back={`/trips/${data.trip.id}`} />

      <Section title={t('data.export')}>
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-slate-600">{t('data.exportHint')}</p>
          <Button onClick={() => download(serializeCsv(exportRows(data)), exportFileName(data))}>⬇ {t('data.exportCsv')}</Button>
          <LinkButton to={`/trips/${data.trip.id}/report`} variant="secondary">
            🖨 {t('data.report')}
          </LinkButton>
        </Card>
      </Section>

      {canImport && (
        <Section title={t('data.import')}>
          <Card className="flex flex-col gap-3">
            <p className="text-sm text-slate-600">{t('data.importHint')}</p>
            <a className="text-sm font-semibold text-navy-700 underline" href="/travelsplit-vorlage-v1.csv" download>
              {t('data.template')}
            </a>
            <label className="flex min-h-11 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-slate-300 px-4 py-3 font-semibold text-navy-700">
              {file ? file.name : t('data.chooseFile')}
              <input type="file" accept=".csv,text/csv" className="sr-only" aria-label={t('data.chooseFile')} onChange={(e) => {
                  void pick(e.target.files?.[0])
                  e.target.value = '' // allow choosing the same file again
                }}
              />
            </label>

            {preview && (
              <div className="flex flex-col gap-2 text-sm" data-testid="import-preview">
                <p className="font-semibold">{t('data.previewCount', { count: preview.expenses.length })}</p>
                {preview.newPeople.length > 0 && <p>{t('data.newPeople', { names: preview.newPeople.join(', ') })}</p>}
                {preview.rates.length > 0 && <p>{t('data.rates', { list: preview.rates.map((r) => `${r.currency} ${r.eur_per_unit}`).join(', ') })}</p>}
                {preview.ignored.settlements > 0 && <p className="text-amber-800">{t('data.ignoredSettlements', { count: preview.ignored.settlements })}</p>}
                {preview.ignored.deleted > 0 && <p className="text-slate-600">{t('data.ignoredDeleted', { count: preview.ignored.deleted })}</p>}
                <ul className="max-h-64 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200">
                  {preview.expenses.map((e) => (
                    <li key={e.row_id} className="flex justify-between gap-2 px-3 py-2">
                      <span className="min-w-0 truncate">
                        {e.date} · {e.title} · {e.paid_by_name}
                      </span>
                      <span className="font-semibold">{money(BigInt(e.original_minor), e.currency)}</span>
                    </li>
                  ))}
                </ul>
                {preview.errors.length > 0 ? (
                  <div className="rounded-xl bg-red-50 p-3 text-red-800" role="alert">
                    <p className="font-semibold">{t('data.errors', { count: preview.errors.length })}</p>
                    <ul>
                      {preview.errors.slice(0, 20).map((e) => (
                        <li key={`${e.line}-${e.code}`}>
                          {t('data.line', { line: e.line })}: {t(`errors.${e.code}`, { defaultValue: e.code })}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <Button onClick={() => void confirm()} busy={busy}>
                    {t('data.confirmImport', { count: preview.expenses.length })}
                  </Button>
                )}
              </div>
            )}
            {result && (
              <p className="rounded-xl bg-brand-50 p-3 text-sm font-semibold text-brand-700" role="status">
                {t('data.imported', { count: result.expenses, people: result.people_created, rates: result.rates_set })}
              </p>
            )}
            <ErrorBox error={error} />
            {error?.detail && <p className="text-sm text-red-800">{error.detail.replace(/^row /, `${t('data.row')} `)}</p>}
          </Card>
        </Section>
      )}
      {!canImport && data.isAdmin && <Badge>{t('trip.archivedBanner')}</Badge>}
    </div>
  )
}
