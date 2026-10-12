// Mandatory test vectors from Entwicklungsauftrag §7.2 / Gesamtkonzept §7.
import { describe, expect, it } from 'vitest'
import {
  computeBalances,
  convertMinor,
  type LedgerExpense,
  type LedgerSettlement,
  MoneyError,
  parseAmount,
  parseRate,
  ratePairFor,
  splitOriginal,
  suggestTransfers,
} from '../../src/domain/money'

// Person ids sort as EF < LG < RO so tie-breaks are predictable.
const EF = 'p1-ef'
const LG = 'p2-lg'
const RO = 'p3-ro'
const BA = 'p4-ba'

const sheet = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([k, v]) => [k, parseRate(v)]))

function expense(id: string, payer: string, currency: string, amount: string, participants: string[]): LedgerExpense {
  const originalMinor = parseAmount(amount, currency)
  return {
    id,
    paidByPersonId: payer,
    currency,
    originalMinor,
    originalShares: splitOriginal(originalMinor, 'equal', participants.map((personId) => ({ personId }))),
  }
}

function confirmed(id: string, from: string, to: string, baseMinor: bigint): LedgerSettlement {
  return { id, senderPersonId: from, receiverPersonId: to, status: 'confirmed', confirmedBaseMinor: baseMinor, reversed: false }
}

const balancesOf = (b: Map<string, bigint>) => Object.fromEntries([...b].map(([k, v]) => [k, v]))

describe('§7.2 Pflicht-Testvektoren', () => {
  it('EF zahlt 100 EUR für EF/LG → EF +50, LG −50', () => {
    const b = computeBalances([EF, LG], [expense('e1', EF, 'EUR', '100', [EF, LG])], [], 'EUR', sheet({}))
    expect(balancesOf(b)).toEqual({ [EF]: 5000n, [LG]: -5000n })
  })

  it('100 EUR / 3 → 33,34 / 33,33 / 33,33', () => {
    const shares = splitOriginal(10000n, 'equal', [{ personId: RO }, { personId: EF }, { personId: LG }])
    expect(shares).toEqual([
      { personId: EF, minor: 3334n },
      { personId: LG, minor: 3333n },
      { personId: RO, minor: 3333n },
    ])
  })

  it('EF 100 CHF zu 1,10, 50/50 → +55/−55 EUR; Kurs 1,20 → +60/−60, Original unverändert', () => {
    const e = expense('e1', EF, 'CHF', '100', [EF, LG])
    expect(balancesOf(computeBalances([EF, LG], [e], [], 'EUR', sheet({ CHF: '1.10' })))).toEqual({ [EF]: 5500n, [LG]: -5500n })
    expect(balancesOf(computeBalances([EF, LG], [e], [], 'EUR', sheet({ CHF: '1.20' })))).toEqual({ [EF]: 6000n, [LG]: -6000n })
    expect(e.originalMinor).toBe(10000n)
  })

  it('LG meldet 20 EUR (pending) → Salden unverändert; EF bestätigt → 40/−40', () => {
    const e = expense('e1', EF, 'CHF', '100', [EF, LG])
    const rates = sheet({ CHF: '1.20' })
    const pending: LedgerSettlement = { ...confirmed('s1', LG, EF, 2000n), status: 'pending', confirmedBaseMinor: null }
    expect(balancesOf(computeBalances([EF, LG], [e], [pending], 'EUR', rates))).toEqual({ [EF]: 6000n, [LG]: -6000n })
    expect(balancesOf(computeBalances([EF, LG], [e], [confirmed('s1', LG, EF, 2000n)], 'EUR', rates))).toEqual({
      [EF]: 4000n,
      [LG]: -4000n,
    })
  })

  it('LG zahlt 100 CHF an EF bei 1,07 → 107,00 EUR; nach Kurs 1,10 weiterhin 107,00', () => {
    const atConfirm = convertMinor(10000n, 'CHF', 'EUR', ratePairFor('CHF', 'EUR', sheet({ CHF: '1.07' })))
    expect(atConfirm).toBe(10700n)
    const s = confirmed('s1', LG, EF, atConfirm)
    const after = computeBalances([EF, LG], [], [s], 'EUR', sheet({ CHF: '1.10' }))
    expect(balancesOf(after)).toEqual({ [EF]: -10700n, [LG]: 10700n })
  })

  it('Zwei Reisen mit anderen Kursen beeinflussen sich nicht', () => {
    const e = expense('e1', EF, 'GEL', '100', [EF, LG])
    const a = computeBalances([EF, LG], [e], [], 'EUR', sheet({ GEL: '0.34' }))
    const b = computeBalances([EF, LG], [e], [], 'EUR', sheet({ GEL: '0.40' }))
    expect(a.get(EF)).toBe(1700n)
    expect(b.get(EF)).toBe(2000n)
  })

  it('Fehlender Kurs → Buchung abgelehnt', () => {
    expect(() => computeBalances([EF, LG], [expense('e1', EF, 'GEL', '100', [EF, LG])], [], 'EUR', sheet({}))).toThrowError(
      expect.objectContaining({ code: 'missing_fx_rate' }) as unknown as Error,
    )
  })

  it('Vier Personen +90/−50/−40/0 → LG→EF 50, RO→EF 40', () => {
    const transfers = suggestTransfers(new Map([[EF, 9000n], [LG, -5000n], [RO, -4000n], [BA, 0n]]))
    expect(transfers).toEqual([
      { fromPersonId: LG, toPersonId: EF, minor: 5000n },
      { fromPersonId: RO, toPersonId: EF, minor: 4000n },
    ])
  })

  it.each([['0'], ['-5'], ['1000000001'], ['abc'], ['1.234'], ['']])('Ungültiger Betrag "%s" wird abgelehnt', (input) => {
    expect(() => parseAmount(input, 'EUR')).toThrow(MoneyError)
  })
})

