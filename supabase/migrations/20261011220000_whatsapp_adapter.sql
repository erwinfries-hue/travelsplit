-- WhatsApp adapter (WA1, prepared only). Default WHATSAPP_MODE = off: nothing here does anything until the
-- operator switches the mode in private.whatsapp_config after the WA0/WA2 approvals. Outbound messages are
-- impossible by construction (check constraint), so the adapter can never cause Meta message costs.
--
-- Flow: signed Meta webhook (edge function, service role) -> public.whatsapp_ingest(event)
--       -> dedupe by provider_message_id -> sender via HMAC lookup hash -> trip -> participants
--       -> private.create_expense_as(actor = linked TravelSplit user, source = 'whatsapp')
-- Anything unclear becomes an unbooked review item (no balance effect).

create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------- trip codes (helper labels, not tokens)
alter table public.trips add column if not exists trip_code text
  check (trip_code is null or trip_code ~ '^[A-Z0-9]{2,12}$');

create or replace function public.set_trip_code(p_trip_id uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip public.trips := private.lock_active_trip(p_trip_id, v_uid);
  v_code text := nullif(upper(btrim(coalesce(p_code, ''))), '');
begin
  perform private.require_admin(v_trip, v_uid);
  if v_code is not null and v_code !~ '^[A-Z0-9]{2,12}$' then perform private.fail('invalid_trip_code'); end if;
  update public.trips set trip_code = v_code, updated_at = now() where id = p_trip_id;
  perform private.audit(p_trip_id, v_uid, 'trip.code_set', 'trip', p_trip_id,
    jsonb_build_object('trip_code', v_trip.trip_code), jsonb_build_object('trip_code', v_code));
end;
$$;

-- ---------------------------------------------------------------- operator configuration (singleton)
create table private.whatsapp_config (
  id integer primary key default 1 check (id = 1),
  mode text not null default 'off' check (mode in ('off', 'sandbox', 'production')),
  -- Only webhook deliveries for this Meta phone_number_id are accepted.
  allowed_phone_number_id text check (allowed_phone_number_id ~ '^[0-9]{5,20}$'),
  -- Public business number for wa.me links (digits only); never invented, set by the operator.
  business_number text check (business_number ~ '^[0-9]{6,15}$'),
  -- Zero-spend: TravelSplit never sends WhatsApp messages. Changing this needs a new, approved migration.
  outbound_enabled boolean not null default false check (outbound_enabled = false),
  -- Fail-closed volume limits for inbound processing.
  max_events_per_sender_hour integer not null default 30 check (max_events_per_sender_hour between 1 and 1000),
  max_events_per_day integer not null default 500 check (max_events_per_day between 1 and 100000),
  -- Where the WA0/WA2 approval is documented (text reference, never a key).
  approval_reference text check (char_length(approval_reference) <= 500),
  updated_at timestamptz not null default now(),
  check (mode = 'off' or allowed_phone_number_id is not null)
);
insert into private.whatsapp_config (id) values (1) on conflict do nothing;
alter table private.whatsapp_config enable row level security;
revoke all on private.whatsapp_config from public, anon, authenticated;

-- ---------------------------------------------------------------- link tokens, connections, inbox, review
create table public.whatsapp_link_tokens (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  person_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  issued_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  attempt_count integer not null default 0,
  foreign key (trip_id, person_id) references public.trip_people (trip_id, id) on delete cascade
);

create table public.whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  person_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- HMAC-SHA256(pepper, wa_id): the pepper lives only in the webhook's secret store, never in the database.
  wa_id_lookup_hash text not null check (wa_id_lookup_hash ~ '^[0-9a-f]{64}$'),
  wa_id_masked text not null check (wa_id_masked ~ '^[•]{2,}[0-9]{2,4}$'),
  status text not null default 'active' check (status in ('active', 'revoked', 'blocked')),
  linked_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id),
  foreign key (trip_id, person_id) references public.trip_people (trip_id, id) on delete cascade
);
create unique index whatsapp_connections_person_active on public.whatsapp_connections (trip_id, person_id) where status = 'active';
create unique index whatsapp_connections_sender_trip_active on public.whatsapp_connections (wa_id_lookup_hash, trip_id) where status = 'active';
create index whatsapp_connections_hash_idx on public.whatsapp_connections (wa_id_lookup_hash);

