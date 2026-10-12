// WhatsApp Cloud API webhook (WA1). Runtime-neutral: uses only Web APIs, so it runs in Supabase Edge
// Functions (Deno) and in the Node test suite. It never sends anything to WhatsApp (zero spend).
//
// Order of checks: mode -> method -> size -> HMAC signature over the raw body -> strict schema ->
// per message: sender hash, link code or deterministic parse -> public.whatsapp_ingest (service role).
import { parseEntry } from '../../../src/domain/ingest/parse.ts'

export type WhatsAppMode = 'off' | 'sandbox' | 'production'

export interface WebhookConfig {
  mode: WhatsAppMode
  /** Meta app secret, used for X-Hub-Signature-256. */
  appSecret: string
  /** hub.verify_token chosen by the operator for the GET challenge. */
  verifyToken: string
  /** The only phone_number_id whose deliveries are processed. */
  phoneNumberId: string
  /** Secret pepper for the sender lookup hash; never stored in the database. */
  idPepper: string
}

export interface IngestEvent {
  provider_message_id: string
  phone_number_id: string
  sender_hash: string
  sender_masked: string
  message_at: string
  kind: 'expense' | 'link' | 'unsupported'
  text: string | null
  link_token: string | null
  parsed: Record<string, unknown> | null
}

export type Ingest = (event: IngestEvent) => Promise<unknown>

export const MAX_BODY_BYTES = 64 * 1024
const MAX_TEXT = 1000
const LINK = /^(?:LINK|VERBINDEN)\s+([A-Za-z0-9_-]{32})$/i

const encoder = new TextEncoder()

async function hmacHex(secret: string, data: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time comparison of two strings (length is not secret here). */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export async function verifySignature(raw: Uint8Array<ArrayBuffer>, header: string | null, appSecret: string): Promise<boolean> {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header) || !appSecret) return false
  return safeEqual(header.slice(7), await hmacHex(appSecret, raw))
}

export function senderHash(waId: string, pepper: string): Promise<string> {
  return hmacHex(pepper, encoder.encode(`wa_id:${waId}`))
}

export function maskWaId(waId: string): string {
  return `••••${waId.slice(-3)}`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null)

export interface InboundMessage {
  phoneNumberId: string
  from: string
  id: string
  timestamp: string
  type: string
  text: string | null
}

/** Strict reading of the Meta payload; anything unexpected is dropped, status updates are ignored. */
export function extractMessages(body: unknown): InboundMessage[] | null {
  if (!isObject(body) || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry) || body.entry.length > 20) return null
  const out: InboundMessage[] = []
  for (const entry of body.entry) {
    if (!isObject(entry) || !str(entry.id, /^\d{1,20}$/) || !Array.isArray(entry.changes) || entry.changes.length > 20) return null
    for (const change of entry.changes) {
      if (!isObject(change) || change.field !== 'messages' || !isObject(change.value)) continue
      const value = change.value
      const phoneNumberId = isObject(value.metadata) ? str(value.metadata.phone_number_id, /^\d{5,20}$/) : null
      if (!phoneNumberId || !Array.isArray(value.messages)) continue
      for (const m of value.messages.slice(0, 50)) {
        if (!isObject(m)) continue
        const from = str(m.from, /^\d{6,15}$/)
        const id = str(m.id, /^[A-Za-z0-9_.=:+-]{1,128}$/)
        const timestamp = str(m.timestamp, /^\d{1,12}$/)
        const type = str(m.type, /^[a-z_]{1,32}$/)
        if (!from || !id || !timestamp || !type) continue
        const body = type === 'text' && isObject(m.text) && typeof m.text.body === 'string' ? m.text.body : null
        out.push({ phoneNumberId, from, id, timestamp, type, text: body === null ? null : body.slice(0, MAX_TEXT) })
      }
    }
  }
  return out
}

/** Builds the database event for one message. Amounts travel as strings (bigint). */
export async function toEvent(m: InboundMessage, pepper: string): Promise<IngestEvent> {
  const base = {
    provider_message_id: m.id,
    phone_number_id: m.phoneNumberId,
    sender_hash: await senderHash(m.from, pepper),
    sender_masked: maskWaId(m.from),
    message_at: m.timestamp,
  }
  if (m.type !== 'text' || m.text === null) return { ...base, kind: 'unsupported', text: null, link_token: null, parsed: null }
  const link = LINK.exec(m.text.trim())
  if (link) return { ...base, kind: 'link', text: null, link_token: link[1], parsed: null }
  const result = parseEntry(m.text)
  const parsed = result.ok
    ? {
        ok: true,
        trip_code: result.entry.tripCode,
        title: result.entry.title,
        currency: result.entry.currency,
        amount_minor: result.entry.amountMinor.toString(),
        participants:
          result.entry.participants?.kind === 'percent'
            ? { kind: 'percent', shares: result.entry.participants.shares.map((s) => ({ name: s.name, percent: s.percent.toString() })) }
            : result.entry.participants,
      }
    : { ok: false, reason: result.reason }
  return { ...base, kind: 'expense', text: m.text, link_token: null, parsed }
}

const text = (status: number, body = '') => new Response(body, { status, headers: { 'content-type': 'text/plain' } })

export async function handleRequest(req: Request, config: WebhookConfig, ingest: Ingest): Promise<Response> {
  // Switched off: the route behaves as if it did not exist.
  if (config.mode === 'off') return text(404)
  const url = new URL(req.url)

  if (req.method === 'GET') {
    const challenge = url.searchParams.get('hub.challenge') ?? ''
    const ok =
      url.searchParams.get('hub.mode') === 'subscribe' &&
      !!config.verifyToken &&
      safeEqual(url.searchParams.get('hub.verify_token') ?? '', config.verifyToken) &&
      /^[A-Za-z0-9_-]{1,128}$/.test(challenge)
    return ok ? text(200, challenge) : text(403)
  }
  if (req.method !== 'POST') return text(405)

  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return text(413)
  const raw = new Uint8Array(await req.arrayBuffer())
  if (raw.byteLength > MAX_BODY_BYTES) return text(413)
  // Signature first: nothing of an unsigned or modified body is parsed.
  if (!(await verifySignature(raw, req.headers.get('x-hub-signature-256'), config.appSecret))) return text(401)

  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    return text(400)
  }
  const messages = extractMessages(body)
  if (messages === null) return text(400)

  for (const m of messages) {
    if (m.phoneNumberId !== config.phoneNumberId) continue
    // A thrown error (database unreachable) answers 500, so Meta retries; the message id keeps it idempotent.
    await ingest(await toEvent(m, config.idPepper))
  }
  return text(200, 'ok')
}
