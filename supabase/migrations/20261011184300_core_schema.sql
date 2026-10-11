-- TravelSplit core schema: tables, constraints, membership helpers and read-only RLS.
-- Clients never write tables directly. All writes go through the checked RPCs in the next migration.

-- ---------------------------------------------------------------------------
-- Profiles and operator allowlist
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  locale text not null default 'de' check (locale in ('de', 'en')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Google e-mail addresses allowed to create trips. Operator-only (no API access at all).
create table private.creator_allowlist (
  email text primary key check (email = lower(btrim(email)) and email like '%@%'),
  granted_by text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  note text
);

-- ---------------------------------------------------------------------------
-- Trips and people
-- ---------------------------------------------------------------------------

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  base_currency text not null check (public.currency_exponent(base_currency) is not null),
  start_date date,
  end_date date,
  status text not null default 'active' check (status in ('active', 'archived')),
  -- Exactly one admin per trip, by construction (single column, never null).
  admin_user_id uuid not null references auth.users (id),
  -- Whether placeholders count as "everyone" for quick entry ("alle").
  version integer not null default 1,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table public.trip_people (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  linked_user_id uuid references auth.users (id),
  status text not null default 'placeholder' check (status in ('placeholder', 'active', 'removed')),
  created_at timestamptz not null default now(),
  linked_at timestamptz,
  unique (trip_id, id),
  unique (trip_id, linked_user_id),
  check ((status = 'active') = (linked_user_id is not null) or status = 'removed')
);
create index trip_people_user_idx on public.trip_people (linked_user_id) where linked_user_id is not null;

create table public.trip_invitations (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  target_person_id uuid not null,
  token_hash bytea not null unique,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid references auth.users (id),
  revoked_at timestamptz,
  foreign key (trip_id, target_person_id) references public.trip_people (trip_id, id) on delete cascade
);
create index trip_invitations_trip_idx on public.trip_invitations (trip_id);

create table public.membership_claims (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  person_id uuid not null,
  claimant_user_id uuid not null references auth.users (id) on delete cascade,
  claimant_display_name text not null,
  invitation_id uuid references public.trip_invitations (id) on delete set null,
  status text not null default 'pending_admin_approval'
    check (status in ('pending_admin_approval', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id),
  foreign key (trip_id, person_id) references public.trip_people (trip_id, id) on delete cascade
);
-- At most one open claim per person.
create unique index membership_claims_open_idx on public.membership_claims (person_id)
  where status = 'pending_admin_approval';

-- ---------------------------------------------------------------------------
-- Exchange rates (R1): EUR per unit, set manually once per trip and currency
-- ---------------------------------------------------------------------------

create table public.trip_fx_rates (
  trip_id uuid not null references public.trips (id) on delete cascade,
  currency text not null check (public.currency_exponent(currency) is not null and currency <> 'EUR'),
  eur_per_unit numeric(20, 10) not null check (eur_per_unit > 0),
  rate_date date,
  revision integer not null default 1,
  updated_by uuid not null references auth.users (id),
  updated_at timestamptz not null default now(),
  primary key (trip_id, currency)
);

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  created_by uuid not null references auth.users (id),
  paid_by_person_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  category text check (category in ('transport', 'accommodation', 'food', 'activities', 'shopping', 'other')),
  note text check (char_length(note) <= 1000),
  expense_date date not null,
  currency text not null check (public.currency_exponent(currency) is not null),
  original_minor bigint not null check (original_minor > 0),
  split_mode text not null check (split_mode in ('equal', 'fixed', 'percent')),
  source text not null default 'app' check (source in ('app', 'csv_import', 'whatsapp')),
  -- R2: set when the trip admin booked a payment made by someone else.
  admin_reconstruction boolean not null default false,
  idempotency_key uuid not null,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users (id),
  delete_reason text,
  unique (trip_id, id),
  unique (trip_id, idempotency_key),
  foreign key (trip_id, paid_by_person_id) references public.trip_people (trip_id, id)
);
create index expenses_trip_idx on public.expenses (trip_id) where deleted_at is null;

create table public.expense_splits (
  expense_id uuid not null,
  trip_id uuid not null,
  person_id uuid not null,
  original_minor bigint not null check (original_minor > 0),
  -- Input value for traceability: fixed amount (minor) or percent scaled by 10^4.
  input_value bigint,
  primary key (expense_id, person_id),
  foreign key (trip_id, expense_id) references public.expenses (trip_id, id) on delete cascade,
  foreign key (trip_id, person_id) references public.trip_people (trip_id, id)
);
create index expense_splits_trip_idx on public.expense_splits (trip_id);

-- Full previous state of an expense before each change (R9, revision-safe corrections).
create table public.expense_revisions (
  expense_id uuid not null,
  trip_id uuid not null,
  revision integer not null,
  snapshot jsonb not null,
  changed_by uuid not null references auth.users (id),
  changed_at timestamptz not null default now(),
  reason text,
  primary key (expense_id, revision),
  foreign key (trip_id, expense_id) references public.expenses (trip_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Settlements (R1 frozen snapshot on confirmation)
-- ---------------------------------------------------------------------------

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  sender_person_id uuid not null,
  receiver_person_id uuid not null,
  currency text not null check (public.currency_exponent(currency) is not null),
  original_minor bigint not null check (original_minor > 0),
  note text check (char_length(note) <= 500),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected', 'withdrawn')),
  reported_by uuid not null references auth.users (id),
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id),
  -- Frozen at confirmation, never updated afterwards.
  confirmed_base_minor bigint,
  confirmed_base_currency text,
  confirmed_from_rate numeric(20, 10),
  confirmed_base_rate numeric(20, 10),
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users (id),
  unique (trip_id, id),
  unique (trip_id, idempotency_key),
  check (sender_person_id <> receiver_person_id),
  check (
    (status = 'confirmed') = (confirmed_base_minor is not null and confirmed_at is not null
      and confirmed_by is not null and confirmed_from_rate is not null and confirmed_base_rate is not null
      and confirmed_base_currency is not null)
  ),
  foreign key (trip_id, sender_person_id) references public.trip_people (trip_id, id),
  foreign key (trip_id, receiver_person_id) references public.trip_people (trip_id, id)
);
create index settlements_trip_idx on public.settlements (trip_id);

create table public.settlement_reversals (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null,
  settlement_id uuid not null unique,
  reason text not null check (char_length(btrim(reason)) between 3 and 500),
  -- Exactly the frozen base value of the reversed settlement.
  reversed_base_minor bigint not null check (reversed_base_minor > 0),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (trip_id, settlement_id) references public.settlements (trip_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Closures, receipts, audit, notices
-- ---------------------------------------------------------------------------

create table public.trip_closures (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  version integer not null,
  snapshot jsonb not null,
  snapshot_sha256 text not null,
  closed_at timestamptz not null default now(),
  closed_by uuid not null references auth.users (id),
  unique (trip_id, version)
);

create table public.receipt_files (
  expense_id uuid primary key,
  trip_id uuid not null,
  storage_path text not null unique,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 1048576),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/webp')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (trip_id, expense_id) references public.expenses (trip_id, id) on delete cascade
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  trip_id uuid references public.trips (id) on delete cascade,
  actor_user_id uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz not null default now()
);
create index audit_events_trip_idx on public.audit_events (trip_id, created_at);

create table public.in_app_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  trip_id uuid references public.trips (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index in_app_notices_user_idx on public.in_app_notices (user_id, created_at desc);

-- Audit log is append-only: updates are never allowed; deletes only as part of a trip deletion.
create or replace function private.audit_events_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'audit_events is append-only';
  end if;
  if tg_op = 'DELETE' and coalesce(current_setting('travelsplit.deleting_trip', true), '') <> old.trip_id::text then
    raise exception 'audit_events is append-only';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function private.audit_events_guard();

-- Frozen settlement values must never change once confirmed (R1, SEC-12).
create or replace function private.settlements_freeze_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'confirmed' and (
    new.status is distinct from old.status
    or new.confirmed_base_minor is distinct from old.confirmed_base_minor
    or new.confirmed_from_rate is distinct from old.confirmed_from_rate
    or new.confirmed_base_rate is distinct from old.confirmed_base_rate
    or new.confirmed_base_currency is distinct from old.confirmed_base_currency
    or new.original_minor is distinct from old.original_minor
    or new.currency is distinct from old.currency
    or new.sender_person_id is distinct from old.sender_person_id
    or new.receiver_person_id is distinct from old.receiver_person_id
  ) then
    raise exception 'confirmed settlement is frozen';
  end if;
  if new.trip_id is distinct from old.trip_id or new.reported_by is distinct from old.reported_by then
    raise exception 'immutable settlement field';
  end if;
  return new;
end;
$$;
create trigger settlements_freeze
  before update on public.settlements
  for each row execute function private.settlements_freeze_guard();

create or replace function private.expenses_immutable_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.trip_id is distinct from old.trip_id
    or new.created_by is distinct from old.created_by
    or new.idempotency_key is distinct from old.idempotency_key
    or new.source is distinct from old.source then
    raise exception 'immutable expense field';
  end if;
  return new;
end;
$$;
create trigger expenses_immutable
  before update on public.expenses
  for each row execute function private.expenses_immutable_guard();

create or replace function private.closures_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then raise exception 'trip closures are immutable'; end if;
  if coalesce(current_setting('travelsplit.deleting_trip', true), '') <> old.trip_id::text then
    raise exception 'trip closures are immutable';
  end if;
  return old;
end;
$$;
create trigger trip_closures_immutable
  before update or delete on public.trip_closures
  for each row execute function private.closures_guard();

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer so RLS policies do not recurse)
-- ---------------------------------------------------------------------------

-- Confirmed, active membership. A pending claim is NOT membership.
create or replace function private.is_trip_member(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trip_people p
    where p.trip_id = p_trip_id and p.linked_user_id = (select auth.uid()) and p.status = 'active'
  )
$$;

create or replace function private.is_trip_admin(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trips t
    join public.trip_people p on p.trip_id = t.id and p.linked_user_id = t.admin_user_id and p.status = 'active'
    where t.id = p_trip_id and t.admin_user_id = (select auth.uid())
  )
$$;

-- Ids of persons that share a trip with the caller (for profile visibility).
create or replace function private.my_trip_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.trip_id from public.trip_people p
  where p.linked_user_id = (select auth.uid()) and p.status = 'active'
$$;

revoke all on function private.is_trip_member(uuid), private.is_trip_admin(uuid), private.my_trip_ids() from public;
grant execute on function private.is_trip_member(uuid), private.is_trip_admin(uuid), private.my_trip_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security: read-only for confirmed members, no direct writes for anyone
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.trip_people enable row level security;
alter table public.trip_invitations enable row level security;
alter table public.membership_claims enable row level security;
alter table public.trip_fx_rates enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_splits enable row level security;
alter table public.expense_revisions enable row level security;
alter table public.settlements enable row level security;
alter table public.settlement_reversals enable row level security;
alter table public.trip_closures enable row level security;
alter table public.receipt_files enable row level security;
alter table public.audit_events enable row level security;
alter table public.in_app_notices enable row level security;
alter table private.creator_allowlist enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;
grant select on all tables in schema public to authenticated;

create policy profiles_select on public.profiles for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.trip_people p
      where p.linked_user_id = profiles.user_id and p.trip_id in (select private.my_trip_ids())
    )
  );

