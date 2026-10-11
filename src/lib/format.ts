import { formatMoney } from '../domain/money'
import i18n from '../i18n'

export function locale(): string {
  return i18n.language === 'en' ? 'en-GB' : 'de-DE'
}

export function money(minor: bigint | number, currency: string, opts?: { signed?: boolean }): string {
  return formatMoney(BigInt(minor), currency, locale(), opts)
}

export function date(value: string | null | undefined): string {
  if (!value) return ''
  const d = value.length === 10 ? new Date(`${value}T12:00:00`) : new Date(value)
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

export function dateTime(value: string): string {
  return new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

export function dateRange(start: string | null, end: string | null): string {
  if (!start && !end) return ''
  if (start && end) return `${date(start)} – ${date(end)}`
  return date(start ?? end)
}

/** Minor units → editable input text in the user's decimal style. */
export function minorToInput(minor: bigint | number, exp: number): string {
  const s = BigInt(minor).toString().padStart(exp + 1, '0')
  const whole = exp ? s.slice(0, -exp) : s
  const frac = exp ? s.slice(-exp) : ''
  const sep = i18n.language === 'en' ? '.' : ','
  return frac ? `${whole}${sep}${frac}` : whole
}
