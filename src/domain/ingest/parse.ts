// Deterministic quick-entry parser (WA-BOOK §6), shared by the PWA quick entry and the WhatsApp adapter.
// No guessing: anything not matching the documented forms is reported with a reason, never auto-booked.
//
//   [#CODE] <description> <amount> <CUR> [alle|all | Name Name … | 50% Name 50% Name …]
//
// Examples: "Taxi 100 GEL alle", "#GEO27 Essen 85 EUR Erwin Larissa", "Hotel 200 EUR 50% Erwin 50% Larissa"
import { parseAmount } from '../money/amount.ts'
import { isSupportedCurrency, MoneyError } from '../money/currencies.ts'
import { PERCENT_SCALE } from '../money/split.ts'

/** Percent values use the split scale: 100 % = 100 × PERCENT_SCALE. */
export type Participants = { kind: 'all' } | { kind: 'names'; names: string[] } | { kind: 'percent'; shares: { name: string; percent: bigint }[] }

export interface ParsedEntry {
  tripCode: string | null
  title: string
  currency: string
  amountMinor: bigint
  /** null when the message names nobody; the PWA then preselects everyone, WhatsApp asks for review. */
  participants: Participants | null
}

export type ParseResult = { ok: true; entry: ParsedEntry } | { ok: false; reason: ParseFailure }

export type ParseFailure =
  | 'empty'
  | 'too_long'
  | 'no_amount'
  | 'missing_currency'
  | 'ambiguous_amount'
  | 'invalid_amount'
  | 'unknown_currency'
  | 'missing_title'
  | 'invalid_participants'
  | 'percent_sum_mismatch'
  | 'duplicate_participant'
  | 'payer_in_text'

// Who paid is never read from the text: the sender is the payer (R2). Such messages go to review.
const PAYER_WORDS = /(^|\s)(bezahlt|bezahlte|gezahlt|zahlt|zahlte|paid|pays|payed|bezahlen|pay)(\s|$)/i
const ALL = new Set(['alle', 'all', 'everyone', 'jeder'])
const MAX_LENGTH = 300
const NUMBER = /^\d+(?:[.,]\d+)?$/
const HAS_DIGIT = /\d/
const NAME = /^[\p{L}][\p{L}\p{M}'’.-]{0,59}$/u
const CODE = /^#([A-Za-z0-9]{2,12})$/

export function parseEntry(input: string): ParseResult {
  const text = input.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (!text) return { ok: false, reason: 'empty' }
  if (text.length > MAX_LENGTH) return { ok: false, reason: 'too_long' }
  const tokens = text.split(' ')

  let tripCode: string | null = null
  const code = CODE.exec(tokens[0])
  if (code) {
    tripCode = code[1].toUpperCase()
    tokens.shift()
  }

  // Exactly one "<number> <ISO currency>" pair; any other figure makes the message ambiguous.
  const amountAt: number[] = []
  tokens.forEach((tok, i) => {
    if (NUMBER.test(tok) && i + 1 < tokens.length && /^[A-Za-z]{3}$/.test(tokens[i + 1])) amountAt.push(i)
  })
  if (amountAt.length === 0) {
    const numbers = tokens.filter((t) => NUMBER.test(t)).length
    return { ok: false, reason: numbers === 1 && !tokens.some((t) => HAS_DIGIT.test(t) && !NUMBER.test(t)) ? 'missing_currency' : tokens.some((t) => HAS_DIGIT.test(t)) ? 'ambiguous_amount' : 'no_amount' }
  }
  if (amountAt.length > 1) return { ok: false, reason: 'ambiguous_amount' }
  const at = amountAt[0]
  const currency = tokens[at + 1].toUpperCase()
  if (!isSupportedCurrency(currency)) return { ok: false, reason: 'unknown_currency' }

  const titleTokens = tokens.slice(0, at)
  const rest = tokens.slice(at + 2)
  if (titleTokens.length === 0) return { ok: false, reason: 'missing_title' }
  if (titleTokens.some((t) => HAS_DIGIT.test(t) && /[\d][/:x×-]|[/:x×-][\d]|^\d/.test(t))) return { ok: false, reason: 'ambiguous_amount' }
  const title = titleTokens.join(' ')
  if (PAYER_WORDS.test(title)) return { ok: false, reason: 'payer_in_text' }
  if (title.length > 120) return { ok: false, reason: 'too_long' }

  let amountMinor: bigint
  try {
    amountMinor = parseAmount(tokens[at], currency)
  } catch (e) {
    return { ok: false, reason: e instanceof MoneyError && e.code === 'too_many_decimals' ? 'ambiguous_amount' : 'invalid_amount' }
  }

  const participants = parseParticipants(rest)
  if (participants && 'reason' in participants) return { ok: false, reason: participants.reason }
  return { ok: true, entry: { tripCode, title, currency, amountMinor, participants } }
}

function parseParticipants(rest: string[]): Participants | null | { reason: ParseFailure } {
  if (rest.length === 0) return null
  if (rest.length === 1 && ALL.has(rest[0].toLowerCase())) return { kind: 'all' }
  if (rest.some((t) => t.endsWith('%'))) {
    if (rest.length % 2 !== 0) return { reason: 'invalid_participants' }
    const shares: { name: string; percent: bigint }[] = []
    for (let i = 0; i < rest.length; i += 2) {
      const pct = /^(\d{1,3})(?:[.,](\d{1,4}))?%$/.exec(rest[i])
      if (!pct || !NAME.test(rest[i + 1])) return { reason: 'invalid_participants' }
      const scaled = BigInt(pct[1]) * PERCENT_SCALE + BigInt((pct[2] ?? '').padEnd(4, '0'))
      shares.push({ name: rest[i + 1], percent: scaled })
    }
    if (shares.reduce((a, s) => a + s.percent, 0n) !== 100n * PERCENT_SCALE) return { reason: 'percent_sum_mismatch' }
    if (hasDuplicates(shares.map((s) => s.name))) return { reason: 'duplicate_participant' }
    return { kind: 'percent', shares }
  }
  if (!rest.every((t) => NAME.test(t)) || rest.some((t) => ALL.has(t.toLowerCase()))) return { reason: 'invalid_participants' }
  if (hasDuplicates(rest)) return { reason: 'duplicate_participant' }
  return { kind: 'names', names: rest }
}

function hasDuplicates(names: string[]): boolean {
  return new Set(names.map((n) => n.toLowerCase())).size !== names.length
}
