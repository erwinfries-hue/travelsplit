// Maps the names of a parsed quick entry onto the people of one trip.
// Matching is exact after case and accent folding, on the full name or its first word; anything
// unknown or ambiguous is reported back instead of guessed.
import { PERCENT_SCALE } from '../money/split'
import type { Participants } from './parse'

export interface ResolvablePerson {
  id: string
  display_name: string
  status: 'placeholder' | 'active' | 'removed'
}

export type ResolvedParticipants =
  | { ok: true; mode: 'equal'; personIds: string[] }
  | { ok: true; mode: 'percent'; personIds: string[]; percents: Record<string, bigint> }
  | { ok: false; reason: 'unknown_person' | 'ambiguous_person'; name: string }

export function foldName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

export function findPerson<P extends ResolvablePerson>(people: P[], name: string): P[] {
  const wanted = foldName(name)
  const candidates = people.filter((p) => p.status !== 'removed')
  const full = candidates.filter((p) => foldName(p.display_name) === wanted)
  if (full.length > 0) return full
  return candidates.filter((p) => foldName(p.display_name).split(/\s+/)[0] === wanted)
}

/** null participants (nobody named) and "alle" both mean every current member of the trip. */
export function resolveParticipants(participants: Participants | null, people: ResolvablePerson[]): ResolvedParticipants {
  const everyone = people.filter((p) => p.status !== 'removed').map((p) => p.id)
  if (!participants || participants.kind === 'all') return { ok: true, mode: 'equal', personIds: everyone }
  const names = participants.kind === 'names' ? participants.names : participants.shares.map((s) => s.name)
  const ids: string[] = []
  for (const name of names) {
    const hits = findPerson(people, name)
    if (hits.length === 0) return { ok: false, reason: 'unknown_person', name }
    if (hits.length > 1) return { ok: false, reason: 'ambiguous_person', name }
    if (ids.includes(hits[0].id)) return { ok: false, reason: 'ambiguous_person', name }
    ids.push(hits[0].id)
  }
  if (participants.kind === 'names') return { ok: true, mode: 'equal', personIds: ids }
  const percents: Record<string, bigint> = {}
  participants.shares.forEach((s, i) => (percents[ids[i]] = s.percent))
  return { ok: true, mode: 'percent', personIds: ids, percents }
}

/** Percent value as the form shows it ("33,3333"), using the given decimal separator. */
export function percentToInput(scaled: bigint, decimalSep: string): string {
  const whole = scaled / PERCENT_SCALE
  const frac = (scaled % PERCENT_SCALE).toString().padStart(4, '0').replace(/0+$/, '')
  return frac ? `${whole}${decimalSep}${frac}` : `${whole}`
}
