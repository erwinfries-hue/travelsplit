import { currencyExponent, MoneyError } from './currencies.ts'

/** Largest accepted amount in major units (per expense or settlement). */
export const MAX_MAJOR_AMOUNT = 1_000_000_000n

export function maxMinor(currency: string): bigint {
  return MAX_MAJOR_AMOUNT * 10n ** BigInt(currencyExponent(currency))
}

/**
 * Parse a user-entered amount into minor units.
 *
 * Accepts digits with at most one decimal separator ("," or "."), no thousands
 * separators and no more fraction digits than the currency allows. Ambiguous input
 * such as "1.234" for a two-decimal currency is rejected instead of guessed.
 */
export function parseAmount(input: string, currency: string): bigint {
  const exp = currencyExponent(currency)
  const text = input.trim()
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(text)
  if (!match) throw new MoneyError('invalid_amount', `Invalid amount: ${input}`)
  const [, whole, fraction = ''] = match
  if (fraction.length > exp) throw new MoneyError('too_many_decimals', `Too many decimals for ${currency}`)
  const minor = BigInt(whole) * 10n ** BigInt(exp) + BigInt(fraction.padEnd(exp, '0') || '0')
  assertValidAmount(minor, currency)
  return minor
}

export function assertValidAmount(minor: bigint, currency: string): void {
  if (minor <= 0n) throw new MoneyError('amount_not_positive', 'Amount must be greater than zero')
  if (minor > maxMinor(currency)) throw new MoneyError('amount_too_large', 'Amount is too large')
}

/** Minor units as a plain decimal string, e.g. 12345n EUR -> "123.45". */
export function minorToDecimalString(minor: bigint, currency: string): string {
  const exp = currencyExponent(currency)
  const negative = minor < 0n
  const digits = (negative ? -minor : minor).toString().padStart(exp + 1, '0')
  const whole = exp === 0 ? digits : digits.slice(0, -exp)
  const fraction = exp === 0 ? '' : `.${digits.slice(-exp)}`
  return `${negative ? '-' : ''}${whole}${fraction}`
}

/** Locale-aware display string. Formatting only; never parse this back. */
export function formatMoney(minor: bigint, currency: string, locale: string, opts?: { signed?: boolean }): string {
  const exp = currencyExponent(currency)
  const nf = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
    signDisplay: opts?.signed ? 'exceptZero' : 'auto',
  })
  // Intl accepts decimal strings and formats them exactly (no float conversion).
  return nf.format(minorToDecimalString(minor, currency) as unknown as number)
}
