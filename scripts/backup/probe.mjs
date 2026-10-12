// R4 backup/restore probe on two LOCAL Supabase stacks (never against a hosted project).
//
//   source:  the repo's stack (npx supabase start)
//   target:  a second, isolated stack in RESTORE_STACK_DIR with its own ports and project_id
//
// Builds a trip with Erwin, Larissa and Roger (several currencies, an FX change, a confirmed
// settlement, two receipt photos, a closing snapshot), runs backup.sh, wipes the target, runs
// restore.sh and proves on the target that balances, photos and snapshots are identical and that a
// fourth user sees nothing. Writes a JSON report to PROBE_OUT (default ./probe-out).
import { execFileSync, execSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

const REPO = resolve(import.meta.dirname, '../..')
const TARGET_DIR = process.env.RESTORE_STACK_DIR
if (!TARGET_DIR) throw new Error('RESTORE_STACK_DIR missing (directory with a second supabase/config.toml)')
const OUT = resolve(process.env.PROBE_OUT ?? 'probe-out')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const status = (cwd) => JSON.parse(execSync('npx --prefix ' + REPO + ' supabase status -o json', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString())
const source = status(REPO)
const target = status(TARGET_DIR)
for (const env of [source, target]) {
  if (!['127.0.0.1', 'localhost'].includes(new URL(env.API_URL).hostname)) throw new Error(`not local: ${env.API_URL}`)
}
if (source.API_URL === target.API_URL) throw new Error('source and target must be different stacks')

const log = []
const step = (msg) => {
  log.push(msg)
  console.log(`• ${msg}`)
}
const check = (name, ok, detail) => {
  log.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) results.failed.push(name)
  results.checks.push({ name, ok, detail: detail ?? null })
}
const results = { started_at: new Date().toISOString(), checks: [], failed: [] }
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const anon = (env) => createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const admin = (env) => createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

async function call(client, fn, args = {}) {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data
}

const run = randomUUID().slice(0, 8)
const PASSWORD = `probe-${randomUUID()}`
const srcDb = new pg.Client({ connectionString: source.DB_URL })
await srcDb.connect()

async function makeUser(env, db, key, { creator = false } = {}) {
  const email = `probe-${run}-${key}@test.travelsplit.local`
  const { data, error } = await admin(env).auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
  if (error) throw error
  const id = data.user.id
  await db.query(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values ($1, $2, $3, 'google', now(), now(), now())`,
    [`google-${id}`, id, JSON.stringify({ sub: `google-${id}`, email, email_verified: true })],
  )
  if (creator) await db.query(`select private.operator_grant_creator($1, 'r4-probe')`, [email])
  return { id, email, client: await signIn(env, email) }
}

async function signIn(env, email) {
  const client = anon(env)
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`sign-in ${email}: ${error.message}`)
  return client
}

// ---------------------------------------------------------------- 1. build the probe trip
step(`Run ${run}: building probe trip on source ${source.API_URL}`)
const erwin = await makeUser(source, srcDb, 'erwin', { creator: true })
const larissa = await makeUser(source, srcDb, 'larissa')
const roger = await makeUser(source, srcDb, 'roger')
for (const [u, name] of [[erwin, 'Erwin'], [larissa, 'Larissa'], [roger, 'Roger']]) {
  await call(u.client, 'upsert_my_profile', { p_display_name: name })
}
const tripId = await call(erwin.client, 'create_trip', {
  p_title: `R4-Probe ${run}`, p_base_currency: 'EUR', p_admin_display_name: 'Erwin',
  p_start_date: '2026-09-20', p_end_date: '2026-09-27',
})
const person = { erwin: (await srcDb.query('select id from public.trip_people where trip_id=$1 and linked_user_id=$2', [tripId, erwin.id])).rows[0].id }
for (const [u, name] of [[larissa, 'Larissa'], [roger, 'Roger']]) {
  const pid = await call(erwin.client, 'add_trip_person', { p_trip_id: tripId, p_display_name: name })
  const inv = await call(erwin.client, 'create_invitation', { p_person_id: pid, p_valid_days: 7 })
  const res = await call(u.client, 'redeem_invitation', { p_token: inv.token, p_display_name: name })
  if (res.status !== 'joined') throw new Error(`${name} did not join: ${res.status}`)
  person[name.toLowerCase()] = pid
}
const openToken = (await call(erwin.client, 'create_invitation', {
  p_person_id: await call(erwin.client, 'add_trip_person', { p_trip_id: tripId, p_display_name: 'Platzhalter' }),
  p_valid_days: 7,
})).token

await call(erwin.client, 'set_fx_rate', { p_trip_id: tripId, p_currency: 'CHF', p_eur_per_unit: 1.07 })
await call(erwin.client, 'set_fx_rate', { p_trip_id: tripId, p_currency: 'USD', p_eur_per_unit: 0.92 })

const everyone = ['erwin', 'larissa', 'roger'].map((k) => ({ person_id: person[k], value: null }))
async function expense(u, payerKey, title, currency, minor, mode = 'equal', participants = everyone) {
  return call(u.client, 'create_expense', {
    p_trip_id: tripId, p_idempotency_key: randomUUID(), p_title: title, p_expense_date: '2026-09-21',
    p_currency: currency, p_original_minor: minor, p_split_mode: mode, p_participants: participants,
    p_paid_by_person_id: person[payerKey], p_category: 'other', p_note: null,
  })
}
const e1 = await expense(erwin, 'erwin', 'Apartment', 'EUR', 30000)
const e2 = await expense(larissa, 'larissa', 'Zugtickets', 'CHF', 15000)
await expense(roger, 'roger', 'Mietwagen', 'USD', 9000, 'percent', [
  { person_id: person.erwin, value: 500000 }, { person_id: person.larissa, value: 250000 }, { person_id: person.roger, value: 250000 },
])
await call(erwin.client, 'set_fx_rate', { p_trip_id: tripId, p_currency: 'CHF', p_eur_per_unit: 1.05, p_expected_revision: 1 })
step('Trip with 3 currencies (EUR, CHF, USD) and one FX change (CHF 1.07 → 1.05)')

const settlementId = await call(roger.client, 'report_settlement', {
  p_trip_id: tripId, p_idempotency_key: randomUUID(), p_receiver_person_id: person.erwin,
  p_currency: 'CHF', p_original_minor: 5000, p_note: 'Twint',
})
await call(erwin.client, 'confirm_settlement', { p_settlement_id: settlementId })
step('Settlement CHF 50.00 Roger → Erwin reported and confirmed')

const photos = []
for (const [u, expenseId, file] of [[erwin, e1, 'receipt-1.jpg'], [larissa, e2, 'receipt-2.jpg']]) {
  const bytes = readFileSync(join(REPO, 'tests/fixtures', file))
  const path = `${tripId}/${expenseId}/${randomUUID()}.jpg`
  const { error } = await u.client.storage.from('receipts').upload(path, bytes, { contentType: 'image/jpeg' })
  if (error) throw error
  await call(u.client, 'attach_receipt', { p_expense_id: expenseId, p_storage_path: path, p_sha256: sha(bytes) })
  photos.push({ path, sha256: sha(bytes) })
}
step('Two receipt photos uploaded and attached')

await call(erwin.client, 'archive_trip', { p_trip_id: tripId, p_accept_open_balances: true })
step('Trip archived with closing snapshot')

// Expected state, read through the normal member API on the source.
async function observe(env, clients) {
  const out = {}
  for (const [key, client] of Object.entries(clients)) {
    const balances = await call(client, 'trip_balances', { p_trip_id: tripId })
    out[key] = { balances: [...balances].sort((a, b) => a.person_id.localeCompare(b.person_id)) }
  }
  const c = clients.erwin
  const { data: settlements } = await c.from('settlements').select('id,status,original_minor,currency,confirmed_base_minor,confirmed_from_rate::text,confirmed_base_rate::text,confirmed_base_currency').eq('trip_id', tripId)
  const { data: closures } = await c.from('trip_closures').select('version,snapshot,snapshot_sha256').eq('trip_id', tripId)
  const { data: rates } = await c.from('trip_fx_rates').select('currency,eur_per_unit::text,revision').eq('trip_id', tripId).order('currency')
  const { count: audit } = await c.from('audit_events').select('id', { count: 'exact', head: true }).eq('trip_id', tripId)
  const files = []
  for (const p of photos) {
    const { data, error } = await clients.larissa.storage.from('receipts').download(p.path)
    files.push(error ? { path: p.path, error: error.message } : { path: p.path, sha256: sha(Buffer.from(await data.arrayBuffer())) })
  }
  return { members: out, settlements, closures, rates, audit, files }
}
const expected = await observe(source, { erwin: erwin.client, larissa: larissa.client, roger: roger.client })
check('source: photos readable by member with correct hash', expected.files.every((f, i) => f.sha256 === photos[i].sha256))
await srcDb.end()

// ---------------------------------------------------------------- 2. backup
const ageKey = join(OUT, 'probe-age-key.txt')
execFileSync('age-keygen', ['-o', ageKey], { stdio: 'ignore' })
const recipient = readFileSync(ageKey, 'utf8').match(/public key: (age1\w+)/)[1]
const pgDumpWrapper = join(OUT, 'pg_dump-in-container.sh')
// The host pg_dump may be older than the server (17); run the server's own pg_dump inside its container.
writeFileSync(pgDumpWrapper, `#!/usr/bin/env bash\nexec docker exec -i supabase_db_travelsplit pg_dump "\${@//:54322\\//:5432/}"\n`, { mode: 0o755 })
step('Running backup.sh')
execFileSync(join(REPO, 'scripts/backup/backup.sh'), {
  stdio: 'inherit',
  env: {
    ...process.env, SUPABASE_DB_URL: source.DB_URL, SUPABASE_URL: source.API_URL, SUPABASE_SECRET_KEY: source.SERVICE_ROLE_KEY,
    BACKUP_AGE_RECIPIENT: recipient, BACKUP_OUT_DIR: join(OUT, 'backups'), PG_DUMP: pgDumpWrapper,
  },
})
const archive = join(OUT, 'backups', readdirSync(join(OUT, 'backups')).find((f) => f.endsWith('.tar.age')))
const plaintextLeak = readFileSync(archive).includes(Buffer.from(erwin.email))
check('archive is encrypted (no plaintext e-mail inside)', !plaintextLeak)

// ---------------------------------------------------------------- 3. fresh isolated target
step(`Resetting isolated target ${target.API_URL}`)
rmSync(join(TARGET_DIR, 'supabase/migrations'), { recursive: true, force: true })
cpSync(join(REPO, 'supabase/migrations'), join(TARGET_DIR, 'supabase/migrations'), { recursive: true })
execSync(`npx --prefix ${REPO} supabase db reset`, { cwd: TARGET_DIR, stdio: 'ignore' })
const restoreEnv = {
  ...process.env, RESTORE_DB_URL: target.DB_URL, RESTORE_SUPABASE_URL: target.API_URL,
  RESTORE_SECRET_KEY: target.SERVICE_ROLE_KEY, RESTORE_CONFIRM_HOST: new URL(target.API_URL).host,
}
let wrongHostRefused = false
try {
  execFileSync(join(REPO, 'scripts/backup/restore.sh'), [archive, ageKey], { stdio: 'ignore', env: { ...restoreEnv, RESTORE_CONFIRM_HOST: 'wrong.example' } })
} catch { wrongHostRefused = true }
check('restore refuses when the confirm host does not match', wrongHostRefused)

step('Running restore.sh')
execFileSync(join(REPO, 'scripts/backup/restore.sh'), [archive, ageKey], { stdio: 'inherit', env: restoreEnv })

let secondRestoreRefused = false
try {
  execFileSync(join(REPO, 'scripts/backup/restore.sh'), [archive, ageKey], { stdio: 'ignore', env: restoreEnv })
} catch { secondRestoreRefused = true }
check('restore refuses a non-empty target', secondRestoreRefused)

// ---------------------------------------------------------------- 4. verify on target
const restored = {
  erwin: await signIn(target, erwin.email),
  larissa: await signIn(target, larissa.email),
  roger: await signIn(target, roger.email),
}
check('all three users can sign in on the restored project with their old credentials', true)
const actual = await observe(target, restored)
for (const key of ['erwin', 'larissa', 'roger']) {
  check(`balances identical as seen by ${key}`, JSON.stringify(actual.members[key]) === JSON.stringify(expected.members[key]))
}
check('confirmed settlement snapshot identical', JSON.stringify(actual.settlements) === JSON.stringify(expected.settlements)
  && expected.settlements.some((s) => s.status === 'confirmed'))
check('FX rates and revisions identical', JSON.stringify(actual.rates) === JSON.stringify(expected.rates))
check('closing snapshot and its SHA-256 identical', JSON.stringify(actual.closures) === JSON.stringify(expected.closures)
  && expected.closures.length === 1)
check('audit trail complete', actual.audit === expected.audit, `${actual.audit} events`)
check('both photos restored with identical SHA-256', JSON.stringify(actual.files) === JSON.stringify(expected.files))

const tgtDb = new pg.Client({ connectionString: target.DB_URL })
await tgtDb.connect()
const recomputed = await tgtDb.query(
  `select encode(extensions.digest(snapshot::text, 'sha256'), 'hex') = snapshot_sha256 as ok from public.trip_closures where trip_id = $1`,
  [tripId],
)
check('closing snapshot hash recomputed on target matches its content', recomputed.rows.length === 1 && recomputed.rows[0].ok)
const mallory = await makeUser(target, tgtDb, 'mallory')
await tgtDb.end()
const { data: seenTrips } = await mallory.client.from('trips').select('id')
check('4th user sees no trips', (seenTrips ?? []).length === 0)
const { error: balErr } = await mallory.client.rpc('trip_balances', { p_trip_id: tripId })
const { data: balData } = await mallory.client.rpc('trip_balances', { p_trip_id: tripId })
check('4th user gets no balances', Boolean(balErr) || (balData ?? []).length === 0, balErr?.message)
const { error: photoErr } = await mallory.client.storage.from('receipts').download(photos[0].path)
check('4th user cannot download a photo', Boolean(photoErr))
const { error: redeemErr } = await mallory.client.rpc('redeem_invitation', { p_token: openToken, p_display_name: 'Mallory' })
check('4th user cannot join with a still-open invitation link of the closed trip', Boolean(redeemErr), redeemErr?.message)
const { data: expRows } = await mallory.client.from('expenses').select('id').eq('trip_id', tripId)
check('4th user reads no expenses', (expRows ?? []).length === 0)

results.finished_at = new Date().toISOString()
results.run = run
results.log = log
writeFileSync(join(OUT, 'probe-report.json'), JSON.stringify({ ...results, expected, actual }, null, 2))
rmSync(ageKey)
console.log(results.failed.length ? `\n${results.failed.length} check(s) FAILED` : `\nAll ${results.checks.length} checks passed`)
process.exit(results.failed.length ? 1 : 0)
