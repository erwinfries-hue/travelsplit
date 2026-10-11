import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, PageHeader } from '../../components/ui'
import { parseRate, rateToString } from '../../domain/money'
import { date, dateRange, dateTime, money } from '../../lib/format'
import { supabase } from '../../lib/supabase'
import { suggestions } from '../trip/derive'
import { useTripContext } from '../trip/TripLayout'
import { personName } from '../trip/useTrip'
import { buildReport } from './report'

interface Closure {
  version: number
  closed_at: string
  snapshot_sha256: string
}

const th = 'border-b border-slate-300 py-1 pr-2 text-left font-semibold'
const td = 'border-b border-slate-100 py-1 pr-2 align-top'
const num = 'text-right tabular-nums'

/** Printable statement; "Save as PDF" in the browser's print dialog produces the PDF. */
export function ReportPage() {
  const { t } = useTranslation()
  const { data } = useTripContext()
  const [closure, setClosure] = useState<Closure | null>(null)
  const report = buildReport(data)
  const base = data.trip.base_currency
  const baseTotals = new Map(data.baseShares.map((s) => [s.expense_id, s.base_total]))

  useEffect(() => {
    void supabase
      .from('trip_closures')
      .select('version, closed_at, snapshot_sha256')
      .eq('trip_id', data.trip.id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data: row }) => setClosure(row as Closure | null))
  }, [data.trip.id])

  return (
    <div className="report text-sm">
      <div className="print:hidden">
        <PageHeader title={t('report.title')} subtitle={data.trip.title} back={`/trips/${data.trip.id}/data`} />
        <Button className="mb-4 w-full" onClick={() => window.print()}>
          🖨 {t('report.print')}
        </Button>
      </div>

      <header className="mb-4 border-b-2 border-navy-900 pb-2">
        <p className="text-xs font-semibold tracking-wide text-brand-700 uppercase">TravelSplit</p>
        <h1 className="text-2xl font-extrabold text-navy-900">{data.trip.title}</h1>
        <p>{dateRange(data.trip.start_date, data.trip.end_date)}</p>
        <p className="text-xs text-slate-600">
          {t('report.asOf', { date: dateTime(new Date().toISOString()) })} · {t('trip.baseCurrency')}: {base} ·{' '}
          {closure ? t('report.closure', { version: closure.version, date: dateTime(closure.closed_at) }) : t('report.notClosed')}
        </p>
        {closure && <p className="text-[10px] break-all text-slate-500">SHA-256 {closure.snapshot_sha256}</p>}
      </header>

      <h2 className="mt-4 mb-1 text-base font-bold">{t('report.summary')}</h2>
      <p>
        {t('trip.totalSpent')}: <strong>{money(report.total, base)}</strong>
      </p>
      <table className="mt-2 w-full border-collapse">
        <thead>
          <tr>
            <th className={th}>{t('people.name')}</th>
            <th className={`${th} ${num}`}>{t('report.paid')}</th>
            <th className={`${th} ${num}`}>{t('report.consumed')}</th>
            <th className={`${th} ${num}`}>{t('report.settled')}</th>
            <th className={`${th} ${num}`}>{t('report.balance')}</th>
          </tr>
        </thead>
        <tbody>
          {report.people.map((p) => (
            <tr key={p.personId}>
              <td className={td}>{p.name}</td>
              <td className={`${td} ${num}`}>{money(p.paid, base)}</td>
              <td className={`${td} ${num}`}>{money(p.consumed, base)}</td>
              <td className={`${td} ${num}`}>{money(p.sent - p.received, base, { signed: true })}</td>
              <td className={`${td} ${num} font-bold`}>{money(p.balance, base, { signed: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={`mt-1 text-xs ${report.consistent ? 'text-brand-700' : 'font-bold text-red-700'}`} data-testid="report-check">
        {report.consistent ? t('report.checkOk') : t('report.checkFailed')}
      </p>

      <h2 className="mt-4 mb-1 text-base font-bold">{t('balances.suggestions')}</h2>
      {suggestions(data).length === 0 ? (
        <p>{t('balances.allSettled')}</p>
      ) : (
        <ul>
          {suggestions(data).map((s) => (
            <li key={`${s.fromPersonId}-${s.toPersonId}`}>
              {personName(data, s.fromPersonId)} → {personName(data, s.toPersonId)}: <strong>{money(s.minor, base)}</strong>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-4 mb-1 text-base font-bold">{t('rates.title')}</h2>
      {data.rates.length === 0 ? (
        <p>{t('rates.none')}</p>
      ) : (
        <table className="w-full border-collapse">
          <tbody>
            {data.rates.map((r) => (
              <tr key={r.currency}>
                <td className={td}>1 {r.currency}</td>
                <td className={`${td} ${num}`}>{rateToString(parseRate(r.eur_per_unit))} EUR</td>
                <td className={td}>
                  {t('rates.manual')} · {t('rates.revision', { n: r.revision })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="mt-4 mb-1 text-base font-bold">{t('expenses.title_plural')}</h2>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={th}>{t('expenses.date')}</th>
            <th className={th}>{t('expenses.title')}</th>
            <th className={th}>{t('expenses.paidByLabel')}</th>
            <th className={`${th} ${num}`}>{t('expenses.amount')}</th>
            <th className={`${th} ${num}`}>{base}</th>
          </tr>
        </thead>
        <tbody>
          {data.expenses
            .filter((e) => !e.deleted_at)
            .sort((a, b) => a.expense_date.localeCompare(b.expense_date))
            .map((e) => (
              <tr key={e.id} className="break-inside-avoid">
                <td className={`${td} whitespace-nowrap`}>{date(e.expense_date)}</td>
                <td className={td}>
                  {e.title}
                  {e.source !== 'app' && <span className="text-xs text-slate-500"> ({t(`expenses.source.${e.source}`)})</span>}
                </td>
                <td className={td}>{personName(data, e.paid_by_person_id)}</td>
                <td className={`${td} ${num} whitespace-nowrap`}>{money(e.original_minor, e.currency)}</td>
                <td className={`${td} ${num} whitespace-nowrap`}>{money(baseTotals.get(e.id) ?? 0, base)}</td>
              </tr>
            ))}
        </tbody>
      </table>

      <h2 className="mt-4 mb-1 text-base font-bold">{t('trip.confirmedSettlements')}</h2>
      {data.settlements.filter((s) => s.status === 'confirmed').length === 0 ? (
        <p>{t('settlements.noneHistory')}</p>
      ) : (
        <table className="w-full border-collapse">
          <tbody>
            {data.settlements
              .filter((s) => s.status === 'confirmed')
              .map((s) => {
                const reversal = data.reversals.find((r) => r.settlement_id === s.id)
                return (
                  <tr key={s.id} className={reversal ? 'text-slate-500 line-through' : ''}>
                    <td className={`${td} whitespace-nowrap`}>{s.confirmed_at ? date(s.confirmed_at) : ''}</td>
                    <td className={td}>
                      {personName(data, s.sender_person_id)} → {personName(data, s.receiver_person_id)}
                    </td>
                    <td className={`${td} ${num} whitespace-nowrap`}>{money(s.original_minor, s.currency)}</td>
                    <td className={`${td} ${num} whitespace-nowrap`}>
                      {s.confirmed_base_minor !== null && money(s.confirmed_base_minor, s.confirmed_base_currency ?? base)}
                      {s.confirmed_from_rate && s.currency !== base && <span className="block text-[10px]">{t('report.frozenRate')}</span>}
                    </td>
                    <td className={td}>{reversal ? t('settlements.status.reversed') : t('settlements.status.confirmed')}</td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      )}
    </div>
  )
}
