import { MoneyError } from './currencies'

/** Round numerator/denominator (both non-negative, denominator > 0) half-up to an integer. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MoneyError('invalid_denominator', 'Denominator must be positive')
  if (numerator < 0n) throw new MoneyError('negative_value', 'Value must not be negative')
  return (2n * numerator + denominator) / (2n * denominator)
}

/**
 * Split `total` into integer parts proportional to `weights` using the largest
 * remainder method. Ties are broken by input order, so callers pass items sorted
 * by a stable id. The parts always sum to exactly `total`.
 *
 * Mirrored in SQL by `public.allocate_largest_remainder()`.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total < 0n) throw new MoneyError('negative_value', 'Total must not be negative')
  if (weights.length === 0) throw new MoneyError('no_participants', 'At least one weight required')
  if (weights.some((w) => w < 0n)) throw new MoneyError('negative_weight', 'Weights must not be negative')
  const weightSum = weights.reduce((a, b) => a + b, 0n)
  if (weightSum === 0n) throw new MoneyError('zero_weights', 'At least one weight must be positive')

  const parts = weights.map((w) => (total * w) / weightSum)
  const remainders = weights.map((w, index) => ({ index, rest: (total * w) % weightSum }))
  let missing = total - parts.reduce((a, b) => a + b, 0n)
  // Larger remainder first; equal remainders keep input order (stable sort).
  remainders.sort((a, b) => (a.rest === b.rest ? a.index - b.index : a.rest > b.rest ? -1 : 1))
  for (const { index, rest } of remainders) {
    if (missing === 0n) break
    if (rest === 0n && weights[index] === 0n) continue
    parts[index] += 1n
    missing -= 1n
  }
  return parts
}
