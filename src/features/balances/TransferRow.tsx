import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Avatar } from '../../components/ui'
import type { Transfer } from '../../domain/money'
import { money } from '../../lib/format'
import type { TripData } from '../trip/types'
import { personName } from '../trip/useTrip'

export function TransferRow({ data, transfer }: { data: TripData; transfer: Transfer }) {
  const { t } = useTranslation()
  const receiver = data.people.find((p) => p.id === transfer.toPersonId)
  const iAmDebtor = transfer.fromPersonId === data.myPersonId
  const canReport = iAmDebtor && receiver?.status === 'active' && data.trip.status === 'active'
  return (
    <li className="rounded-2xl border border-brand-100 bg-brand-50 p-3">
      <div className="flex items-center gap-2">
        <Avatar name={personName(data, transfer.fromPersonId)} id={transfer.fromPersonId} size="sm" />
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-semibold">{personName(data, transfer.fromPersonId)}</span> {t('balances.paysTo')}{' '}
          <span className="font-semibold">{personName(data, transfer.toPersonId)}</span>
        </div>
        <span className="font-bold text-brand-700">{money(transfer.minor, data.trip.base_currency)}</span>
      </div>
      {canReport && (
        <Link
          to={`/trips/${data.trip.id}/balances?pay=${transfer.toPersonId}&amount=${transfer.minor.toString()}`}
          className="mt-2 inline-block text-sm font-semibold text-navy-600 underline"
        >
          {t('balances.reportThis')}
        </Link>
      )}
      {iAmDebtor && receiver?.status === 'placeholder' && <p className="mt-1 text-xs text-slate-600">{t('balances.receiverNotJoined')}</p>}
    </li>
  )
}
