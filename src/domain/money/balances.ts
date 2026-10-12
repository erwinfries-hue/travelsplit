import { convertMinor, ratePairFor, type ScaledRate } from './fx'
import { splitBase, type Share } from './split'

export interface LedgerExpense {
  id: string
  paidByPersonId: string
  currency: string
  originalMinor: bigint
  originalShares: Share[]
}

export type SettlementStatus = 'pending' | 'confirmed' | 'rejected' | 'withdrawn'

export interface LedgerSettlement {
  id: string
  senderPersonId: string
  receiverPersonId: string
  status: SettlementStatus
  /** Frozen at confirmation (R1); null while not confirmed. */
  confirmedBaseMinor: bigint | null
  /** True once a reversal neutralised this confirmed settlement. */
  reversed: boolean
}

export interface ExpenseBaseView {
  expenseId: string
  baseTotal: bigint
  baseShares: Share[]
}

export function expenseInBase(
  expense: LedgerExpense,
  baseCurrency: string,
  rateSheet: ReadonlyMap<string, ScaledRate>,
): ExpenseBaseView {
  const rates = ratePairFor(expense.currency, baseCurrency, rateSheet)
  const baseTotal = convertMinor(expense.originalMinor, expense.currency, baseCurrency, rates)
  return { expenseId: expense.id, baseTotal, baseShares: splitBase(baseTotal, expense.originalShares) }
}

/**
 * Net position per person in base minor units. Positive = is owed money.
 *   paid expenses - own shares + confirmed sent - confirmed received
 * Pending, rejected and withdrawn settlements have no effect. A reversed settlement
 * keeps its history but its effect is cancelled by the reversal entry.
 * Mirrored in SQL by `public.trip_balances()`.
 */
export function computeBalances(
  personIds: readonly string[],
  expenses: readonly LedgerExpense[],
  settlements: readonly LedgerSettlement[],
  baseCurrency: string,
  rateSheet: ReadonlyMap<string, ScaledRate>,
): Map<string, bigint> {
  const balances = new Map<string, bigint>(personIds.map((id) => [id, 0n]))
  const add = (id: string, delta: bigint) => balances.set(id, (balances.get(id) ?? 0n) + delta)

  for (const expense of expenses) {
    const view = expenseInBase(expense, baseCurrency, rateSheet)
    add(expense.paidByPersonId, view.baseTotal)
    for (const share of view.baseShares) add(share.personId, -share.minor)
  }
  for (const s of settlements) {
    if (s.status !== 'confirmed' || s.reversed || s.confirmedBaseMinor === null) continue
    add(s.senderPersonId, s.confirmedBaseMinor)
    add(s.receiverPersonId, -s.confirmedBaseMinor)
  }
  return balances
}
