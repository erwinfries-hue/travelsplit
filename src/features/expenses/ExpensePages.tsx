import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useParams } from 'react-router'
import { useAuth } from '../../app/auth'
import { Avatar, Badge, Button, Card, Empty, ErrorBox, Field, Input, LinkButton, PageHeader, Section } from '../../components/ui'
import { date, dateTime, money } from '../../lib/format'
import { type AppError, rpc, toAppError } from '../../lib/rpc'
import { supabase } from '../../lib/supabase'
import { baseTotals, canEditExpense, CATEGORY_ICON } from '../trip/derive'
import { useTripContext } from '../trip/TripLayout'
import { personName } from '../trip/useTrip'
import { ExpenseForm } from './ExpenseForm'
import { ExpenseRow } from './ExpenseRow'

export function ExpensesPage() {
  const { t } = useTranslation()
  const { data } = useTripContext()
  const [query, setQuery] = useState('')
  const [showDeleted, setShowDeleted] = useState(false)
  const q = query.trim().toLowerCase()
  const list = data.expenses.filter(
    (e) =>
      (showDeleted || !e.deleted_at) &&
      (!q || e.title.toLowerCase().includes(q) || personName(data, e.paid_by_person_id).toLowerCase().includes(q) || e.currency.toLowerCase() === q),
  )
  return (
    <div>
      <PageHeader title={t('expenses.title_plural')} subtitle={data.trip.title} back={`/trips/${data.trip.id}`} />
      <div className="mb-3 flex flex-col gap-2">
        <Input type="search" aria-label={t('expenses.search')} placeholder={t('expenses.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
          {t('expenses.showDeleted')}
        </label>
      </div>
      {list.length === 0 ? (
        <Empty>{t('expenses.none')}</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((e) => (
            <ExpenseRow key={e.id} data={data} expense={e} />
          ))}
        </ul>
      )}
      {data.trip.status === 'active' && data.myPersonId && (
        <LinkButton to={`/trips/${data.trip.id}/expenses/new`} className="mt-6 w-full">
          ＋ {t('expenses.add')}
        </LinkButton>
      )}
    </div>
  )
}

export function NewExpensePage() {
  const { t } = useTranslation()
  const { data } = useTripContext()
  if (data.trip.status !== 'active') return <Navigate to={`/trips/${data.trip.id}`} replace />
  return (
    <div>
      <PageHeader title={t('expenses.add')} subtitle={data.trip.title} back={`/trips/${data.trip.id}`} />
      <ExpenseForm data={data} />
    </div>
  )
}

export function EditExpensePage() {
  const { t } = useTranslation()
  const { data } = useTripContext()
  const { user } = useAuth()
  const { expenseId } = useParams()
  const expense = data.expenses.find((e) => e.id === expenseId)
  if (!expense || expense.deleted_at || !canEditExpense(data, user?.id, expense.created_by)) {
    return <Navigate to={`/trips/${data.trip.id}/expenses/${expenseId}`} replace />
  }
  return (
    <div>
      <PageHeader title={t('expenses.edit')} subtitle={expense.title} back={`/trips/${data.trip.id}/expenses/${expense.id}`} />
      <ExpenseForm key={`${expense.id}-${expense.revision}`} data={data} existing={expense} />
    </div>
  )
}

interface AuditRow {
  id: number
  action: string
  actor_user_id: string | null
  created_at: string
  new_values: { reason?: string } | null
}

export function ExpenseDetailPage() {
  const { t } = useTranslation()
  const { data, reload } = useTripContext()
  const { user } = useAuth()
  const navigate = useNavigate()
  const { expenseId } = useParams()
  const expense = data.expenses.find((e) => e.id === expenseId)
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [deleting, setDeleting] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AppError | null>(null)

  useEffect(() => {
    if (!expenseId) return
    void supabase
      .from('audit_events')
      .select('id, action, actor_user_id, created_at, new_values')
      .eq('entity_id', expenseId)
      .order('created_at')
      .then(({ data: rows }) => setAudit((rows ?? []) as AuditRow[]))
  }, [expenseId, expense?.revision])

  if (!expense) return <ErrorBox error={{ code: 'expense_not_found' }} />
  const base = data.trip.base_currency
  const splits = data.splits.filter((s) => s.expense_id === expense.id)
  const baseShares = data.baseShares.filter((s) => s.expense_id === expense.id)
  const total = baseTotals(data).get(expense.id)
  const editable = !expense.deleted_at && canEditExpense(data, user?.id, expense.created_by)
  const actorName = (uid: string | null) => data.people.find((p) => p.linked_user_id === uid)?.display_name ?? t('expenses.unknownActor')

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await rpc('delete_expense', { p_expense_id: expense.id, p_expected_revision: expense.revision, p_reason: reason.trim() || null })
      await reload()
      navigate(`/trips/${data.trip.id}/expenses`, { replace: true })
    } catch (e) {
      setError(toAppError(e))
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader title={t('expenses.detail')} back={`/trips/${data.trip.id}/expenses`} />
      <Card tone="green">
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-2xl">
            {CATEGORY_ICON[expense.category ?? 'other']}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-xl font-bold">{expense.title}</h2>
            <p className="text-3xl font-extrabold text-brand-700">{money(expense.original_minor, expense.currency)}</p>
            {expense.currency !== base && total !== undefined && <p className="text-slate-600">≈ {money(total, base)}</p>}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          {expense.admin_reconstruction && <Badge tone="amber">{t('expenses.reconstruction')}</Badge>}
          {expense.deleted_at && <Badge tone="red">{t('expenses.deleted')}</Badge>}
          {expense.source !== 'app' && <Badge tone="blue">{t(`expenses.source.${expense.source}`)}</Badge>}
        </div>
      </Card>

      <Card className="mt-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-slate-500">{t('expenses.paidByLabel')}</dt>
          <dd className="font-semibold">{personName(data, expense.paid_by_person_id)}</dd>
          <dt className="text-slate-500">{t('expenses.date')}</dt>
          <dd>{date(expense.expense_date)}</dd>
          {expense.category && (
            <>
              <dt className="text-slate-500">{t('expenses.category')}</dt>
              <dd>{t(`categories.${expense.category}`)}</dd>
            </>
          )}
          <dt className="text-slate-500">{t('expenses.split')}</dt>
          <dd>{t(`expenses.mode.${expense.split_mode}`)}</dd>
          {expense.note && (
            <>
              <dt className="text-slate-500">{t('expenses.note')}</dt>
              <dd className="whitespace-pre-wrap">{expense.note}</dd>
            </>
          )}
        </dl>
      </Card>

      <Section title={t('expenses.splitTitle')}>
        <Card>
          <ul className="divide-y divide-slate-100">
            {splits
              .slice()
              .sort((a, b) => personName(data, a.person_id).localeCompare(personName(data, b.person_id)))
              .map((s) => {
                const b = baseShares.find((x) => x.person_id === s.person_id)
                return (
                  <li key={s.person_id} className="flex items-center gap-3 py-2">
                    <Avatar name={personName(data, s.person_id)} id={s.person_id} size="sm" />
                    <span className="flex-1">{personName(data, s.person_id)}</span>
                    <span className="text-right">
                      <span className="block font-semibold">{money(s.original_minor, expense.currency)}</span>
                      {expense.currency !== base && b && <span className="block text-xs text-slate-500">{money(b.base_minor, base)}</span>}
                    </span>
                  </li>
                )
              })}
          </ul>
        </Card>
      </Section>

      <Section title={t('expenses.activity')}>
        {audit.length === 0 ? (
          <Empty>–</Empty>
        ) : (
          <ol className="flex flex-col gap-2 border-l-2 border-slate-200 pl-4">
            {audit.map((a) => (
              <li key={a.id} className="text-sm">
                <p className="font-semibold">{t(`audit.${a.action}`, { defaultValue: a.action, name: actorName(a.actor_user_id) })}</p>
                <p className="text-xs text-slate-500">
                  {dateTime(a.created_at)}
                  {a.new_values?.reason ? ` · ${a.new_values.reason}` : ''}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {editable && !deleting && (
        <div className="mt-6 grid grid-cols-2 gap-2">
          <LinkButton variant="secondary" to={`/trips/${data.trip.id}/expenses/${expense.id}/edit`}>
            ✎ {t('common.edit')}
          </LinkButton>
          <Button variant="ghost" className="text-red-700" onClick={() => setDeleting(true)}>
            {t('common.delete')}
          </Button>
        </div>
      )}
      {deleting && (
        <Card tone="red" className="mt-6 flex flex-col gap-3">
          <p className="text-sm">{t('expenses.deleteWarning')}</p>
          <Field label={t('expenses.changeReason')} htmlFor="del-reason">
            <Input id="del-reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button variant="danger" busy={busy} onClick={() => void remove()}>
              {t('common.delete')}
            </Button>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Card>
      )}
      <div className="mt-3">
        <ErrorBox error={error} />
      </div>
    </div>
  )
}
