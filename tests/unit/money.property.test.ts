import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  computeBalances,
  type LedgerExpense,
  type LedgerSettlement,
  PERCENT_TOTAL,
  RATE_SCALE,
  splitBase,
  splitOriginal,
  type SplitInput,
  type SplitMode,
  suggestTransfers,
} from '../../src/domain/money'

const CURRENCIES = ['EUR', 'CHF', 'GEL', 'AMD', 'JPY', 'KWD'] as const
const PEOPLE = ['a', 'b', 'c', 'd', 'e', 'f']

const arbRate = fc.bigInt({ min: 1n, max: 5000n * RATE_SCALE })
const arbSheet = fc.record({
  CHF: arbRate,
  GEL: arbRate,
  AMD: arbRate,
  JPY: arbRate,
  KWD: arbRate,
})

/** Random split inputs that are valid for the given total and mode. */
function arbSplit(total: bigint, mode: SplitMode, people: string[]): fc.Arbitrary<SplitInput[]> {
  const n = people.length
  if (mode === 'equal') return fc.constant(people.map((personId) => ({ personId })))
  const scale = mode === 'fixed' ? total : PERCENT_TOTAL
  return fc.array(fc.bigInt({ min: 0n, max: scale }), { minLength: n - 1, maxLength: n - 1 }).map((cuts) => {
    const sorted = [0n, ...cuts.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)), scale]
    return people.map((personId, i) => ({ personId, value: sorted[i + 1] - sorted[i] }))
  })
}

const arbExpense = fc
  .record({
    payer: fc.constantFrom(...PEOPLE),
    currency: fc.constantFrom(...CURRENCIES),
    total: fc.bigInt({ min: 1n, max: 10_000_000_00n }),
    mode: fc.constantFrom<SplitMode>('equal', 'fixed', 'percent'),
    people: fc.subarray(PEOPLE, { minLength: 1 }),
  })
  .chain((e) => arbSplit(e.total, e.mode, e.people).map((inputs) => ({ ...e, inputs })))

describe('Property-Tests Geldlogik (DATA-01/02)', () => {
  it('Summe der Originalanteile = Ausgabe, keine verlorenen Kleinsteinheiten', () => {
    fc.assert(
      fc.property(arbExpense, (e) => {
        try {
          const shares = splitOriginal(e.total, e.mode, e.inputs)
          expect(shares.reduce((a, s) => a + s.minor, 0n)).toBe(e.total)
          expect(shares.every((s) => s.minor > 0n)).toBe(true)
        } catch (err) {
          // Only legitimate rejection: every share rounded to zero.
          expect((err as { code?: string }).code).toBe('no_positive_share')
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('Basisanteile summieren exakt auf den umgerechneten Gesamtbetrag', () => {
    fc.assert(
      fc.property(arbExpense, fc.bigInt({ min: 0n, max: 10n ** 15n }), (e, baseTotal) => {
        const shares = splitOriginal(e.total, 'equal', e.people.map((personId) => ({ personId })))
        const base = splitBase(baseTotal, shares)
        expect(base.reduce((a, s) => a + s.minor, 0n)).toBe(baseTotal)
      }),
      { numRuns: 1000 },
    )
  })

  it('Summe aller Salden = 0 und Ausgleichsvorschläge gleichen alles aus', () => {
    fc.assert(
      fc.property(
        fc.array(arbExpense, { minLength: 1, maxLength: 15 }),
        fc.array(
          fc.record({
            from: fc.constantFrom(...PEOPLE),
            to: fc.constantFrom(...PEOPLE),
            amount: fc.bigInt({ min: 1n, max: 1_000_000n }),
            status: fc.constantFrom('pending', 'confirmed', 'rejected', 'withdrawn' as const),
            reversed: fc.boolean(),
          }),
          { maxLength: 8 },
        ),
        arbSheet,
        fc.constantFrom(...CURRENCIES),
        (raw, rawSettlements, rates, base) => {
          const expenses: LedgerExpense[] = []
          raw.forEach((e, i) => {
            try {
              expenses.push({
                id: `e${i}`,
                paidByPersonId: e.payer,
                currency: e.currency,
                originalMinor: e.total,
                originalShares: splitOriginal(e.total, e.mode, e.inputs),
              })
            } catch {
              /* skip invalid random split */
            }
          })
          const settlements: LedgerSettlement[] = rawSettlements
            .filter((s) => s.from !== s.to)
            .map((s, i) => ({
              id: `s${i}`,
              senderPersonId: s.from,
              receiverPersonId: s.to,
              status: s.status,
              confirmedBaseMinor: s.status === 'confirmed' ? s.amount : null,
              reversed: s.reversed,
            }))
          const sheet = new Map(Object.entries(rates))
          const balances = computeBalances(PEOPLE, expenses, settlements, base, sheet)
          expect([...balances.values()].reduce((a, b) => a + b, 0n)).toBe(0n)

          const after = new Map(balances)
          for (const t of suggestTransfers(balances)) {
            expect(t.minor > 0n).toBe(true)
            after.set(t.fromPersonId, after.get(t.fromPersonId)! + t.minor)
            after.set(t.toPersonId, after.get(t.toPersonId)! - t.minor)
          }
          expect([...after.values()].every((v) => v === 0n)).toBe(true)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('Deterministisch: Eingabereihenfolge ändert das Ergebnis nicht', () => {
    fc.assert(
      fc.property(arbExpense, (e) => {
        const a = (() => { try { return splitOriginal(e.total, e.mode, e.inputs) } catch { return null } })()
        const b = (() => { try { return splitOriginal(e.total, e.mode, [...e.inputs].reverse()) } catch { return null } })()
        expect(a).toEqual(b)
      }),
      { numRuns: 1000 },
    )
  })
})
