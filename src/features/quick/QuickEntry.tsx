import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Button, Card, Input } from '../../components/ui'
import { parseEntry } from '../../domain/ingest/parse'
import { percentToInput, resolveParticipants } from '../../domain/ingest/resolve'
import { currencyExponent } from '../../domain/money'
import { minorToInput } from '../../lib/format'
import type { ExpensePrefill } from '../expenses/ExpenseForm'
import type { TripData } from '../trip/types'

/** Problem with a quick entry, as an i18n key under quick.errors plus interpolation values. */
export interface QuickProblem {
  code: string
  name?: string
}

export function buildPrefill(text: string, data: TripData, decimalSep: string): { ok: true; prefill: ExpensePrefill } | { ok: false; problem: QuickProblem } {
  const parsed = parseEntry(text)
  if (!parsed.ok) return { ok: false, problem: { code: parsed.reason } }
  const { entry } = parsed
  if (entry.tripCode && data.trip.trip_code && entry.tripCode !== data.trip.trip_code.toUpperCase()) {
    return { ok: false, problem: { code: 'wrong_trip' } }
  }
  const resolved = resolveParticipants(entry.participants, data.people)
  if (!resolved.ok) return { ok: false, problem: { code: resolved.reason, name: resolved.name } }
  return {
    ok: true,
    prefill: {
      title: entry.title,
      currency: entry.currency,
      amount: minorToInput(entry.amountMinor, currencyExponent(entry.currency)),
      mode: resolved.mode,
      selected: resolved.personIds,
      values: resolved.mode === 'percent' ? Object.fromEntries(Object.entries(resolved.percents).map(([id, v]) => [id, percentToInput(v, decimalSep)])) : {},
    },
  }
}

/** One-line entry ("Taxi 20 EUR alle") that opens the normal expense form prefilled. Nothing is saved here. */
export function QuickEntry({ data, initialText = '' }: { data: TripData; initialText?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [text, setText] = useState(initialText)
  const [problem, setProblem] = useState<QuickProblem | null>(null)

  const submit = () => {
    const result = buildPrefill(text, data, t('common.decimalSep'))
    if (!result.ok) {
      setProblem(result.problem)
      return
    }
    navigate(`/trips/${data.trip.id}/expenses/new`, { state: { prefill: result.prefill } })
  }

  return (
    <Card className="mb-3">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label htmlFor="quick-entry" className="text-sm font-semibold">
          ⚡ {t('quick.label')}
        </label>
        <div className="flex gap-2">
          <Input
            id="quick-entry"
            className="flex-1"
            maxLength={300}
            autoComplete="off"
            placeholder={t('quick.placeholder')}
            value={text}
            aria-invalid={problem ? true : undefined}
            aria-describedby="quick-hint"
            onChange={(e) => {
              setText(e.target.value)
              setProblem(null)
            }}
          />
          <Button type="submit" disabled={!text.trim()}>
            {t('quick.go')}
          </Button>
        </div>
        <p id="quick-hint" role={problem ? 'alert' : undefined} className={`text-xs ${problem ? 'text-red-700' : 'text-slate-500'}`}>
          {problem ? t(`quick.errors.${problem.code}`, { name: problem.name }) : t('quick.hint')}
        </p>
      </form>
    </Card>
  )
}
