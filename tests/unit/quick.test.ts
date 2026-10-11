import { describe, expect, it } from 'vitest'
import { parseEntry } from '../../src/domain/ingest/parse'
import { findPerson, percentToInput, resolveParticipants } from '../../src/domain/ingest/resolve'
import { PERCENT_SCALE } from '../../src/domain/money'
import { sharedText } from '../../src/features/quick/SharePage'

const people = [
  { id: 'e', display_name: 'Erwin', status: 'active' as const },
  { id: 'l', display_name: 'Larissa Müller', status: 'active' as const },
  { id: 'r', display_name: 'Roger', status: 'placeholder' as const },
  { id: 'x', display_name: 'Xaver', status: 'removed' as const },
]

const participants = (text: string) => {
  const r = parseEntry(text)
  if (!r.ok) throw new Error(r.reason)
  return r.entry.participants
}

describe('resolveParticipants', () => {
  it('nobody named or "alle" means all current members', () => {
    expect(resolveParticipants(participants('Taxi 20 EUR'), people)).toEqual({ ok: true, mode: 'equal', personIds: ['e', 'l', 'r'] })
    expect(resolveParticipants(participants('Taxi 20 EUR alle'), people)).toEqual({ ok: true, mode: 'equal', personIds: ['e', 'l', 'r'] })
  })

  it('matches first names case and accent insensitively', () => {
    expect(resolveParticipants(participants('Essen 85 EUR erwin LARISSA'), people)).toEqual({ ok: true, mode: 'equal', personIds: ['e', 'l'] })
    expect(findPerson(people, 'muller')).toEqual([])
    expect(findPerson([{ id: 'z', display_name: 'Zoë', status: 'active' }], 'Zoe')).toHaveLength(1)
  })

  it('reports unknown, removed and ambiguous names instead of guessing', () => {
    expect(resolveParticipants(participants('Essen 85 EUR Erwin Xaver'), people)).toEqual({ ok: false, reason: 'unknown_person', name: 'Xaver' })
    const twins = [...people, { id: 'e2', display_name: 'Erwin Fries', status: 'active' as const }]
    expect(resolveParticipants(participants('Essen 85 EUR Erwin'), twins)).toEqual({ ok: true, mode: 'equal', personIds: ['e'] })
    const twoErwins = [{ id: 'a', display_name: 'Erwin A', status: 'active' as const }, { id: 'b', display_name: 'Erwin B', status: 'active' as const }]
    expect(resolveParticipants(participants('Essen 85 EUR Erwin'), twoErwins)).toEqual({ ok: false, reason: 'ambiguous_person', name: 'Erwin' })
  })

  it('keeps percent shares per person', () => {
    const r = resolveParticipants(participants('Hotel 200 EUR 33,3333% Erwin 66,6667% Larissa'), people)
    expect(r).toEqual({ ok: true, mode: 'percent', personIds: ['e', 'l'], percents: { e: 333_333n, l: 666_667n } })
  })
})

describe('percentToInput', () => {
  it('formats scaled percents for the form', () => {
    expect(percentToInput(50n * PERCENT_SCALE, ',')).toBe('50')
    expect(percentToInput(333_333n, ',')).toBe('33,3333')
    expect(percentToInput(125_000n, '.')).toBe('12.5')
  })
})

describe('sharedText', () => {
  it('prefers text, falls back to title and caps the length', () => {
    expect(sharedText(new URLSearchParams({ text: ' Taxi 20 EUR ', title: 'x' }))).toBe('Taxi 20 EUR')
    expect(sharedText(new URLSearchParams({ title: 'Taxi 20 EUR' }))).toBe('Taxi 20 EUR')
    expect(sharedText(new URLSearchParams({ text: 'a'.repeat(500) }))).toHaveLength(300)
  })
})
