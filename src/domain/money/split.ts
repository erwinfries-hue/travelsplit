import { MoneyError } from './currencies.ts'
import { allocate } from './rational.ts'

export type SplitMode = 'equal' | 'fixed' | 'percent'

/** Percent values are scaled by 10^4: 100 % = 1_000_000. */
export const PERCENT_SCALE = 10_000n
export const PERCENT_TOTAL = 100n * PERCENT_SCALE

export interface SplitInput {
  /** Stable person id, used as deterministic tie-breaker. */
  personId: string
  /** `fixed`: amount in original minor units. `percent`: scaled percent. Ignored for `equal`. */
  value?: bigint
}

export interface Share {
  personId: string
  minor: bigint
}

export function parsePercent(input: string): bigint {
  const match = /^(\d{1,3})(?:[.,](\d{1,4}))?$/.exec(input.trim())
  if (!match) throw new MoneyError('invalid_percent', `Invalid percent: ${input}`)
  const [, whole, fraction = ''] = match
  const scaled = BigInt(whole) * PERCENT_SCALE + BigInt(fraction.padEnd(4, '0') || '0')
  if (scaled > PERCENT_TOTAL) throw new MoneyError('percent_too_large', 'Percent must not exceed 100')
  return scaled
}

export function sortByPersonId<T extends { personId: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0))
}

/**
 * Split an expense's original amount into per-person original minor units.
 * Participants with a zero share are dropped. Result is sorted by person id.
 * Mirrored in SQL by `public.compute_original_shares()`.
 */
export function splitOriginal(totalMinor: bigint, mode: SplitMode, inputs: readonly SplitInput[]): Share[] {
  if (totalMinor <= 0n) throw new MoneyError('amount_not_positive', 'Amount must be greater than zero')
  if (inputs.length === 0) throw new MoneyError('no_participants', 'Select at least one participant')
  const ids = new Set(inputs.map((i) => i.personId))
  if (ids.size !== inputs.length) throw new MoneyError('duplicate_participant', 'Participant listed twice')

  const sorted = sortByPersonId(inputs)
  let parts: bigint[]
  switch (mode) {
    case 'equal':
      parts = allocate(totalMinor, sorted.map(() => 1n))
      break
    case 'fixed': {
      const values = sorted.map((i) => requireValue(i))
      if (values.reduce((a, b) => a + b, 0n) !== totalMinor) {
        throw new MoneyError('fixed_sum_mismatch', 'Fixed amounts must add up to the total')
      }
      parts = values
      break
    }
    case 'percent': {
      const values = sorted.map((i) => requireValue(i))
      if (values.reduce((a, b) => a + b, 0n) !== PERCENT_TOTAL) {
        throw new MoneyError('percent_sum_mismatch', 'Percentages must add up to 100')
      }
      parts = allocate(totalMinor, values)
      break
    }
    default:
      throw new MoneyError('invalid_split_mode', `Unknown split mode: ${String(mode)}`)
  }

  const shares = sorted.map((i, idx) => ({ personId: i.personId, minor: parts[idx] })).filter((s) => s.minor > 0n)
  if (shares.length === 0) throw new MoneyError('no_positive_share', 'At least one participant must pay a share')
  return shares
}

function requireValue(input: SplitInput): bigint {
  if (input.value === undefined || input.value < 0n) {
    throw new MoneyError('invalid_share_value', 'Each participant needs a non-negative value')
  }
  return input.value
}

/**
 * Distribute the converted base total proportionally to the exact original shares
 * (largest remainder, person-id order). Sum equals `baseTotal` exactly.
 */
export function splitBase(baseTotal: bigint, originalShares: readonly Share[]): Share[] {
  const sorted = sortByPersonId(originalShares)
  const parts = allocate(baseTotal, sorted.map((s) => s.minor))
  return sorted.map((s, idx) => ({ personId: s.personId, minor: parts[idx] }))
}
