// Supabase Edge Function entry (Deno). Deploy only after the WA2 approval, with --no-verify-jwt
// (Meta does not send a Supabase JWT; the HMAC signature is the authentication). See docs/wa2-activation-checklist.md.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { handleRequest, type WebhookConfig, type WhatsAppMode } from './handler.ts'

const env = (name: string) => Deno.env.get(name) ?? ''
const mode = (['off', 'sandbox', 'production'].includes(env('WHATSAPP_MODE')) ? env('WHATSAPP_MODE') : 'off') as WhatsAppMode

const config: WebhookConfig = {
  mode,
  appSecret: env('WHATSAPP_APP_SECRET'),
  verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
  phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
  idPepper: env('WHATSAPP_ID_PEPPER'),
}
if (mode !== 'off' && (!config.appSecret || !config.verifyToken || !config.phoneNumberId || config.idPepper.length < 32)) {
  throw new Error('whatsapp-webhook: incomplete configuration')
}

const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })

Deno.serve((req) =>
  handleRequest(req, config, async (event) => {
    const { data, error } = await supabase.rpc('whatsapp_ingest', { p_event: event })
    if (error) throw new Error(error.code ?? 'ingest_failed')
    return data
  }),
)
