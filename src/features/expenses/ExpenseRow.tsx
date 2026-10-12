import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge } from '../../components/ui'
import { date, money } from '../../lib/format'
import { baseTotals, CATEGORY_ICON } from '../trip/derive'
import type { Expense, TripData } from '../trip/types'
import { personName } from '../trip/useTrip'

export function ExpenseRow({ data, expense }: { data: TripData; expense: Expense }) {
  const { t } = useTranslation()
  const base = baseTotals(data).get(expense.id)
  const foreign = expense.currency !== data.trip.base_currency
  return (
    <li>
      <Link
        to={`/trips/${data.trip.id}/expenses/${expense.id}`}
        className={`flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm hover:border-brand-500 ${expense.deleted_at ? 'opacity-50' : ''}`}
      >
        <span aria-hidden className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-navy-50 text-xl">
          {CATEGORY_ICON[expense.category ?? 'other']}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">
            {expense.title}
            {data.receipts.some((r) => r.expense_id === expense.id) && (
              <span className="ml-1" role="img" aria-label={t('receipts.title')}>
                📎
              </span>
            )}
          </p>
          <p className="truncate text-xs text-slate-500">
            {date(expense.expense_date)} · {t('expenses.paidBy', { name: personName(data, expense.paid_by_person_id) })}
          </p>
          <div className="mt-0.5 flex gap-1">
            {expense.admin_reconstruction && <Badge tone="amber">{t('expenses.reconstruction')}</Badge>}
            {expense.deleted_at && <Badge tone="red">{t('expenses.deleted')}</Badge>}
          </div>
        </div>
        <div className="text-right">
          <p className="font-bold">{money(expense.original_minor, expense.currency)}</p>
          {foreign && base !== undefined && <p className="text-xs text-slate-500">≈ {money(base, data.trip.base_currency)}</p>}
        </div>
      </Link>
    </li>
  )
}
