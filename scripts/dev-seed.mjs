// Local development seed: three test users and a demo trip on the LOCAL Supabase stack.
// Refuses to run against anything but 127.0.0.1/localhost. Writes .env.local (git-ignored)
// with the public local URL and publishable key only.
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

const env = JSON.parse(execSync('npx supabase status -o json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString())
const apiHost = new URL(env.API_URL).hostname
if (!['127.0.0.1', 'localhost'].includes(apiHost)) {
  console.error(`Refusing to seed non-local Supabase at ${env.API_URL}`)
  process.exit(1)
}

const PASSWORD = 'travelsplit-dev'
const USERS = [
  { key: 'erwin', name: 'Erwin', creator: true },
  { key: 'larissa', name: 'Larissa', creator: false },
  { key: 'roger', name: 'Roger', creator: false },
]

const db = new pg.Client({ connectionString: env.DB_URL })
await db.connect()
const admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false } })

async function ensureUser({ key, name, creator }) {
  const email = `${key}@dev.travelsplit.local`
  const existing = await db.query('select id from auth.users where email = $1', [email])
  let id = existing.rows[0]?.id
  if (!id) {
    const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true })
    if (error) throw error
    id = data.user.id
    // Simulate the verified Google identity a real Google login would create.
    await db.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       values ($1, $2, $3, 'google', now(), now(), now())`,
      [`google-${id}`, id, JSON.stringify({ sub: `google-${id}`, email, email_verified: true })],
    )
  }
  if (creator) await db.query(`select private.operator_grant_creator($1, 'dev-seed')`, [email])
  const client = createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw error
  await call(client, 'upsert_my_profile', { p_display_name: name })
  return { id, email, name, client }
}

async function call(client, fn, args) {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data
}

const seeded = []
for (const user of USERS) seeded.push(await ensureUser(user))
const [erwin, larissa] = seeded

const already = await db.query(`select id from public.trips where title = 'Lissabon 2026 (Demo)'`)
if (already.rows.length === 0) {
  const tripId = await call(erwin.client, 'create_trip', {
    p_title: 'Lissabon 2026 (Demo)',
    p_base_currency: 'EUR',
    p_admin_display_name: 'Erwin',
    p_start_date: '2026-09-20',
    p_end_date: '2026-09-27',
  })
  const people = {}
  for (const name of ['Larissa', 'Roger']) {
    people[name] = await call(erwin.client, 'add_trip_person', { p_trip_id: tripId, p_display_name: name })
  }
  const { data: me } = await erwin.client.from('trip_people').select('id').eq('trip_id', tripId).eq('linked_user_id', erwin.id).single()
  await call(erwin.client, 'set_fx_rate', { p_trip_id: tripId, p_currency: 'CHF', p_eur_per_unit: '1.0650000000', p_expected_revision: null, p_rate_date: '2026-09-20' })

  const all = [me.id, people.Larissa, people.Roger].map((id) => ({ person_id: id, value: null }))
  const expense = (client, title, currency, minor, category, payer, participants = all) =>
    call(client, 'create_expense', {
      p_trip_id: tripId, p_idempotency_key: randomUUID(), p_title: title, p_expense_date: '2026-09-21',
      p_currency: currency, p_original_minor: minor, p_split_mode: 'equal', p_participants: participants,
      p_paid_by_person_id: payer, p_category: category, p_note: null,
    })
  await expense(erwin.client, 'Apartment Alfama', 'EUR', 84000, 'accommodation', me.id)
  await expense(erwin.client, 'Zugtickets Zürich', 'CHF', 21990, 'transport', me.id)

  // Larissa joins through a real invitation; Roger stays a placeholder.
  const inv = await call(erwin.client, 'create_invitation', { p_person_id: people.Larissa, p_valid_days: 7 })
  const joined = await call(larissa.client, 'redeem_invitation', { p_token: inv.token, p_display_name: 'Larissa' })
  if (joined.status === 'pending_admin_approval') {
    // Larissa already has bookings as a placeholder, so the admin must approve the claim (R3).
    const { data: claim } = await erwin.client.from('membership_claims').select('id').eq('trip_id', tripId).eq('status', 'pending_admin_approval').single()
    await call(erwin.client, 'decide_claim', { p_claim_id: claim.id, p_approve: true })
  }
  await expense(larissa.client, 'Abendessen Time Out Market', 'EUR', 9650, 'food', people.Larissa)
  console.log(`Demo trip created: ${tripId}`)
} else {
  console.log('Demo trip already exists, skipping.')
}

writeFileSync(
  '.env.local',
  `VITE_SUPABASE_URL=${env.API_URL}\nVITE_SUPABASE_PUBLISHABLE_KEY=${env.ANON_KEY}\nVITE_DEV_LOGIN=true\n`,
)
console.log(`Users: ${USERS.map((u) => `${u.key}@dev.travelsplit.local`).join(', ')} / password ${PASSWORD}`)
console.log('Wrote .env.local (local only, git-ignored).')
await db.end()
