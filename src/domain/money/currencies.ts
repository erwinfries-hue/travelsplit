/**
 * ISO 4217 currencies with their minor-unit exponent.
 *
 * This table is the single source of truth for minor units in the client and is
 * mirrored by `public.currency_exponent()` in the database. Both must stay identical;
 * `tests/integration/currency-parity.test.ts` checks that.
 */
const ZERO_DECIMALS = [
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND',
  'VUV', 'XAF', 'XOF', 'XPF',
] as const

const THREE_DECIMALS = ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'] as const

const TWO_DECIMALS = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD',
  'BDT', 'BGN', 'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD',
  'CDF', 'CHF', 'CNY', 'COP', 'CRC', 'CUP', 'CVE', 'CZK', 'DKK', 'DOP', 'DZD', 'EGP',
  'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GTQ', 'GYD',
  'HKD', 'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IRR', 'JMD', 'KES', 'KGS', 'KHR',
  'KPW', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'MAD', 'MDL', 'MGA', 'MKD',
  'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR', 'MZN', 'NAD', 'NGN',
  'NIO', 'NOK', 'NPR', 'NZD', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'QAR', 'RON',
  'RSD', 'RUB', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS', 'SRD',
  'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TOP', 'TRY', 'TTD', 'TWD',
  'TZS', 'UAH', 'USD', 'UYU', 'UZS', 'VES', 'WST', 'XCD', 'YER', 'ZAR', 'ZMW', 'ZWG',
] as const

export type CurrencyCode = string

const EXPONENTS: ReadonlyMap<string, number> = new Map<string, number>([
  ...ZERO_DECIMALS.map((c) => [c, 0] as const),
  ...TWO_DECIMALS.map((c) => [c, 2] as const),
  ...THREE_DECIMALS.map((c) => [c, 3] as const),
])

export const SUPPORTED_CURRENCIES: readonly string[] = [...EXPONENTS.keys()].sort()

export function isSupportedCurrency(code: string): boolean {
  return EXPONENTS.has(code)
}

export function currencyExponent(code: string): number {
  const exp = EXPONENTS.get(code)
  if (exp === undefined) throw new MoneyError('unsupported_currency', `Unsupported currency: ${code}`)
  return exp
}

export class MoneyError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'MoneyError'
  }
}