describe('Rundung und Sonderwährungen', () => {
  it('Null-Dezimal-Währung JPY: 1000 JPY / 3', () => {
    expect(splitOriginal(1000n, 'equal', [{ personId: EF }, { personId: LG }, { personId: RO }]).map((s) => s.minor)).toEqual([
      334n,
      333n,
      333n,
    ])
  })

  it('Drei-Dezimal-Währung KWD wird korrekt geparst und umgerechnet', () => {
    expect(parseAmount('1,005', 'KWD')).toBe(1005n)
    expect(convertMinor(1005n, 'KWD', 'EUR', { fromRate: parseRate('2.8'), baseRate: parseRate('1') })).toBe(281n)
  })

  it('HALF_UP bei exakt halbem Cent', () => {
    // 1 GEL × 0.345 = 0.345 EUR → 0.35 EUR
    expect(convertMinor(100n, 'GEL', 'EUR', { fromRate: parseRate('0.345'), baseRate: parseRate('1') })).toBe(35n)
  })

  it('Basis CHF: Umrechnung über EUR-Kurse beider Währungen', () => {
    // 100 EUR in CHF-Basis bei 1 CHF = 1.08 EUR → 92.59 CHF
    expect(convertMinor(10000n, 'EUR', 'CHF', ratePairFor('EUR', 'CHF', sheet({ CHF: '1.08' })))).toBe(9259n)
  })

  it('Prozentaufteilung mit Rest', () => {
    const shares = splitOriginal(1000n, 'percent', [
      { personId: EF, value: 333_333n },
      { personId: LG, value: 333_333n },
      { personId: RO, value: 333_334n },
    ])
    expect(shares.map((s) => s.minor)).toEqual([333n, 333n, 334n])
  })

  it('Festbeträge müssen exakt aufgehen', () => {
    expect(() => splitOriginal(1000n, 'fixed', [{ personId: EF, value: 500n }, { personId: LG, value: 499n }])).toThrow(
      MoneyError,
    )
  })

  it('Zahler ohne eigenen Anteil (zahlt für andere)', () => {
    const b = computeBalances([EF, LG, RO], [expense('e1', EF, 'EUR', '30', [LG, RO])], [], 'EUR', sheet({}))
    expect(balancesOf(b)).toEqual({ [EF]: 3000n, [LG]: -1500n, [RO]: -1500n })
  })
})
