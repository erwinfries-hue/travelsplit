// UX-03: every text the app can show exists in German and English.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { de } from '../../src/i18n/de'
import { en } from '../../src/i18n/en'

type Tree = { [k: string]: string | Tree }

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv)
  }
  return out
}

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(f) ? [p] : []
  })
}

const DE = flatten(de as unknown as Tree)
const EN = flatten(en as unknown as Tree)
const has = (key: string) => DE.has(key) || DE.has(`${key}_one`) || DE.has(`${key}_other`)
const source = files('src', /\.(ts|tsx)$/).map((f) => readFileSync(f, 'utf8')).join('\n')
const sql = files('supabase/migrations', /\.sql$/).map((f) => readFileSync(f, 'utf8')).join('\n')
const unique = (xs: Iterable<string>) => [...new Set(xs)].sort()

describe('UX-03: Übersetzungen', () => {
  it('Deutsch und Englisch haben genau dieselben Schlüssel, keiner ist leer', () => {
    expect([...EN.keys()].sort()).toEqual([...DE.keys()].sort())
    for (const [k, v] of [...DE, ...EN]) expect(v.trim(), k).not.toBe('')
  })

  it('jeder im Code verwendete Schlüssel existiert', () => {
    const direct = [...source.matchAll(/\bt\(\s*'([a-zA-Z_]+(?:\.[a-zA-Z_]+)+)'/g)].map((m) => m[1])
    // t(cond ? 'a.b' : 'c.d', …)
    const ternary = [...source.matchAll(/\bt\(\s*[^()?]*\?\s*'([a-zA-Z_.]+)'\s*:\s*'([a-zA-Z_.]+)'/g)].flatMap((m) => [m[1], m[2]])
    const used = unique([...direct, ...ternary])
    expect(ternary.length).toBeGreaterThan(0)
    expect(used.filter((k) => !has(k))).toEqual([])
  })

  it('jeder Fehlercode des Servers und der Geldlogik hat einen Text', () => {
    const server = [...sql.matchAll(/private\.fail(?:_row)?\('([a-z_]+)'/g)].map((m) => m[1])
    const client = [...source.matchAll(/new (?:MoneyError|AppError|ImageError|CsvParseError)\('([a-z_]+)'/g)].map((m) => m[1])
    const viaMessage = [...source.matchAll(/toAppError\(\{ message: '([a-z_]+)' \}\)/g)].map((m) => m[1])
    expect(unique([...server, ...client, ...viaMessage]).filter((c) => !DE.has(`errors.${c}`))).toEqual([])
  })

  it('jede Verlaufsaktion und jede Mitteilung hat einen Text', () => {
    const actions = [...sql.matchAll(/'((?:trip|person|expense|fx|settlement|invitation|claim|operator|import|whatsapp)\.[a-z_]+)'/g)].map((m) => m[1])
    expect(unique(actions).filter((a) => !DE.has(`audit.${a}`))).toEqual([])
    const kinds = [
      ...sql.matchAll(/notify_(?:user|members)\([^;]*?'([a-z_]+)'\s*,\s*(?:jsonb_build_object|'\{\}')/gs),
      ...sql.matchAll(/case when p_approve then '(claim_[a-z_]+)' else '(claim_[a-z_]+)'/g),
      ...sql.matchAll(/'(trip_deleted)', jsonb_build_object/g),
    ].flatMap((m) => m.slice(1).filter(Boolean))
    expect(kinds.length).toBeGreaterThan(5)
    expect(unique(kinds).filter((k) => !DE.has(`notices.${k}`))).toEqual([])
  })
})
