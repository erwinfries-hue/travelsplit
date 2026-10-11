import type { TripData } from '../trip/types'

export interface PersonLine {
  personId: string
  name: string
  paid: bigint
  consumed: bigint
  sent: bigint
  received: bigint
  /** Server balance (trip_balances); the report shows this value. */
  balance: bigint
}

export interface TripReport {
  people: PersonLine[]
  total: bigint
  /** paid − consumed + sent − received equals the server balance for everyone, and balances sum to 0. */
  consistent: boolean
}

/** Aggregates for the printable statement, cross-checked against the server's balances. */
export function buildReport(data: TripData): TripReport {
  const lines = new Map<string, PersonLine>(
    data.people
      .filter((p) => p.status !== 'removed' || data.balances.has(p.id))
      .map((p) => [p.id, { personId: p.id, name: p.display_name, paid: 0n, consumed: 0n, sent: 0n, received: 0n, balance: data.balances.get(p.id) ?? 0n }]),
  )
  const line = (id: string) => lines.get(id)
  const seen = new Set<string>()
  let total = 0n
  for (const s of data.baseShares) {
    if (!seen.has(s.expense_id)) {
      seen.add(s.expense_id)
      total += BigInt(s.base_total)
      const payer = line(s.paid_by_person_id)
      if (payer) payer.paid += BigInt(s.base_total)
    }
    const p = line(s.person_id)
    if (p) p.consumed += BigInt(s.base_minor)
  }
  for (const s of data.settlements) {
    if (s.status !== 'confirmed' || s.confirmed_base_minor === null) continue
    if (data.reversals.some((r) => r.settlement_id === s.id)) continue
    const from = line(s.sender_person_id)
    const to = line(s.receiver_person_id)
    if (from) from.sent += BigInt(s.confirmed_base_minor)
    if (to) to.received += BigInt(s.confirmed_base_minor)
  }
  const people = [...lines.values()].sort((a, b) => a.name.localeCompare(b.name))
  const sum = people.reduce((acc, p) => acc + p.balance, 0n)
  const consistent = sum === 0n && people.every((p) => p.paid - p.consumed + p.sent - p.received === p.balance)
  return { people, total, consistent }
}
