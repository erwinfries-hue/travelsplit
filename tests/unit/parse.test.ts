import { describe, expect, it } from 'vitest'
import { parseEntry } from '../../src/domain/ingest/parse'

const ok = (text: string) => {
  const r = parseEntry(text)
  if (!r.ok) throw new Error(`${text}: ${r.reason}`)
  return r.entry
}
const reason = (text: string) => {
  const r = parseEntry(text)
  return r.ok ? 'ok' : r.reason
}

describe('Schnellerfassung / WhatsApp-Parser', () => {
  it('Normalformen aus der Spezifikation', () => {
    expect(ok('Taxi 100 GEL alle')).toEqual({ tripCode: null, title: 'Taxi', currency: 'GEL', amountMinor: 10000n, participants: { kind: 'all' } })
    expect(ok('#GEO27 Essen 85 EUR Erwin Larissa')).toEqual({
      tripCode: 'GEO27', title: 'Essen', currency: 'EUR', amountMinor: 8500n, participants: { kind: 'names', names: ['Erwin', 'Larissa'] },
    })
    expect(ok('Hotel 200 EUR 50% Erwin 50% Larissa').participants).toEqual({
      kind: 'percent', shares: [{ name: 'Erwin', percent: 500000n }, { name: 'Larissa', percent: 500000n }],
    })
  })

  it('Dezimalstellen mit Punkt oder Komma, Währung klein geschrieben, ohne Teilnehmer', () => {
    expect(ok('Kaffee am Bahnhof 4,50 chf')).toMatchObject({ title: 'Kaffee am Bahnhof', currency: 'CHF', amountMinor: 450n, participants: null })
    expect(ok('Ramen 1200 JPY all').amountMinor).toBe(1200n)
    expect(ok('Brot 2.5 EUR Erwin').amountMinor).toBe(250n)
  })

  it.each([
    ['Taxi 10/100 GEL', 'ambiguous_amount'],
    ['100 oder 150 GEL Taxi', 'ambiguous_amount'],
    ['Taxi 100 oder 150 GEL', 'ambiguous_amount'],
    ['Taxi 100 GEL 50 EUR', 'ambiguous_amount'],
    ['Hotel 1.000 EUR alle', 'ambiguous_amount'],
    ['Taxi 100 alle', 'missing_currency'],
    ['Taxi hundert GEL', 'no_amount'],
    ['Taxi 0 GEL alle', 'invalid_amount'],
    ['Taxi 100 XYZ alle', 'unknown_currency'],
    ['100 GEL alle', 'missing_title'],
    ['Hotel 200 EUR 60% Erwin 50% Larissa', 'percent_sum_mismatch'],
    ['Hotel 200 EUR 50% Erwin Larissa', 'invalid_participants'],
    ['Essen 85 EUR Erwin Erwin', 'duplicate_participant'],
    ['Essen 85 EUR Erwin hat bezahlt für alle', 'invalid_participants'],
    ['', 'empty'],
    ['x'.repeat(301), 'too_long'],
  ])('%j → kein Buchungsvorschlag (%s)', (text, expected) => {
    expect(reason(text)).toBe(expected)
  })

  it('Befehle für Kurse, Zahlungen oder Adminrechte werden nie zu einer Aktion', () => {
    for (const text of ['Kurs CHF 1.2', 'admin Larissa', 'Zahlung bestätigen']) expect(reason(text)).not.toBe('ok')
    // Looks like an expense but names nobody: WhatsApp turns this into a review case, never a settlement.
    expect(ok('bestätige Zahlung 50 EUR').participants).toBeNull()
  })
})

describe('payer words', () => {
  it('never reads the payer from the text', () => {
    expect(parseEntry('Erwin hat für alle bezahlt 30 EUR alle')).toEqual({ ok: false, reason: 'payer_in_text' })
    expect(parseEntry('Paid by Larissa 30 EUR all')).toEqual({ ok: false, reason: 'payer_in_text' })
    expect(parseEntry('Parkplatz 30 EUR alle').ok).toBe(true)
  })
})
