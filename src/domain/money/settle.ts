export interface Transfer {
  fromPersonId: string
  toPersonId: string
  minor: bigint
}

/**
 * Suggest transfers that settle all balances. Greedy: the largest debtor pays the
 * largest creditor, ties broken by person id. Deterministic; usually close to the
 * minimum number of transfers (no global optimum guaranteed, see concept §7).
 */
export function suggestTransfers(balances: ReadonlyMap<string, bigint>): Transfer[] {
  const byAmount = (a: [string, bigint], b: [string, bigint]) =>
    a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1
  const creditors = [...balances].filter(([, v]) => v > 0n).sort(byAmount)
  const debtors = [...balances].filter(([, v]) => v < 0n).map(([id, v]) => [id, -v] as [string, bigint]).sort(byAmount)

  const transfers: Transfer[] = []
  let c = 0
  let d = 0
  while (c < creditors.length && d < debtors.length) {
    const amount = creditors[c][1] < debtors[d][1] ? creditors[c][1] : debtors[d][1]
    transfers.push({ fromPersonId: debtors[d][0], toPersonId: creditors[c][0], minor: amount })
    creditors[c][1] -= amount
    debtors[d][1] -= amount
    if (creditors[c][1] === 0n) c++
    if (debtors[d][1] === 0n) d++
  }
  return transfers
}
