import { suggestTransfers, type Transfer } from '../../domain/money'
import type { TripData } from './types'

export function baseTotals(data: TripData): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const s of data.baseShares) totals.set(s.expense_id, BigInt(s.base_total))
  return totals
}

export function totalSpent(data: TripData): bigint {
  let sum = 0n
  for (const v of baseTotals(data).values()) sum += v
  return sum
}

export function liveExpenses(data: TripData) {
  return data.expenses.filter((e) => !e.deleted_at)
}

export function suggestions(data: TripData): Transfer[] {
  return suggestTransfers(data.balances)
}

export function isReversed(data: TripData, settlementId: string): boolean {
  return data.reversals.some((r) => r.settlement_id === settlementId)
}

export function currenciesUsed(data: TripData): string[] {
  return [...new Set([data.trip.base_currency, ...liveExpenses(data).map((e) => e.currency)])]
}

export function canEditExpense(data: TripData, userId: string | undefined, createdBy: string): boolean {
  return data.trip.status === 'active' && (data.isAdmin || createdBy === userId)
}

export const CATEGORIES = ['transport', 'accommodation', 'food', 'activities', 'shopping', 'other'] as const
export const CATEGORY_ICON: Record<string, string> = {
  transport: '🚕',
  accommodation: '🛏️',
  food: '🍽️',
  activities: '🎟️',
  shopping: '🛍️',
  other: '•••',
}
