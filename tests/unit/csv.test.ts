import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { CSV_COLUMNS, neutralize, parseCsv, serializeCsv, unneutralize } from '../../src/features/csv/csv'

const TAB = String.fromCharCode(9)
const CR = String.fromCharCode(13)
const NBSP = String.fromCharCode(0xa0)
const FULLWIDTH_EQUALS = String.fromCharCode(0xff1d)

describe('DATA-04: CSV-Injection', () => {
  const attacks = [
    '=HYPERLINK("http://evil.example","Klick")',
    '+1+cmd|"/c calc"!A0',
    '-2+3',
    '@SUM(A1:A2)',
    `${TAB}=1+1`,
    `${CR}=1+1`,
    ` =1+1`,
    `${NBSP}=1+1`,
    `${FULLWIDTH_EQUALS}1+1`,
  ]
  it.each(attacks)('%j wird mit Apostroph entschärft', (text) => {
    expect(neutralize(text).startsWith("'")).toBe(true)
  })
  it('harmlose Texte bleiben unverändert', () => {
    for (const text of ['Abendessen', 'Taxi 3-4 Personen', 'E-Mail: a@b.ch', '100 % Spass', 'Zürich – Genf']) {
      expect(neutralize(text)).toBe(text)
    }
  })
  it('jede Formelzelle steht im Export in Anführungszeichen mit Apostroph', () => {
    const csv = serializeCsv([{ schema_version: 1, row_type: 'expense', title: '=1+1', note: '@x' }])
    expect(csv).toContain(`"'=1+1"`)
    expect(csv).toContain(`"'@x"`)
  })
  it("Text, der schon mit Apostroph und Formelzeichen beginnt, übersteht den Roundtrip", () => {
    expect(unneutralize(neutralize("'=abc"))).toBe("'=abc")
  })
  it('neutralize/unneutralize sind exakt umkehrbar (Property)', () => {
    const alphabet = ["'", '=', '+', '-', '@', ' ', 'a', TAB, CR]
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...alphabet), { maxLength: 8 }).map((a) => a.join('')), (text) => {
        expect(unneutralize(neutralize(text))).toBe(text)
      }),
      { numRuns: 2000 },
    )
  })
  it('Zahlenspalten akzeptieren nur ganze Zahlen', () => {
    expect(() => serializeCsv([{ amount_minor: '=1+1' }])).toThrow()
    expect(() => serializeCsv([{ amount_minor: '12.40' }])).toThrow()
  })
})

describe('CSV-Format', () => {
  it('UTF-8 mit BOM, Semikolon, CRLF, feste Kopfzeile', () => {
    const csv = serializeCsv([])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toBe(`${String.fromCharCode(0xfeff)}${CSV_COLUMNS.join(';')}\r\n`)
  })

  it('Roundtrip: Semikolon, Anführungszeichen, Zeilenumbrüche, Unicode und Formeln überleben', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: 'binary', maxLength: 40 }), { minLength: 1, maxLength: 5 }), (texts) => {
        const rows = texts.map((title) => ({ schema_version: 1, row_type: 'expense', title, note: `${title};"x"\n${title}` }))
        const parsed = parseCsv(serializeCsv(rows)).rows
        expect(parsed.map((r) => unneutralize(r.cells.title))).toEqual(texts)
        expect(parsed.map((r) => unneutralize(r.cells.note))).toEqual(rows.map((r) => r.note))
      }),
      { numRuns: 300 },
    )
  })

  it('liest auch Komma-getrennte Dateien und LF-Zeilenenden', () => {
    const { rows } = parseCsv('schema_version,row_type,title\n1,expense,"a, b"\n')
    expect(rows[0].cells.title).toBe('a, b')
  })

  it('lehnt fremde oder kaputte Dateien ab', () => {
    expect(() => parseCsv('a;b\n1;2')).toThrow(/csv_not_travelsplit/)
    expect(() => parseCsv('schema_version;row_type\n1;"offen')).toThrow(/csv_unterminated_quote/)
    expect(() => parseCsv('schema_version;row_type\n1;expense;zu viel')).toThrow(/csv_column_count/)
    expect(() => parseCsv('')).toThrow(/csv_empty/)
  })
})
