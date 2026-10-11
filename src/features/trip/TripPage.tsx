import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge, Card, Empty, LinkButton, PageHeader, Section } from '../../components/ui'
import { dateRange, money } from '../../lib/format'
import { ExpenseRow } from '../expenses/ExpenseRow'
import { TransferRow } from '../balances/TransferRow'
import { currenciesUsed, liveExpenses, suggestions, totalSpent } from './derive'
import { useTripContext } from './TripLayout'
import { DraftList } from '../expenses/DraftList'

export function TripPage() {
  const { t } = useTranslation()
  const { data, live } = useTripContext()
  const { trip } = data
  const base = trip.base_currency
  const mine = data.myPersonId ? (data.balances.get(data.myPersonId) ?? 0n) : 0n
  const expenses = liveExpenses(data)
  const confirmed = data.settlements.filter((s) => s.status === 'confirmed')
  const pendingForMe = data.settlements.filter((s) => s.status === 'pending' && s.receiver_person_id === data.myPersonId)
  const pendingMine = data.settlements.filter((s) => s.status === 'pending' && s.sender_person_id === data.myPersonId)
  const missingRates = currenciesUsed(data).filter((c) => c !== base && c !== 'EUR' && !data.rates.some((r) => r.currency === c))

  return (
    <div>
      <PageHeader
        title={trip.title}
        subtitle={dateRange(trip.start_date, trip.end_date)}
        back="/"
        action={
          trip.status === 'active' ? (
            <span className={`text-xs font-semibold ${live ? 'text-brand-600' : 'text-slate-400'}`} aria-live="polite">
              ● {live ? t('trip.live') : t('trip.notLive')}
            </span>
          ) : null
        }
      />

      <DraftList tripId={trip.id} />
      {pendingForMe.length > 0 && (
        <Link to={`/trips/${trip.id}/balances`}>
          <Card tone="amber" className="mb-3 text-sm font-semibold">
            {t('trip.pendingForMe', { count: pendingForMe.length })} ›
          </Card>
        </Link>
      )}
      {pendingMine.length > 0 && (
        <Card tone="blue" className="mb-3 text-sm">
          {t('trip.pendingMine', { count: pendingMine.length })}
        </Card>
      )}
      {data.isAdmin && missingRates.length > 0 && (
        <Link to={`/trips/${trip.id}/rates`}>
          <Card tone="red" className="mb-3 text-sm">
            {t('trip.missingRates', { currencies: missingRates.join(', ') })} ›
          </Card>
        </Link>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Card>
          <p className="text-sm text-slate-500">{t('trip.totalSpent')}</p>
          <p className="text-xl font-extrabold">{money(totalSpent(data), base)}</p>
          <p className="text-xs text-slate-500">{t('trip.expenseCount', { count: expenses.length })}</p>
        </Card>
        <Link to={`/trips/${trip.id}/balances`}>
          <Card tone={mine < 0n ? 'red' : 'green'} className="h-full">
            <p className="text-sm text-slate-600">{t('trip.myBalance')}</p>
            <p className={`text-xl font-extrabold ${mine < 0n ? 'text-red-700' : 'text-brand-700'}`}>{money(mine, base, { signed: true })}</p>
            <p className="text-xs text-slate-600">{mine > 0n ? t('balances.youGet') : mine < 0n ? t('balances.youOwe') : t('balances.settled')}</p>
          </Card>
        </Link>
        <Card tone="blue">
          <p className="text-sm text-slate-600">{t('trip.confirmedSettlements')}</p>
          <p className="text-xl font-extrabold">{confirmed.length}</p>
        </Card>
        <Link to={`/trips/${trip.id}/rates`}>
          <Card className="h-full">
            <p className="text-sm text-slate-500">{t('trip.currencies')}</p>
            <p className="text-xl font-extrabold">{currenciesUsed(data).length}</p>
            <p className="truncate text-xs text-slate-500">{currenciesUsed(data).join(', ')}</p>
          </Card>
        </Link>
      </div>

      <Section title={t('balances.suggestions')}>
        {suggestions(data).length === 0 ? (
          <Empty>{t('balances.allSettled')}</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {suggestions(data).map((s) => (
              <TransferRow key={`${s.fromPersonId}-${s.toPersonId}`} data={data} transfer={s} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t('trip.recent')}
        action={
          <Link to={`/trips/${trip.id}/expenses`} className="text-sm font-semibold text-navy-600">
            {t('common.showAll')} ›
          </Link>
        }
      >
        {expenses.length === 0 ? (
          <Empty>{t('expenses.none')}</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {expenses.slice(0, 5).map((e) => (
              <ExpenseRow key={e.id} data={data} expense={e} />
            ))}
          </ul>
        )}
      </Section>

      {trip.status === 'active' && data.myPersonId && (
        <LinkButton to={`/trips/${trip.id}/expenses/new`} className="mt-6 w-full">
          ＋ {t('expenses.add')}
        </LinkButton>
      )}

      <nav className="mt-6 grid grid-cols-2 gap-2" aria-label={t('trip.manage')}>
        <LinkButton variant="secondary" to={`/trips/${trip.id}/people`}>
          👥 {t('people.title')}
        </LinkButton>
        <LinkButton variant="secondary" to={`/trips/${trip.id}/rates`}>
          💱 {t('rates.title')}
        </LinkButton>
        <LinkButton variant="secondary" to={`/trips/${trip.id}/data`} className="col-span-2">
          📤 {t('data.title')}
        </LinkButton>
        {data.isAdmin && (
          <LinkButton variant="secondary" to={`/trips/${trip.id}/settings`} className="col-span-2">
            ⚙️ {t('settings.title')} <Badge tone="blue">{t('people.admin')}</Badge>
          </LinkButton>
        )}
      </nav>
    </div>
  )
}
