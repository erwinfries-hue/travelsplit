// DATA-04 against a real spreadsheet engine (LibreOffice headless, formula evaluation ON).
// 1. Control: an unprotected CSV produces formula cells (proves the check can fail).
// 2. TravelSplit export of attack strings produces NO formula cells.
// 3. Save as xlsx, reopen and export back to CSV: TravelSplit reads every title back unchanged.
// Usage: node --experimental-strip-types tests/office/csv-injection.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCsv, serializeCsv, unneutralize } from '../../src/features/csv/csv.ts'

const dir = mkdtempSync(join(tmpdir(), 'ts-csv-'))
const IMPORT = 'CSV:59,34,76,1,,0,false,true,false,false,false,-1,true' // ';' "  UTF-8, evaluate formulas
const attacks = [
  '=HYPERLINK("http://evil.example","Klick")', '+1+cmd|"/c calc"!A0', '-2+3', '@SUM(1,2)',
  `${String.fromCharCode(9)}=1+1`, ' =1+1', `${String.fromCharCode(0xa0)}=1+1`,
  'Normal; mit "Zitat"\nzweite Zeile', 'Zürich – Genf ✈',
]

function toXlsx(name) {
  execFileSync('soffice', ['--headless', `--infilter=${IMPORT}`, '--convert-to', 'xlsx', '--outdir', dir, join(dir, name)], { stdio: 'ignore' })
  const sheet = execFileSync('unzip', ['-p', join(dir, name.replace(/\.csv$/, '.xlsx')), 'xl/worksheets/sheet1.xml']).toString()
  return (sheet.match(/<f[ >]/g) ?? []).length
}

let failed = 0
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)
  if (!ok) failed++
}

writeFileSync(join(dir, 'control.csv'), `schema_version;row_type;title\n1;expense;=1+1\n1;expense;"=2+2"\n`)
check('control: unprotected cells are evaluated as formulas (quotes alone do not help)', toXlsx('control.csv') === 2)

const rows = attacks.map((title, i) => ({ schema_version: 1, row_type: 'expense', row_id: `R${i}`, title }))
writeFileSync(join(dir, 'export.csv'), serializeCsv(rows))
check('TravelSplit export: no formula cells', toXlsx('export.csv') === 0)

execFileSync('soffice', ['--headless', '--convert-to', 'csv:Text - txt - csv (StarCalc):59,34,76,1', '--outdir', join(dir, 'back'), join(dir, 'export.xlsx')], { stdio: 'ignore' })
const back = parseCsv(readFileSync(join(dir, 'back', 'export.csv'), 'utf8')).rows.map((r) => unneutralize(r.cells.title))
const lead = (s) => s.replace(/^[\t ]+/, '') // spreadsheets may trim leading blanks/tabs
check('after save + reopen every title is read back (modulo leading blanks)', back.every((t, i) => lead(t) === lead(attacks[i])))
console.log(failed ? `${failed} check(s) failed` : 'all checks passed')
process.exit(failed ? 1 : 0)
