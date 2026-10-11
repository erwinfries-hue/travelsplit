// TravelSplit CSV schema v1 (docs/csv-schema-v1.md): one file per trip, ';' separated, UTF-8 with BOM,
// every row tagged with row_type. Amounts and rates are integers (minor units, rate × 10^10), so no
// locale can misread a decimal separator; *_display columns are for humans only and ignored on import.

export const CSV_SCHEMA_VERSION = 1
export const CSV_DELIMITER = ';'

export const CSV_COLUMNS = [
  'schema_version',
  'row_type',
  'row_id',
  'ref_id',
  'date',
  'title',
  'person_name',
  'counterparty_name',
  'currency',
  'amount_minor',
  'base_currency',
  'base_amount_minor',
  'split_mode',
  'share_value',
  'rate_scaled',
  'status',
  'category',
  'note',
  'amount_display',
] as const

export type CsvColumn = (typeof CSV_COLUMNS)[number]
export type CsvRow = Partial<Record<CsvColumn, string | number | bigint | null>>

const NUMERIC: ReadonlySet<CsvColumn> = new Set(['schema_version', 'amount_minor', 'base_amount_minor', 'share_value', 'rate_scaled'])

// Characters that make spreadsheet programs evaluate a cell, also behind leading blanks or control characters.
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be caught
const FORMULA_START = /^[\s\u0000-\u001f\u00a0\u200b-\u200f\u2028\u2029\ufeff]*[=+\-@\uff1d\uff0b\uff0d\uff20]/
const LEADING_CONTROL = /^[\t\r\n]/

/** Makes a text cell inert in Excel/LibreOffice/Numbers by prefixing a single quote (CSV injection). */
export function neutralize(text: string): string {
  const risky = FORMULA_START.test(text) || LEADING_CONTROL.test(text)
  // A text that already looks neutralized gets one more quote, so import restores it exactly.
  return risky || unneutralize(text) !== text ? `'${text}` : text
}

/** Reverses `neutralize` on import, so a title survives export → import unchanged. */
export function unneutralize(text: string): string {
  if (!text.startsWith("'")) return text
  const rest = text.slice(1)
  return FORMULA_START.test(rest) || LEADING_CONTROL.test(rest) || unneutralize(rest) !== rest ? rest : text
}

function cell(column: CsvColumn, value: CsvRow[CsvColumn]): string {
  if (value === null || value === undefined || value === '') return ''
  if (NUMERIC.has(column)) {
    const s = value.toString()
    if (!/^-?\d+$/.test(s)) throw new Error(`non-integer value in numeric column ${column}`)
    return s
  }
  return `"${neutralize(String(value)).replace(/"/g, '""')}"`
}

export function serializeCsv(rows: readonly CsvRow[]): string {
  const lines = [CSV_COLUMNS.join(CSV_DELIMITER)]
  for (const row of rows) lines.push(CSV_COLUMNS.map((c) => cell(c, row[c])).join(CSV_DELIMITER))
  // BOM: Excel otherwise opens UTF-8 as ANSI and breaks umlauts.
  return `\ufeff${lines.join('\r\n')}\r\n`
}

export class CsvParseError extends Error {
  readonly code: string
  readonly line: number
  constructor(code: string, line: number) {
    super(`${code} (line ${line})`)
    this.code = code
    this.line = line
  }
}

/** RFC 4180 parser; accepts ';' or ',' (detected from the header) and CRLF or LF line ends. */
export function parseCsv(text: string): { header: string[]; rows: { line: number; cells: Record<string, string> }[] } {
  const src = text.replace(/^\ufeff/, '')
  const firstLine = src.slice(0, src.search(/\r?\n|$/))
  const delimiter = firstLine.includes(';') ? ';' : ','
  const records: { line: number; cells: string[] }[] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  let line = 1
  let recordLine = 1
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else {
        if (ch === '\n') line++
        field += ch
      }
      continue
    }
    if (ch === '"') {
      if (field !== '') throw new CsvParseError('csv_bad_quote', line)
      quoted = true
    } else if (ch === delimiter) {
      record.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      record.push(field)
      records.push({ line: recordLine, cells: record })
      record = []
      field = ''
      line++
      recordLine = line
    } else field += ch
  }
  if (quoted) throw new CsvParseError('csv_unterminated_quote', recordLine)
  if (field !== '' || record.length) {
    record.push(field)
    records.push({ line: recordLine, cells: record })
  }
  const nonEmpty = records.filter((r) => r.cells.some((c) => c.trim() !== ''))
  if (nonEmpty.length === 0) throw new CsvParseError('csv_empty', 1)
  const header = nonEmpty[0].cells.map((h) => h.trim())
  if (!header.includes('row_type') || !header.includes('schema_version')) throw new CsvParseError('csv_not_travelsplit', 1)
  return {
    header,
    rows: nonEmpty.slice(1).map((r) => {
      if (r.cells.length !== header.length) throw new CsvParseError('csv_column_count', r.line)
      return { line: r.line, cells: Object.fromEntries(header.map((h, i) => [h, r.cells[i]])) }
    }),
  }
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
