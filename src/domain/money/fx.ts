import { currencyExponent, MoneyError } from './currencies'
import { divRoundHalfUp } from './rational'

/** Exchange rates are stored as numeric(20,10): EUR per one unit of the currency. */
export const RATE_SCALE_DIGITS = 10
export const RATE_SCALE = 10n ** BigInt(RATE_SCALE_DIGITS)
const MAX_RATE_INTEGER_DIGITS = 10

/** A rate as scaled integer: value = scaled / 10^10. */
export type ScaledRate = bigint

export const EUR_RATE: ScaledRate = RATE_SCALE

export function parseRate(input: string): ScaledRate {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(input.trim())
  if (!match) throw new MoneyError('invalid_rate', `Invalid rate: ${input}`)
  const [, whole, fraction = ''] = match
  if (whole.replace(/^0+/, '').length > MAX_RATE_INTEGER_DIGITS) throw new MoneyError('rate_too_large', 'Rate is too large')
  if (fraction.length > RATE_SCALE_DIGITS) throw new MoneyError('rate_too_precise', 'At most 10 decimals')
  const scaled = BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(RATE_SCALE_DIGITS, '0') || '0')
  if (scaled <= 0n) throw new MoneyError('rate_not_positive', 'Rate must be greater than zero')
  return scaled
}

export function rateToString(rate: ScaledRate): string {
  const digits = rate.toString().padStart(RATE_SCALE_DIGITS + 1, '0')
  const whole = digits.slice(0, -RATE_SCALE_DIGITS)
  const fraction = digits.slice(-RATE_SCALE_DIGITS).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/** The rate pair used for one conversion; frozen as-is in settlement snapshots. */
export interface RatePair {
  /** EUR per unit of the original currency. */
  fromRate: ScaledRate
  /** EUR per unit of the trip base currency. */
  baseRate: ScaledRate
}

/**
 * Convert minor units of `from` into minor units of `base`, rounding once half-up:
 *   base_minor = round(minor / 10^e_from * fromRate / baseRate * 10^e_base)
 * Computed as one integer fraction, so client and database produce identical results.
 * Mirrored in SQL by `public.convert_minor()`.
 */
export function convertMinor(minor: bigint, from: string, base: string, rates: RatePair): bigint {
  if (minor < 0n) throw new MoneyError('negative_value', 'Amount must not be negative')
  if (from === base) return minor
  const numerator = minor * rates.fromRate * 10n ** BigInt(currencyExponent(base))
  const denominator = 10n ** BigInt(currencyExponent(from)) * rates.baseRate
  return divRoundHalfUp(numerator, denominator)
}

/** Look up EUR-per-unit rates in a trip's rate sheet. EUR is always 1. */
export function ratePairFor(from: string, base: string, sheet: ReadonlyMap<string, ScaledRate>): RatePair {
  const lookup = (code: string): ScaledRate => {
    if (code === 'EUR') return EUR_RATE
    const rate = sheet.get(code)
    if (rate === undefined) throw new MoneyError('missing_fx_rate', `No exchange rate set for ${code}`)
    return rate
  }
  return { fromRate: lookup(from), baseRate: lookup(base) }
}