create table public.whatsapp_inbound_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'meta_whatsapp' check (provider = 'meta_whatsapp'),
  provider_message_id text not null check (char_length(provider_message_id) between 1 and 128),
  sender_hash text not null check (sender_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('expense', 'link', 'unsupported')),
  received_at timestamptz not null default now(),
  message_at timestamptz,
  trip_id uuid references public.trips (id) on delete cascade,
  actor_person_id uuid,
  processing_status text not null check (processing_status in (
    'booked', 'needs_review', 'needs_trip_selection', 'linked', 'link_failed', 'rejected', 'ignored')),
  reason_code text check (char_length(reason_code) <= 64),
  expense_id uuid references public.expenses (id) on delete set null,
  unique (provider, provider_message_id)
);
create index whatsapp_inbound_sender_idx on public.whatsapp_inbound_events (sender_hash, received_at desc);
create index whatsapp_inbound_received_idx on public.whatsapp_inbound_events (received_at desc);

create table public.whatsapp_review_queue (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.whatsapp_inbound_events (id) on delete cascade,
  trip_id uuid references public.trips (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  reason_code text not null check (char_length(reason_code) <= 64),
  -- The message text, kept only until the item is handled (or 30 days), so it can be corrected in the app.
  message_text text check (char_length(message_text) <= 1000),
  parsed_fields jsonb,
  status text not null default 'needs_review' check (status in ('needs_review', 'done', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz
);
create index whatsapp_review_user_idx on public.whatsapp_review_queue (user_id) where status = 'needs_review';
create index whatsapp_review_trip_idx on public.whatsapp_review_queue (trip_id) where status = 'needs_review';

alter table public.whatsapp_link_tokens enable row level security;
alter table public.whatsapp_connections enable row level security;
alter table public.whatsapp_inbound_events enable row level security;
alter table public.whatsapp_review_queue enable row level security;
revoke all on public.whatsapp_link_tokens, public.whatsapp_connections, public.whatsapp_inbound_events,
              public.whatsapp_review_queue from public, anon, authenticated;
-- Tokens and the inbox are server-only. Connections and review items are readable by their owner and the trip admin.
grant select on public.whatsapp_connections, public.whatsapp_review_queue to authenticated;

create policy whatsapp_connections_read on public.whatsapp_connections for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.trips t where t.id = trip_id and t.admin_user_id = auth.uid()));
create policy whatsapp_review_read on public.whatsapp_review_queue for select to authenticated
  using (user_id = auth.uid() or (trip_id is not null and exists (
    select 1 from public.trips t where t.id = trip_id and t.admin_user_id = auth.uid())));

-- ---------------------------------------------------------------- one expense service for every channel
-- ActorContext: p_actor is the TravelSplit user the booking is attributed to (the signed-in user in the app,
-- the verified, linked sender for WhatsApp). The same checks apply to every source.
create or replace function private.create_expense_as(
  p_actor uuid,
  p_source text,
  p_trip_id uuid,
  p_idempotency_key uuid,
  p_title text,
  p_expense_date date,
  p_currency text,
  p_original_minor bigint,
  p_split_mode text,
  p_participants jsonb,
  p_paid_by_person_id uuid,
  p_category text,
  p_note text,
  p_notify boolean,
  p_audit_extra jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips := private.lock_active_trip(p_trip_id, p_actor);
  v_existing public.expenses;
  v_payer uuid := coalesce(p_paid_by_person_id, private.person_of(p_trip_id, p_actor));
  v_reconstruction boolean;
  v_id uuid;
begin
  if p_source not in ('app', 'csv_import', 'whatsapp') then perform private.fail('invalid_source'); end if;
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  select * into v_existing from public.expenses e
   where e.trip_id = p_trip_id and e.idempotency_key = p_idempotency_key;
  if found then
    -- Retry of the same submission (double tap, offline re-sync, webhook retry): no second booking.
    if v_existing.created_by <> p_actor then perform private.fail('idempotency_conflict'); end if;
    return v_existing.id;
  end if;

  v_reconstruction := private.validate_expense_payer(v_trip, p_actor, v_payer);
  -- Only the app may book for someone else (R2, admin reconstruction).
  if v_reconstruction and p_source = 'whatsapp' then perform private.fail('payer_not_allowed'); end if;
  perform private.assert_amount(p_original_minor, p_currency);
  perform private.assert_rates_available(v_trip, p_currency);
  if p_expense_date is null then perform private.fail('date_required'); end if;

  insert into public.expenses (
    trip_id, created_by, paid_by_person_id, title, category, note, expense_date, currency,
    original_minor, split_mode, admin_reconstruction, idempotency_key, source
  ) values (
    p_trip_id, p_actor, v_payer, btrim(p_title), p_category, nullif(btrim(p_note), ''), p_expense_date, p_currency,
    p_original_minor, p_split_mode, v_reconstruction, p_idempotency_key, p_source
  ) returning id into v_id;

  insert into public.expense_splits (expense_id, trip_id, person_id, original_minor, input_value)
  select v_id, p_trip_id, s.person_id, s.original_minor, s.input_value
  from private.compute_original_shares(p_trip_id, p_original_minor, p_split_mode, p_participants) s;

  -- Fail early (and roll back) if the new data would make the trip's balances overflow.
  perform count(*) from private.trip_balances(p_trip_id);
  perform private.audit(p_trip_id, p_actor,
    case when v_reconstruction then 'expense.created_admin_reconstruction' else 'expense.created' end,
    'expense', v_id, null,
    jsonb_build_object('title', btrim(p_title), 'currency', p_currency, 'original_minor', p_original_minor,
                       'paid_by_person_id', v_payer, 'split_mode', p_split_mode)
      || case when p_source = 'app' then '{}'::jsonb else jsonb_build_object('source', p_source) end
      || coalesce(p_audit_extra, '{}'::jsonb));
  if p_notify then
    perform private.notify_members(p_trip_id, 'expense_created',
      jsonb_build_object('expense_id', v_id, 'title', btrim(p_title)), p_actor);
  end if;
  return v_id;
end;
$$;

create or replace function public.create_expense(
  p_trip_id uuid,
  p_idempotency_key uuid,
  p_title text,
  p_expense_date date,
  p_currency text,
  p_original_minor bigint,
  p_split_mode text,
  p_participants jsonb,
  p_paid_by_person_id uuid default null,
  p_category text default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Set only inside public.import_expenses_csv (transaction-local, not reachable through the API).
  v_import text := nullif(current_setting('travelsplit.import_batch', true), '');
begin
  return private.create_expense_as(
    private.require_uid(), case when v_import is null then 'app' else 'csv_import' end,
    p_trip_id, p_idempotency_key, p_title, p_expense_date, p_currency, p_original_minor, p_split_mode,
    p_participants, p_paid_by_person_id, p_category, p_note, v_import is null);
end;
$$;

-- ---------------------------------------------------------------- link tokens (trip admin, app)
create or replace function public.create_whatsapp_link(p_person_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_person public.trip_people;
  v_trip public.trips;
  v_config private.whatsapp_config;
  v_token text := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  v_expires timestamptz := now() + interval '7 days';
begin
  select * into v_config from private.whatsapp_config where id = 1;
  if v_config.mode = 'off' then perform private.fail('whatsapp_disabled'); end if;
  select * into v_person from public.trip_people where id = p_person_id;
  if not found then perform private.fail('person_not_found'); end if;
  v_trip := private.lock_active_trip(v_person.trip_id, v_uid);
  perform private.require_admin(v_trip, v_uid);
  -- Only people who already joined (incl. an approved R3 claim) can get booking rights via WhatsApp.
  if v_person.status <> 'active' or v_person.linked_user_id is null then perform private.fail('whatsapp_person_not_joined'); end if;

  update public.whatsapp_link_tokens set revoked_at = now()
   where person_id = p_person_id and used_at is null and revoked_at is null;
  insert into public.whatsapp_link_tokens (trip_id, person_id, token_hash, issued_by, expires_at)
  values (v_trip.id, p_person_id, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_uid, v_expires);
  perform private.audit(v_trip.id, v_uid, 'whatsapp.link_created', 'person', p_person_id, null,
    jsonb_build_object('expires_at', v_expires));
  return jsonb_build_object('code', 'LINK ' || v_token, 'expires_at', v_expires, 'business_number', v_config.business_number);
end;
$$;

-- Revoke (owner) or block (trip admin). Takes effect immediately for the next message.
create or replace function public.revoke_whatsapp_connection(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_conn public.whatsapp_connections;
  v_is_admin boolean;
begin
  select * into v_conn from public.whatsapp_connections where id = p_connection_id for update;
  if not found then perform private.fail('not_found'); end if;
  v_is_admin := exists (select 1 from public.trips t where t.id = v_conn.trip_id and t.admin_user_id = v_uid);
  if v_conn.user_id <> v_uid and not v_is_admin then perform private.fail('not_found'); end if;
  if v_conn.status <> 'active' then return; end if;
  update public.whatsapp_connections
     set status = case when v_conn.user_id = v_uid then 'revoked' else 'blocked' end, revoked_at = now(), revoked_by = v_uid
   where id = p_connection_id;
  perform private.audit(v_conn.trip_id, v_uid, 'whatsapp.revoked', 'person', v_conn.person_id, null, null);
end;
$$;

create or replace function public.resolve_whatsapp_review(p_review_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_row public.whatsapp_review_queue;
begin
  if p_status not in ('done', 'dismissed') then perform private.fail('invalid_status'); end if;
  select * into v_row from public.whatsapp_review_queue where id = p_review_id for update;
  if not found or (v_row.user_id <> v_uid and not exists (
    select 1 from public.trips t where t.id = v_row.trip_id and t.admin_user_id = v_uid)) then
    perform private.fail('not_found');
  end if;
  update public.whatsapp_review_queue
     set status = p_status, reviewed_by = v_uid, reviewed_at = now(), message_text = null
   where id = p_review_id and status = 'needs_review';
end;
$$;

-- ---------------------------------------------------------------- inbound processing (service role only)
create or replace function private.whatsapp_review(
  p_event uuid, p_trip uuid, p_user uuid, p_reason text, p_text text, p_parsed jsonb, p_status text default 'needs_review'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.whatsapp_inbound_events
     set processing_status = case when p_reason = 'needs_trip_selection' then 'needs_trip_selection' else 'needs_review' end,
         reason_code = p_reason, trip_id = p_trip
   where id = p_event;
  insert into public.whatsapp_review_queue (event_id, trip_id, user_id, reason_code, message_text, parsed_fields)
  values (p_event, p_trip, p_user, p_reason, left(p_text, 1000), p_parsed);
  if p_trip is not null then
    perform private.notify_user(p_user, p_trip, 'whatsapp_review', jsonb_build_object('reason', p_reason));
  end if;
  return jsonb_build_object('status', case when p_reason = 'needs_trip_selection' then 'needs_trip_selection' else 'needs_review' end,
                            'reason', p_reason);
end;
$$;

create or replace function private.whatsapp_reject(p_event uuid, p_status text, p_reason text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  update public.whatsapp_inbound_events set processing_status = p_status, reason_code = p_reason where id = p_event;
  select jsonb_build_object('status', p_status, 'reason', p_reason);
$$;

-- Event shape (built by the webhook after signature and schema checks):
-- { provider_message_id, phone_number_id, sender_hash, sender_masked, message_at (epoch s), kind: expense|link|unsupported,
--   text, link_token, parsed: {ok, reason?, trip_code?, title?, currency?, amount_minor?, participants?} }
create or replace function public.whatsapp_ingest(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_config private.whatsapp_config;
  v_event uuid;
  v_prior public.whatsapp_inbound_events;
  v_hash text := p_event ->> 'sender_hash';
  v_kind text := p_event ->> 'kind';
  v_text text := left(p_event ->> 'text', 1000);
  v_parsed jsonb := p_event -> 'parsed';
  v_message_at timestamptz;
  v_conn public.whatsapp_connections;
  v_candidates public.whatsapp_connections[];
  v_user uuid;
  v_code text;
  v_participants jsonb;
  v_ids uuid[];
  v_hits uuid[];
  v_entry jsonb;
  v_name text;
  v_mode text;
  v_expense uuid;
  v_token public.whatsapp_link_tokens;
  v_person public.trip_people;
  v_trip public.trips;
begin
  select * into v_config from private.whatsapp_config where id = 1;
  -- Fail closed: switched off or a delivery for a number we do not operate is not even recorded.
  if v_config.mode = 'off' then return jsonb_build_object('status', 'disabled'); end if;
  if p_event ->> 'phone_number_id' is distinct from v_config.allowed_phone_number_id then
    return jsonb_build_object('status', 'wrong_phone_number');
  end if;
  if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' or v_kind not in ('expense', 'link', 'unsupported')
     or coalesce(p_event ->> 'provider_message_id', '') !~ '^[A-Za-z0-9_.=:+-]{1,128}$' then
    perform private.fail('whatsapp_invalid_event');
  end if;
  v_message_at := case when p_event ->> 'message_at' ~ '^[0-9]{1,12}$'
                       then to_timestamp((p_event ->> 'message_at')::bigint) end;

  -- Idempotency: one row per Meta message id. A retry returns the first outcome and books nothing new.
  insert into public.whatsapp_inbound_events (provider_message_id, sender_hash, kind, message_at, processing_status)
  values (p_event ->> 'provider_message_id', v_hash, v_kind, v_message_at, 'rejected')
  on conflict (provider, provider_message_id) do nothing
  returning id into v_event;
  if v_event is null then
    select * into v_prior from public.whatsapp_inbound_events
     where provider = 'meta_whatsapp' and provider_message_id = p_event ->> 'provider_message_id';
    return jsonb_build_object('status', v_prior.processing_status, 'reason', v_prior.reason_code,
                              'expense_id', v_prior.expense_id, 'duplicate', true);
  end if;

  -- Volume limits (fail closed).
  if (select count(*) from public.whatsapp_inbound_events e
       where e.sender_hash = v_hash and e.received_at > now() - interval '1 hour') > v_config.max_events_per_sender_hour
     or (select count(*) from public.whatsapp_inbound_events e
          where e.received_at > now() - interval '1 day') > v_config.max_events_per_day then
    return private.whatsapp_reject(v_event, 'rejected', 'rate_limited');
  end if;

  -- Retention: message texts of old review items are dropped.
  update public.whatsapp_review_queue set message_text = null
   where message_text is not null and created_at < now() - interval '30 days';

  if v_kind = 'unsupported' then return private.whatsapp_reject(v_event, 'ignored', 'unsupported_type'); end if;

  -- ------------------------------------------------ link: "LINK <code>" sent by the person themselves
  if v_kind = 'link' then
    select * into v_token from public.whatsapp_link_tokens
     where token_hash = encode(extensions.digest(coalesce(p_event ->> 'link_token', ''), 'sha256'), 'hex')
     for update;
    if not found then return private.whatsapp_reject(v_event, 'link_failed', 'link_unknown'); end if;
    update public.whatsapp_link_tokens set attempt_count = attempt_count + 1 where id = v_token.id;
    if v_token.used_at is not null or v_token.revoked_at is not null then
      return private.whatsapp_reject(v_event, 'link_failed', 'link_used_or_revoked');
    end if;
    if v_token.expires_at < now() then return private.whatsapp_reject(v_event, 'link_failed', 'link_expired'); end if;
    if v_token.attempt_count >= 5 then return private.whatsapp_reject(v_event, 'link_failed', 'link_attempts'); end if;
    select * into v_person from public.trip_people where id = v_token.person_id;
    select * into v_trip from public.trips where id = v_token.trip_id;
    if v_person.status <> 'active' or v_person.linked_user_id is null or v_trip.status <> 'active' then
      return private.whatsapp_reject(v_event, 'link_failed', 'link_person_inactive');
    end if;
    perform pg_advisory_xact_lock(hashtext('whatsapp:' || v_hash));
    -- One WhatsApp sender belongs to at most one TravelSplit identity.
    if exists (select 1 from public.whatsapp_connections c
                where c.wa_id_lookup_hash = v_hash and c.status = 'active' and c.user_id <> v_person.linked_user_id) then
      return private.whatsapp_reject(v_event, 'link_failed', 'sender_taken');
    end if;
    if exists (select 1 from public.whatsapp_connections c
                where c.wa_id_lookup_hash = v_hash and c.status = 'blocked' and c.trip_id = v_trip.id) then
      return private.whatsapp_reject(v_event, 'link_failed', 'sender_blocked');
    end if;
    -- A new number replaces the old link of this person.
    update public.whatsapp_connections set status = 'revoked', revoked_at = now()
     where trip_id = v_trip.id and person_id = v_person.id and status = 'active';
    insert into public.whatsapp_connections (trip_id, person_id, user_id, wa_id_lookup_hash, wa_id_masked)
    values (v_trip.id, v_person.id, v_person.linked_user_id, v_hash,
            coalesce(nullif(p_event ->> 'sender_masked', ''), '••••'));
    update public.whatsapp_link_tokens set used_at = now() where id = v_token.id;
    update public.whatsapp_inbound_events set processing_status = 'linked', trip_id = v_trip.id, actor_person_id = v_person.id
     where id = v_event;
    perform private.audit(v_trip.id, v_person.linked_user_id, 'whatsapp.linked', 'person', v_person.id, null, null);
    perform private.notify_user(v_person.linked_user_id, v_trip.id, 'whatsapp_linked', '{}'::jsonb);
    return jsonb_build_object('status', 'linked');
  end if;

  -- ------------------------------------------------ expense message
  -- Usable connections: active link, person still an active member, trip still active.
  select array_agg(c order by c.linked_at) into v_candidates
    from public.whatsapp_connections c
    join public.trip_people p on p.id = c.person_id and p.status = 'active' and p.linked_user_id = c.user_id
    join public.trips t on t.id = c.trip_id and t.status = 'active'
   where c.wa_id_lookup_hash = v_hash and c.status = 'active';
  if v_candidates is null then return private.whatsapp_reject(v_event, 'rejected', 'unknown_sender'); end if;
  v_user := (v_candidates[1]).user_id;

  if not coalesce((v_parsed ->> 'ok')::boolean, false) then
    return private.whatsapp_review(v_event, case when cardinality(v_candidates) = 1 then (v_candidates[1]).trip_id end,
      v_user, coalesce(v_parsed ->> 'reason', 'unparsable'), v_text, null);
  end if;

  v_code := upper(v_parsed ->> 'trip_code');
  if v_code is not null then
    select array_agg(c) into v_candidates from unnest(v_candidates) c
     where exists (select 1 from public.trips t where t.id = c.trip_id and t.trip_code = v_code);
    if v_candidates is null then
      return private.whatsapp_review(v_event, null, v_user, 'needs_trip_selection', v_text, v_parsed);
    end if;
  end if;
  if cardinality(v_candidates) <> 1 then
    return private.whatsapp_review(v_event, null, v_user, 'needs_trip_selection', v_text, v_parsed);
  end if;
  v_conn := v_candidates[1];
  update public.whatsapp_inbound_events set trip_id = v_conn.trip_id, actor_person_id = v_conn.person_id where id = v_event;

  -- Participants: explicit names must resolve to exactly one person each; "alle" = all active members.
  v_mode := 'equal';
  case v_parsed -> 'participants' ->> 'kind'
    when 'all' then
      select coalesce(array_agg(p.id order by p.created_at), '{}') into v_ids from public.trip_people p
       where p.trip_id = v_conn.trip_id and p.status = 'active';
    when 'names', 'percent' then
      v_ids := '{}';
      for v_entry in select * from jsonb_array_elements(
          case when v_parsed -> 'participants' ->> 'kind' = 'names'
               then (select jsonb_agg(jsonb_build_object('name', n)) from jsonb_array_elements_text(v_parsed -> 'participants' -> 'names') n)
               else v_parsed -> 'participants' -> 'shares' end) loop
        v_name := extensions.unaccent(lower(btrim(v_entry ->> 'name')));
        select array_agg(p.id) into v_hits from public.trip_people p
         where p.trip_id = v_conn.trip_id and p.status <> 'removed'
           and extensions.unaccent(lower(btrim(p.display_name))) = v_name;
        if v_hits is null then
          select array_agg(p.id) into v_hits from public.trip_people p
           where p.trip_id = v_conn.trip_id and p.status <> 'removed'
             and split_part(extensions.unaccent(lower(btrim(p.display_name))), ' ', 1) = v_name;
        end if;
        if v_hits is null then
          return private.whatsapp_review(v_event, v_conn.trip_id, v_user, 'unknown_person', v_text, v_parsed);
        end if;
        if cardinality(v_hits) > 1 or v_hits[1] = any(v_ids) then
          return private.whatsapp_review(v_event, v_conn.trip_id, v_user, 'ambiguous_person', v_text, v_parsed);
        end if;
        v_ids := v_ids || v_hits[1];
      end loop;
      if v_parsed -> 'participants' ->> 'kind' = 'percent' then v_mode := 'percent'; end if;
    else
      -- Nobody named: the PWA would preselect everyone, WhatsApp asks instead of guessing.
      return private.whatsapp_review(v_event, v_conn.trip_id, v_user, 'participants_missing', v_text, v_parsed);
  end case;
  if cardinality(v_ids) = 0 then
    return private.whatsapp_review(v_event, v_conn.trip_id, v_user, 'participants_missing', v_text, v_parsed);
  end if;
  select jsonb_agg(jsonb_build_object('person_id', v_ids[i],
           'value', case when v_mode = 'percent' then v_parsed -> 'participants' -> 'shares' -> (i - 1) ->> 'percent' end))
    into v_participants from generate_subscripts(v_ids, 1) i;

  begin
    v_expense := private.create_expense_as(
      v_conn.user_id, 'whatsapp', v_conn.trip_id,
      -- Same Meta message id -> same idempotency key, also across a lost response.
      extensions.uuid_generate_v5('6ba7b811-9dad-11d1-80b4-00c04fd430c8'::uuid, 'meta_whatsapp:' || (p_event ->> 'provider_message_id')),
      v_parsed ->> 'title',
      (coalesce(v_message_at, now()) at time zone 'Europe/Zurich')::date,
      v_parsed ->> 'currency', (v_parsed ->> 'amount_minor')::bigint, v_mode, v_participants,
      v_conn.person_id, null, null, true,
      jsonb_build_object('participants', to_jsonb(v_ids), 'whatsapp_event_id', v_event));
  exception when sqlstate 'P0001' then
    -- Server-side rule failed (missing rate, invalid amount, ...): unbooked review item instead.
    return private.whatsapp_review(v_event, v_conn.trip_id, v_user, left(sqlerrm, 64), v_text, v_parsed);
  end;
  update public.whatsapp_inbound_events set processing_status = 'booked', expense_id = v_expense where id = v_event;
  return jsonb_build_object('status', 'booked', 'expense_id', v_expense);
end;
$$;

-- Webhook-only entry point; the client roles never reach it.
revoke all on function public.whatsapp_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.whatsapp_ingest(jsonb) to service_role;
revoke all on function private.create_expense_as(uuid, text, uuid, uuid, text, date, text, bigint, text, jsonb, uuid, text, text, boolean, jsonb),
                       private.whatsapp_review(uuid, uuid, uuid, text, text, jsonb, text),
                       private.whatsapp_reject(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.set_trip_code(uuid, text), public.create_whatsapp_link(uuid),
                       public.revoke_whatsapp_connection(uuid), public.resolve_whatsapp_review(uuid, text) from public, anon;
grant execute on function public.set_trip_code(uuid, text), public.create_whatsapp_link(uuid),
                          public.revoke_whatsapp_connection(uuid), public.resolve_whatsapp_review(uuid, text) to authenticated;

-- Members see whether WhatsApp is switched on (for showing or hiding its UI); nothing else of the config.
create or replace function public.my_capabilities()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
begin
  return jsonb_build_object(
    'can_create_trips', private.is_allowed_creator(v_uid),
    'is_anonymous', private.is_anonymous_user(v_uid),
    'has_google', private.google_email(v_uid) is not null,
    'whatsapp_mode', (select c.mode from private.whatsapp_config c where c.id = 1)
  );
end;
$$;

alter publication supabase_realtime add table public.whatsapp_review_queue;
