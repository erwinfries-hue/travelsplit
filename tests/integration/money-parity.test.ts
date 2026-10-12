// The database is authoritative for balances; the client shows previews with the same
// algorithms. Both must agree to the last minor unit (R5).
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import {
  allocate,
  convertMinor,
  currencyExponent,
  RATE_SCALE,
  rateToString,
  SUPPORTED_CURRENCIES,
} from '../../src/domain/money'
import { closeDb, db } from './helpers'

afterAll(closeDb)

describe('Parität TypeScript ↔ SQL', () => {
  it('Währungstabelle identisch', async () => {
    const { rows } = await db().query(
      `select c, public.currency_exponent(c) as e from unnest($1::text[]) as c`,
      [SUPPORTED_CURRENCIES],
    )
    for (const r of rows) expect(r.e, r.c).toBe(currencyExponent(r.c))
    const { rows: unknown } = await db().query(`select public.currency_exponent('XXX') as e`)
    expect(unknown[0].e).toBeNull()
  })

  it('convert_minor: 1000 Zufallsfälle identisch', async () => {
    const cases = fc.sample(
      fc.record({
        minor: fc.bigInt({ min: 0n, max: 10n ** 12n }),
        from: fc.constantFrom('EUR', 'CHF', 'GEL', 'AMD', 'JPY', 'KWD', 'USD'),
        base: fc.constantFrom('EUR', 'CHF', 'JPY', 'KWD'),
        fromRate: fc.bigInt({ min: 1n, max: 10n ** 13n }),
        baseRate: fc.bigInt({ min: 1n, max: 10n ** 13n }),
      }),
      1000,
    )
    const MAX_BIGINT = 2n ** 63n - 1n
    let overflowCases = 0
    for (const c of cases) {
      const ts = convertMinor(c.minor, c.from, c.base, { fromRate: c.fromRate, baseRate: c.baseRate })
      const query = db().query(`select public.convert_minor($1, $2, $3, $4, $5)::text as v`, [
        c.minor.toString(),
        c.from,
        c.base,
        rateToString(c.fromRate),
        rateToString(c.baseRate),
      ])
      if (ts > MAX_BIGINT) {
        // Absurd rate ratios: the database refuses instead of wrapping around.
        overflowCases++
        await expect(query).rejects.toThrow('out of range')
      } else {
        expect((await query).rows[0].v).toBe(ts.toString())
      }
    }
    expect(overflowCases).toBeLessThan(cases.length)
    expect(RATE_SCALE).toBe(10n ** 10n)
  })

  it('allocate_largest_remainder: 500 Zufallsfälle identisch', async () => {
    const cases = fc.sample(
      fc.record({
        total: fc.bigInt({ min: 0n, max: 10n ** 12n }),
        weights: fc.array(fc.bigInt({ min: 0n, max: 10n ** 9n }), { minLength: 1, maxLength: 8 }),
      }).filter((c) => c.weights.some((w) => w > 0n)),
      500,
    )
    for (const c of cases) {
      const { rows } = await db().query(`select public.allocate_largest_remainder($1, $2::bigint[])::text[] as v`, [
        c.total.toString(),
        c.weights.map(String),
      ])
      expect(rows[0].v).toEqual(allocate(c.total, c.weights).map(String))
    }
  })
})
