import { SUPPORTED_CURRENCIES } from '../domain/money'
import { Select } from './ui'

const COMMON = ['EUR', 'CHF', 'USD', 'GBP', 'GEL', 'AMD', 'TRY', 'JPY', 'THB']

export function CurrencySelect({
  value,
  onChange,
  id,
  preferred = [],
  disabled,
}: {
  value: string
  onChange: (code: string) => void
  id?: string
  preferred?: string[]
  disabled?: boolean
}) {
  const top = [...new Set([...preferred, ...COMMON])]
  const rest = SUPPORTED_CURRENCIES.filter((c) => !top.includes(c))
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {top.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
      <option disabled>──────</option>
      {rest.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </Select>
  )
}