create policy trips_select on public.trips for select to authenticated
  using ((select private.is_trip_member(id)));

create policy trip_people_select on public.trip_people for select to authenticated
  using ((select private.is_trip_member(trip_id)));

-- Invitations and claims are visible to the trip admin only; claimants see their own claim.
create policy trip_invitations_select on public.trip_invitations for select to authenticated
  using ((select private.is_trip_admin(trip_id)));

create policy membership_claims_select on public.membership_claims for select to authenticated
  using (claimant_user_id = (select auth.uid()) or (select private.is_trip_admin(trip_id)));

create policy trip_fx_rates_select on public.trip_fx_rates for select to authenticated
  using ((select private.is_trip_member(trip_id)));

create policy expenses_select on public.expenses for select to authenticated
  using ((select private.is_trip_member(trip_id)));

create policy expense_splits_select on public.expense_splits for select to authenticated
  using ((select private.is_trip_member(trip_id)));

create policy expense_revisions_select on public.expense_revisions for select to authenticated
  using ((select private.is_trip_member(trip_id)));

create policy settlements_select on public.settlements for select to authenticated
  using ((select private.is_trip_member(trip_id)));

create policy settlement_reversals_select on public.settlement_reversals for select to authenticated
  using ((select private.is_trip_member(trip_id)));

create policy trip_closures_select on public.trip_closures for select to authenticated
  using ((select private.is_trip_member(trip_id)));

create policy receipt_files_select on public.receipt_files for select to authenticated
  using ((select private.is_trip_member(trip_id)));

create policy audit_events_select on public.audit_events for select to authenticated
  using ((select private.is_trip_member(trip_id)));

create policy in_app_notices_select on public.in_app_notices for select to authenticated
  using (user_id = (select auth.uid()) and (trip_id is null or (select private.is_trip_member(trip_id))));

-- New tables must not silently become writable or readable.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon;
