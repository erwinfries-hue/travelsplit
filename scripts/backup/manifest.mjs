// Backup manifest: migration versions, row counts and file hashes.
// Usage: node manifest.mjs write <workdir> <stamp>                 (SUPABASE_DB_URL)
//        node manifest.mjs verify-files <workdir>
//        node manifest.mjs check-migrations <workdir> <versions.txt>
//        node manifest.mjs verify-db <workdir>                      (RESTORE_DB_URL)
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import pg from 'pg'

const [cmd, work, arg] = process.argv.slice(2)

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function hashTree() {
  const files = {}
  for (const entry of await readdir(work, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    const rel = relative(work, full)
    if (rel === 'manifest.json' || rel === 'target-migrations.txt') continue
    files[rel] = await sha256(full)
  }
  return files
}

async function snapshot(connectionString) {
  const db = new pg.Client({ connectionString })
  await db.connect()
  try {
    const tables = await db.query(`
      select table_schema || '.' || table_name as name from information_schema.tables
      where table_type = 'BASE TABLE' and (table_schema in ('public', 'private')
        or (table_schema = 'auth' and table_name in ('users', 'identities')))
      order by 1`)
    const counts = {}
    for (const { name } of tables.rows) {
      const [schema, table] = name.split('.')
      const r = await db.query(`select count(*)::int as n from "${schema}"."${table}"`)
      counts[name] = r.rows[0].n
    }
    const migrations = (await db.query('select version from supabase_migrations.schema_migrations order by version')).rows.map((r) => r.version)
    const receipts = (await db.query('select storage_path, sha256, size_bytes from public.receipt_files order by storage_path')).rows
    return { counts, migrations, receipts }
  } finally {
    await db.end()
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const manifestPath = () => join(work, 'manifest.json')
const readManifest = async () => JSON.parse(await readFile(manifestPath(), 'utf8'))

if (cmd === 'write') {
  const snap = await snapshot(process.env.SUPABASE_DB_URL)
  const files = await hashTree()
  for (const r of snap.receipts) {
    const hash = files[join('storage', 'receipts', r.storage_path)]
    if (hash !== r.sha256) fail(`receipt ${r.storage_path} missing or hash mismatch in export`)
  }
  await writeFile(manifestPath(), JSON.stringify({ format: 1, created_at: arg, ...snap, files }, null, 2))
} else if (cmd === 'verify-files') {
  const manifest = await readManifest()
  const files = await hashTree()
  for (const [rel, hash] of Object.entries(manifest.files)) {
    if (files[rel] !== hash) fail(`file ${rel} missing or corrupted`)
  }
  console.log(`${Object.keys(manifest.files).length} files verified`)
} else if (cmd === 'check-migrations') {
  const manifest = await readManifest()
  const target = (await readFile(arg, 'utf8')).split('\n').filter(Boolean)
  if (JSON.stringify(target) !== JSON.stringify(manifest.migrations)) {
    fail(`migration mismatch\n backup: ${manifest.migrations.join(',')}\n target: ${target.join(',')}`)
  }
  console.log(`migrations match (${target.length})`)
} else if (cmd === 'verify-db') {
  const manifest = await readManifest()
  const snap = await snapshot(process.env.RESTORE_DB_URL)
  const problems = []
  for (const [table, n] of Object.entries(manifest.counts)) {
    if (snap.counts[table] !== n) problems.push(`${table}: expected ${n}, got ${snap.counts[table]}`)
  }
  if (JSON.stringify(snap.receipts) !== JSON.stringify(manifest.receipts)) problems.push('receipt_files differ')
  if (problems.length) fail(problems.join('\n'))
  console.log(`${Object.keys(manifest.counts).length} tables match`)
} else {
  fail('unknown command')
}
