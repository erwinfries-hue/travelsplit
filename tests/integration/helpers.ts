// Test harness against the local Supabase stack (`npx supabase start`).
// Uses only the well-known local development keys printed by `supabase status`.
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import pg from 'pg'

interface LocalEnv {
  API_URL: string
  DB_URL: string
  ANON_KEY: string
  SERVICE_ROLE_KEY: string
}

let cachedEnv: LocalEnv | null = null
export function localEnv(): LocalEnv {
  if (!cachedEnv) {
    cachedEnv = JSON.parse(execSync('npx supabase status -o json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString())
  }
  return cachedEnv!
}

let pool: pg.Pool | null = null
/** Direct database access as the postgres superuser: setup only, never for the assertions under test. */
export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: localEnv().DB_URL, max: 4 })
  return pool
}

export async function closeDb(): Promise<void> {
  await pool?.end()
  pool = null
}

export function anonClient(): SupabaseClient {
  const env = localEnv()
  return createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
}

export function serviceClient(): SupabaseClient {
  const env = localEnv()
  return createClient(env.API_URL, env.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
}

export interface TestUser {
  id: string
  name: string
  email: string | null
  client: SupabaseClient
}

/**
 * Create a signed-in test user. `google: true` attaches a verified Google identity
 * (what Supabase stores after a real Google login), `creator: true` also puts that
 * e-mail on the operator allowlist.
 */
export async function createUser(
  name: string,
  opts: { google?: boolean; creator?: boolean } = {},
): Promise<TestUser> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@test.travelsplit.local`
  const password = `pw-${randomUUID()}`
  const admin = serviceClient()
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  const id = data.user.id
  if (opts.google || opts.creator) {
    await db().query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       values ($1, $2, $3, 'google', now(), now(), now())`,
      [`google-${id}`, id, JSON.stringify({ sub: `google-${id}`, email, email_verified: true })],
    )
  }
  if (opts.creator) {
    await db().query(`select private.operator_grant_creator($1, 'integration-test')`, [email])
  }
  const client = anonClient()
  const signIn = await client.auth.signInWithPassword({ email, password })
  if (signIn.error) throw signIn.error
  await rpc(client, 'upsert_my_profile', { p_display_name: name })
  return { id, name, email, client }
}

export async function createGuest(name: string): Promise<TestUser> {
  const client = anonClient()
  const { data, error } = await client.auth.signInAnonymously()
  if (error) throw error
  return { id: data.user!.id, name, email: null, client }
}

/** Call an RPC and throw a readable error (with the server error code) on failure. */
export async function rpc<T = unknown>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new RpcError(fn, error.message, error.code)
  return data as T
}

export class RpcError extends Error {
  readonly fn: string
  readonly serverMessage: string
  readonly pgCode: string | undefined
  constructor(fn: string, serverMessage: string, pgCode: string | undefined) {
    super(`${fn}: ${serverMessage}`)
    this.fn = fn
    this.serverMessage = serverMessage
    this.pgCode = pgCode
  }
}

/** Expect an RPC to fail with the given server error message code. */
export async function rpcFails(client: SupabaseClient, fn: string, args: Record<string, unknown>, code: string) {
  const { error } = await client.rpc(fn, args)
  if (!error) throw new Error(`${fn} unexpectedly succeeded (expected ${code})`)
  if (!error.message.includes(code)) throw new Error(`${fn} failed with "${error.message}", expected "${code}"`)
}

export const equal = (...personIds: string[]) => personIds.map((person_id) => ({ person_id }))

export interface TripSetup {
  tripId: string
  personIds: Record<string, string>
}

/** Trip with an admin and further members who joined via invitation. */
export async function setupTrip(admin: TestUser, members: TestUser[], baseCurrency = 'EUR'): Promise<TripSetup> {
  const tripId = await rpc<string>(admin.client, 'create_trip', {
    p_title: `Testreise ${randomUUID().slice(0, 6)}`,
    p_base_currency: baseCurrency,
    p_admin_display_name: admin.name,
  })
  const personIds: Record<string, string> = {}
  const { data } = await admin.client.from('trip_people').select('id').eq('trip_id', tripId).single()
  personIds[admin.name] = data!.id
  for (const m of members) {
    const personId = await rpc<string>(admin.client, 'add_trip_person', { p_trip_id: tripId, p_display_name: m.name })
    const inv = await rpc<{ token: string }>(admin.client, 'create_invitation', { p_person_id: personId })
    await rpc(m.client, 'redeem_invitation', { p_token: inv.token, p_display_name: m.name })
    personIds[m.name] = personId
  }
  return { tripId, personIds }
}

export async function addExpense(
  user: TestUser,
  tripId: string,
  args: {
    title?: string
    currency: string
    minor: bigint | number
    participants: { person_id: string; value?: string }[]
    mode?: 'equal' | 'fixed' | 'percent'
    paidBy?: string
    key?: string
  },
): Promise<string> {
  return rpc<string>(user.client, 'create_expense', {
    p_trip_id: tripId,
    p_idempotency_key: args.key ?? randomUUID(),
    p_title: args.title ?? 'Ausgabe',
    p_expense_date: '2026-10-01',
    p_currency: args.currency,
    p_original_minor: args.minor.toString(),
    p_split_mode: args.mode ?? 'equal',
    p_participants: args.participants,
    p_paid_by_person_id: args.paidBy ?? null,
  })
}

export async function balances(user: TestUser, tripId: string): Promise<Record<string, bigint>> {
  const rows = await rpc<{ person_id: string; balance_minor: number }[]>(user.client, 'trip_balances', { p_trip_id: tripId })
  return Object.fromEntries(rows.map((r) => [r.person_id, BigInt(r.balance_minor)]))
}
