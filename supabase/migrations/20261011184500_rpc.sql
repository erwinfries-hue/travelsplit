-- Public RPCs: the only write path for clients. Each function validates the caller
-- server-side (membership, role, trip status) and writes an audit event.

-- ---------------------------------------------------------------------------
-- Profile and session info
-- ---------------------------------------------------------------------------

create or replace function public.upsert_my_profile(p_display_name text, p_locale text default 'de')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
begin
  if p_locale not in ('de', 'en') then perform private.fail('invalid_locale'); end if;
  insert into public.profiles (user_id, display_name, locale)
  values (v_uid, btrim(p_display_name), p_locale)
  on conflict (user_id) do update
    set display_name = excluded.display_name, locale = excluded.locale, updated_at = now();
end;
$$;

-- What the UI may offer. Authorization is always re-checked by the write RPCs.
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
    'has_google', private.google_email(v_uid) is not null
  );
end;
$$;

create or replace function public.mark_notices_read(p_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.in_app_notices set read_at = now()
  where id = any(p_ids) and user_id = private.require_uid() and read_at is null
$$;

-- ---------------------------------------------------------------------------
-- Trips and people
-- ---------------------------------------------------------------------------

create or replace function public.create_trip(
  p_title text, p_base_currency text, p_admin_display_name text,
  p_start_date date default null, p_end_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip_id uuid;
  v_person_id uuid;
begin
  if not private.is_allowed_creator(v_uid) then perform private.fail('creator_not_allowed'); end if;
  if public.currency_exponent(p_base_currency) is null then perform private.fail('unsupported_currency'); end if;

  insert into public.trips (title, base_currency, start_date, end_date, admin_user_id, created_by)
  values (btrim(p_title), p_base_currency, p_start_date, p_end_date, v_uid, v_uid)
  returning id into v_trip_id;

  insert into public.trip_people (trip_id, display_name, linked_user_id, status, linked_at)
  values (v_trip_id, btrim(p_admin_display_name), v_uid, 'active', now())
  returning id into v_person_id;

  perform private.audit(v_trip_id, v_uid, 'trip.created', 'trip', v_trip_id, null,
    jsonb_build_object('title', btrim(p_title), 'base_currency', p_base_currency, 'admin_person_id', v_person_id));
  return v_trip_id;
end;
$$;

create or replace function public.update_trip(
  p_trip_id uuid, p_expected_version integer, p_title text, p_base_currency text,
  p_start_date date default null, p_end_date date default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip public.trips := private.lock_active_trip(p_trip_id, v_uid);
begin
  perform private.require_admin(v_trip, v_uid);
  if v_trip.version <> p_expected_version then perform private.fail('revision_conflict'); end if;
  if public.currency_exponent(p_base_currency) is null then perform private.fail('unsupported_currency'); end if;
  if p_base_currency <> v_trip.base_currency and exists (
    select 1 from public.settlements s where s.trip_id = p_trip_id and s.status = 'confirmed'
  ) then
    -- Confirmed settlements are frozen in the old base currency (R1).
    perform private.fail('base_currency_locked');
  end if;

  update public.trips
     set title = btrim(p_title), base_currency = p_base_currency, start_date = p_start_date,
         end_date = p_end_date, version = version + 1, updated_at = now()
   where id = p_trip_id;

  perform private.audit(p_trip_id, v_uid, 'trip.updated', 'trip', p_trip_id,
    jsonb_build_object('title', v_trip.title, 'base_currency', v_trip.base_currency,
                       'start_date', v_trip.start_date, 'end_date', v_trip.end_date),
    jsonb_build_object('title', btrim(p_title), 'base_currency', p_base_currency,
                       'start_date', p_start_date, 'end_date', p_end_date));
end;
$$;

-- Placeholder person (decision 19): can be booked before joining, has no access.
create or replace function public.add_trip_person(p_trip_id uuid, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip public.trips := private.lock_active_trip(p_trip_id, v_uid);
  v_id uuid;
begin
  perform private.require_admin(v_trip, v_uid);
  if (select count(*) from public.trip_people p where p.trip_id = p_trip_id) >= 50 then
    perform private.fail('too_many_people');
  end if;
  insert into public.trip_people (trip_id, display_name, status)
  values (p_trip_id, btrim(p_display_name), 'placeholder')
  returning id into v_id;
  perform private.audit(p_trip_id, v_uid, 'person.added', 'trip_person', v_id, null,
    jsonb_build_object('display_name', btrim(p_display_name)));
  return v_id;
end;
$$;

create or replace function public.rename_trip_person(p_person_id uuid, p_display_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_person public.trip_people;
  v_trip public.trips;
begin
  select * into v_person from public.trip_people where id = p_person_id;
  if not found then perform private.fail('person_not_found'); end if;
  v_trip := private.lock_active_trip(v_person.trip_id, v_uid);
  perform private.require_admin(v_trip, v_uid);
  update public.trip_people set display_name = btrim(p_display_name) where id = p_person_id;
  perform private.audit(v_trip.id, v_uid, 'person.renamed', 'trip_person', p_person_id,
    jsonb_build_object('display_name', v_person.display_name), jsonb_build_object('display_name', btrim(p_display_name)));
end;
$$;

-- Atomic hand-over to a verified Google member. One column holds the admin, so 0 or 2 admins are impossible.
create or replace function public.transfer_admin(p_trip_id uuid, p_new_admin_person_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip public.trips := private.lock_active_trip(p_trip_id, v_uid);
  v_target public.trip_people;
begin
  perform private.require_admin(v_trip, v_uid);
  select * into v_target from public.trip_people p
   where p.id = p_new_admin_person_id and p.trip_id = p_trip_id and p.status = 'active';
  if not found then perform private.fail('person_not_found'); end if;
  if v_target.linked_user_id = v_uid then perform private.fail('already_admin'); end if;
  if private.is_anonymous_user(v_target.linked_user_id) or private.google_email(v_target.linked_user_id) is null then
    perform private.fail('admin_requires_google');
  end if;

  update public.trips set admin_user_id = v_target.linked_user_id, version = version + 1, updated_at = now()
   where id = p_trip_id;
  perform private.audit(p_trip_id, v_uid, 'trip.admin_transferred', 'trip', p_trip_id,
    jsonb_build_object('admin_user_id', v_uid), jsonb_build_object('admin_user_id', v_target.linked_user_id));
  perform private.notify_user(v_target.linked_user_id, p_trip_id, 'admin_transferred_to_you', '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Exchange rates (R1)
-- ---------------------------------------------------------------------------

create or replace function public.set_fx_rate(
  p_trip_id uuid, p_currency text, p_eur_per_unit numeric,
  p_expected_revision integer default null, p_rate_date date default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip public.trips := private.lock_active_trip(p_trip_id, v_uid);
  v_old public.trip_fx_rates;
  v_revision integer;
begin
  perform private.require_admin(v_trip, v_uid);
  if public.currency_exponent(p_currency) is null then perform private.fail('unsupported_currency'); end if;
  if p_currency = 'EUR' then perform private.fail('eur_rate_fixed'); end if;
  if p_eur_per_unit is null or p_eur_per_unit <= 0 then perform private.fail('rate_not_positive'); end if;
  if p_eur_per_unit <> round(p_eur_per_unit, 10) then perform private.fail('rate_too_precise'); end if;
  if p_eur_per_unit >= 10000000000 then perform private.fail('rate_too_large'); end if;

  select * into v_old from public.trip_fx_rates r where r.trip_id = p_trip_id and r.currency = p_currency for update;
  if found then
    -- A change must be deliberate: the caller confirms which revision it saw.
    if p_expected_revision is distinct from v_old.revision then perform private.fail('revision_conflict'); end if;
    update public.trip_fx_rates
       set eur_per_unit = p_eur_per_unit, rate_date = p_rate_date, revision = revision + 1,
           updated_by = v_uid, updated_at = now()
     where trip_id = p_trip_id and currency = p_currency
     returning revision into v_revision;
  else
    insert into public.trip_fx_rates (trip_id, currency, eur_per_unit, rate_date, updated_by)
    values (p_trip_id, p_currency, p_eur_per_unit, p_rate_date, v_uid)
    returning revision into v_revision;
  end if;

  -- Fail early (and roll back) if the new data would make the trip's balances overflow.
  perform count(*) from private.trip_balances(p_trip_id);
  perform private.audit(p_trip_id, v_uid, case when v_old.trip_id is null then 'fx.set' else 'fx.changed' end,
    'trip_fx_rate', null,
    case when v_old.trip_id is null then null
         else jsonb_build_object('currency', p_currency, 'eur_per_unit', v_old.eur_per_unit, 'revision', v_old.revision) end,
    jsonb_build_object('currency', p_currency, 'eur_per_unit', p_eur_per_unit, 'revision', v_revision));
  if v_old.trip_id is not null then
    perform private.notify_members(p_trip_id, 'fx_rate_changed',
      jsonb_build_object('currency', p_currency, 'old', v_old.eur_per_unit, 'new', p_eur_per_unit), v_uid);
  end if;
  return v_revision;
end;
$$;

-- Balances before and after a proposed rate change; confirmed settlements stay frozen.
create or replace function public.preview_fx_change(p_trip_id uuid, p_currency text, p_eur_per_unit numeric)
returns table (person_id uuid, current_minor bigint, new_minor bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_trip_admin(p_trip_id) then perform private.fail('admin_required'); end if;
  if p_eur_per_unit is null or p_eur_per_unit <= 0 then perform private.fail('rate_not_positive'); end if;
  return query
    select c.person_id, c.balance_minor, n.balance_minor
    from private.trip_balances(p_trip_id) c
    join private.trip_balances(p_trip_id, p_currency, p_eur_per_unit) n using (person_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Balances (read)
-- ---------------------------------------------------------------------------

create or replace function public.trip_balances(p_trip_id uuid)
returns table (person_id uuid, balance_minor bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_trip_member(p_trip_id) then perform private.fail('trip_not_found'); end if;
  return query select * from private.trip_balances(p_trip_id);
end;
$$;

create or replace function public.expense_base_shares(p_trip_id uuid)
returns table (expense_id uuid, paid_by_person_id uuid, base_total bigint, person_id uuid, base_minor bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_trip_member(p_trip_id) then perform private.fail('trip_not_found'); end if;
  return query select * from private.expense_base_shares(p_trip_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Expenses (R2: normal members can only book themselves as payer)
-- ---------------------------------------------------------------------------

create or replace function private.validate_expense_payer(
  p_trip public.trips, p_uid uuid, p_paid_by uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_own uuid := private.person_of(p_trip.id, p_uid);
begin
  if p_paid_by = v_own then return false; end if;
  -- Someone else as payer: only the trip admin, and it is marked as reconstruction.
  if p_trip.admin_user_id is distinct from p_uid then perform private.fail('payer_not_allowed'); end if;
  if not exists (
    select 1 from public.trip_people p
    where p.id = p_paid_by and p.trip_id = p_trip.id and p.status <> 'removed'
  ) then
    perform private.fail('invalid_payer');
  end if;
  return true;
end;
$$;

create or replace function private.assert_rates_available(p_trip public.trips, p_currency text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_currency <> p_trip.base_currency and (
    private.rate_for(p_trip.id, p_currency) is null or private.rate_for(p_trip.id, p_trip.base_currency) is null
  ) then
    perform private.fail('missing_fx_rate');
  end if;
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
  v_uid uuid := private.require_uid();
  v_trip public.trips := private.lock_active_trip(p_trip_id, v_uid);
  v_existing public.expenses;
  v_payer uuid := coalesce(p_paid_by_person_id, private.person_of(p_trip_id, v_uid));
  v_reconstruction boolean;
  v_id uuid;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  select * into v_existing from public.expenses e
   where e.trip_id = p_trip_id and e.idempotency_key = p_idempotency_key;
  if found then
    -- Retry of the same submission (double tap, offline re-sync): no second booking.
    if v_existing.created_by <> v_uid then perform private.fail('idempotency_conflict'); end if;
    return v_existing.id;
  end if;

  v_reconstruction := private.validate_expense_payer(v_trip, v_uid, v_payer);
  perform private.assert_amount(p_original_minor, p_currency);
  perform private.assert_rates_available(v_trip, p_currency);
  if p_expense_date is null then perform private.fail('date_required'); end if;

  insert into public.expenses (
    trip_id, created_by, paid_by_person_id, title, category, note, expense_date, currency,
    original_minor, split_mode, admin_reconstruction, idempotency_key
  ) values (
    p_trip_id, v_uid, v_payer, btrim(p_title), p_category, nullif(btrim(p_note), ''), p_expense_date, p_currency,
    p_original_minor, p_split_mode, v_reconstruction, p_idempotency_key
  ) returning id into v_id;

  insert into public.expense_splits (expense_id, trip_id, person_id, original_minor, input_value)
  select v_id, p_trip_id, s.person_id, s.original_minor, s.input_value
  from private.compute_original_shares(p_trip_id, p_original_minor, p_split_mode, p_participants) s;

  -- Fail early (and roll back) if the new data would make the trip's balances overflow.
  perform count(*) from private.trip_balances(p_trip_id);
  perform private.audit(p_trip_id, v_uid,
    case when v_reconstruction then 'expense.created_admin_reconstruction' else 'expense.created' end,
    'expense', v_id, null,
    jsonb_build_object('title', btrim(p_title), 'currency', p_currency, 'original_minor', p_original_minor,
                       'paid_by_person_id', v_payer, 'split_mode', p_split_mode));
  perform private.notify_members(p_trip_id, 'expense_created',
    jsonb_build_object('expense_id', v_id, 'title', btrim(p_title)), v_uid);
  return v_id;
end;
$$;

create or replace function private.expense_snapshot(p_expense_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(e) || jsonb_build_object('splits', coalesce((
    select jsonb_agg(jsonb_build_object('person_id', s.person_id, 'original_minor', s.original_minor,
                                        'input_value', s.input_value) order by s.person_id)
    from public.expense_splits s where s.expense_id = e.id), '[]'::jsonb))
  from public.expenses e where e.id = p_expense_id
$$;

create or replace function private.lock_editable_expense(p_expense_id uuid, p_uid uuid, p_expected_revision integer)
returns public.expenses
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expense public.expenses;
  v_trip public.trips;
begin
  select * into v_expense from public.expenses e where e.id = p_expense_id;
  if not found then perform private.fail('expense_not_found'); end if;
  v_trip := private.lock_active_trip(v_expense.trip_id, p_uid);
  select * into v_expense from public.expenses e where e.id = p_expense_id for update;
  if v_expense.deleted_at is not null then perform private.fail('expense_deleted'); end if;
  if v_expense.created_by <> p_uid and v_trip.admin_user_id <> p_uid then perform private.fail('not_allowed'); end if;
  if v_expense.revision <> p_expected_revision then perform private.fail('revision_conflict'); end if;
  return v_expense;
end;
$$;

create or replace function public.update_expense(
  p_expense_id uuid,
  p_expected_revision integer,
  p_title text,
  p_expense_date date,
  p_currency text,
  p_original_minor bigint,
  p_split_mode text,
  p_participants jsonb,
  p_paid_by_person_id uuid default null,
  p_category text default null,
  p_note text default null,
  p_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_old public.expenses := private.lock_editable_expense(p_expense_id, v_uid, p_expected_revision);
  v_trip public.trips;
  v_payer uuid;
  v_reconstruction boolean;
  v_before jsonb := private.expense_snapshot(p_expense_id);
begin
  select * into v_trip from public.trips where id = v_old.trip_id;
  v_payer := coalesce(p_paid_by_person_id, v_old.paid_by_person_id);
  if v_payer = v_old.paid_by_person_id and v_old.admin_reconstruction then
    -- Unchanged foreign payer: only the admin may keep editing a reconstruction.
    if v_trip.admin_user_id <> v_uid then perform private.fail('payer_not_allowed'); end if;
    v_reconstruction := true;
  else
    v_reconstruction := private.validate_expense_payer(v_trip, v_uid, v_payer);
  end if;
  perform private.assert_amount(p_original_minor, p_currency);
  perform private.assert_rates_available(v_trip, p_currency);
  if p_expense_date is null then perform private.fail('date_required'); end if;

  insert into public.expense_revisions (expense_id, trip_id, revision, snapshot, changed_by, reason)
  values (p_expense_id, v_old.trip_id, v_old.revision, v_before, v_uid, nullif(btrim(p_reason), ''));

  delete from public.expense_splits where expense_id = p_expense_id;
  update public.expenses
     set paid_by_person_id = v_payer, title = btrim(p_title), category = p_category,
         note = nullif(btrim(p_note), ''), expense_date = p_expense_date, currency = p_currency,
         original_minor = p_original_minor, split_mode = p_split_mode,
         admin_reconstruction = v_reconstruction, revision = revision + 1, updated_at = now()
   where id = p_expense_id;
  insert into public.expense_splits (expense_id, trip_id, person_id, original_minor, input_value)
  select p_expense_id, v_old.trip_id, s.person_id, s.original_minor, s.input_value
  from private.compute_original_shares(v_old.trip_id, p_original_minor, p_split_mode, p_participants) s;

  -- Fail early (and roll back) if the new data would make the trip's balances overflow.
  perform count(*) from private.trip_balances(v_old.trip_id);
  perform private.audit(v_old.trip_id, v_uid, 'expense.updated', 'expense', p_expense_id, v_before,
    private.expense_snapshot(p_expense_id) || jsonb_build_object('reason', p_reason));
  return v_old.revision + 1;
end;
$$;

create or replace function public.delete_expense(p_expense_id uuid, p_expected_revision integer, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_old public.expenses := private.lock_editable_expense(p_expense_id, v_uid, p_expected_revision);
  v_before jsonb := private.expense_snapshot(p_expense_id);
begin
  insert into public.expense_revisions (expense_id, trip_id, revision, snapshot, changed_by, reason)
  values (p_expense_id, v_old.trip_id, v_old.revision, v_before, v_uid, nullif(btrim(p_reason), ''));
  update public.expenses
     set deleted_at = now(), deleted_by = v_uid, delete_reason = nullif(btrim(p_reason), ''),
         revision = revision + 1, updated_at = now()
   where id = p_expense_id;
  perform private.audit(v_old.trip_id, v_uid, 'expense.deleted', 'expense', p_expense_id, v_before,
    jsonb_build_object('reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- Settlements: sender reports, receiver confirms (R1 snapshot), admin reverses
-- ---------------------------------------------------------------------------

create or replace function public.report_settlement(
  p_trip_id uuid, p_idempotency_key uuid, p_receiver_person_id uuid,
  p_currency text, p_original_minor bigint, p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip public.trips := private.lock_active_trip(p_trip_id, v_uid);
  v_sender uuid := private.person_of(p_trip_id, v_uid);
  v_existing public.settlements;
  v_receiver public.trip_people;
  v_id uuid;
begin
  if p_idempotency_key is null then perform private.fail('idempotency_key_required'); end if;
  select * into v_existing from public.settlements s where s.trip_id = p_trip_id and s.idempotency_key = p_idempotency_key;
  if found then
    if v_existing.reported_by <> v_uid then perform private.fail('idempotency_conflict'); end if;
    return v_existing.id;
  end if;

  select * into v_receiver from public.trip_people p where p.id = p_receiver_person_id and p.trip_id = p_trip_id;
  -- Receiver must be a joined member who can confirm, never an unclaimed placeholder.
  if not found or v_receiver.status <> 'active' then perform private.fail('invalid_receiver'); end if;
  if v_receiver.id = v_sender then perform private.fail('settlement_to_self'); end if;
  perform private.assert_amount(p_original_minor, p_currency);
  perform private.assert_rates_available(v_trip, p_currency);

  insert into public.settlements (trip_id, sender_person_id, receiver_person_id, currency, original_minor,
                                  note, reported_by, idempotency_key)
  values (p_trip_id, v_sender, p_receiver_person_id, p_currency, p_original_minor,
          nullif(btrim(p_note), ''), v_uid, p_idempotency_key)
  returning id into v_id;

  perform private.audit(p_trip_id, v_uid, 'settlement.reported', 'settlement', v_id, null,
    jsonb_build_object('receiver_person_id', p_receiver_person_id, 'currency', p_currency, 'original_minor', p_original_minor));
  perform private.notify_user(v_receiver.linked_user_id, p_trip_id, 'settlement_awaiting_confirmation',
    jsonb_build_object('settlement_id', v_id));
  return v_id;
end;
$$;

create or replace function private.lock_settlement(p_settlement_id uuid, p_uid uuid)
returns public.settlements
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.settlements;
begin
  select * into v_s from public.settlements s where s.id = p_settlement_id;
  if not found then perform private.fail('settlement_not_found'); end if;
  perform private.lock_active_trip(v_s.trip_id, p_uid);
  select * into v_s from public.settlements s where s.id = p_settlement_id for update;
  return v_s;
end;
$$;

-- Only the real receiver confirms. Idempotent. Freezes rate pair and base value atomically (R1).
create or replace function public.confirm_settlement(p_settlement_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.settlements := private.lock_settlement(p_settlement_id, v_uid);
  v_trip public.trips;
  v_from numeric;
  v_base numeric;
  v_base_minor bigint;
begin
  if private.person_of(v_s.trip_id, v_uid) is distinct from v_s.receiver_person_id then
    perform private.fail('only_receiver_can_confirm');
  end if;
  if v_s.status = 'confirmed' then return v_s.confirmed_base_minor; end if;
  if v_s.status <> 'pending' then perform private.fail('settlement_not_pending'); end if;

  select * into v_trip from public.trips where id = v_s.trip_id;
  v_from := private.rate_for(v_trip.id, v_s.currency);
  v_base := private.rate_for(v_trip.id, v_trip.base_currency);
  if v_s.currency <> v_trip.base_currency and (v_from is null or v_base is null) then
    perform private.fail('missing_fx_rate');
  end if;
  v_from := coalesce(v_from, 1);
  v_base := coalesce(v_base, 1);
  v_base_minor := public.convert_minor(v_s.original_minor, v_s.currency, v_trip.base_currency, v_from, v_base);

  update public.settlements
     set status = 'confirmed', decided_at = now(), decided_by = v_uid,
         confirmed_base_minor = v_base_minor, confirmed_base_currency = v_trip.base_currency,
         confirmed_from_rate = v_from, confirmed_base_rate = v_base,
         confirmed_at = now(), confirmed_by = v_uid
   where id = p_settlement_id;

  perform private.audit(v_trip.id, v_uid, 'settlement.confirmed', 'settlement', p_settlement_id, null,
    jsonb_build_object('confirmed_base_minor', v_base_minor, 'base_currency', v_trip.base_currency,
                       'from_rate', v_from, 'base_rate', v_base));
  perform private.notify_user(
    (select p.linked_user_id from public.trip_people p where p.id = v_s.sender_person_id),
    v_trip.id, 'settlement_confirmed', jsonb_build_object('settlement_id', p_settlement_id));
  return v_base_minor;
end;
$$;

create or replace function public.reject_settlement(p_settlement_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.settlements := private.lock_settlement(p_settlement_id, v_uid);
begin
  if private.person_of(v_s.trip_id, v_uid) is distinct from v_s.receiver_person_id then
    perform private.fail('only_receiver_can_reject');
  end if;
  if v_s.status <> 'pending' then perform private.fail('settlement_not_pending'); end if;
  update public.settlements set status = 'rejected', decided_at = now(), decided_by = v_uid where id = p_settlement_id;
  perform private.audit(v_s.trip_id, v_uid, 'settlement.rejected', 'settlement', p_settlement_id);
  perform private.notify_user(
    (select p.linked_user_id from public.trip_people p where p.id = v_s.sender_person_id),
    v_s.trip_id, 'settlement_rejected', jsonb_build_object('settlement_id', p_settlement_id));
end;
$$;

create or replace function public.withdraw_settlement(p_settlement_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.settlements := private.lock_settlement(p_settlement_id, v_uid);
begin
  if private.person_of(v_s.trip_id, v_uid) is distinct from v_s.sender_person_id then
    perform private.fail('only_sender_can_withdraw');
  end if;
  if v_s.status <> 'pending' then perform private.fail('settlement_not_pending'); end if;
  update public.settlements set status = 'withdrawn', decided_at = now(), decided_by = v_uid where id = p_settlement_id;
  perform private.audit(v_s.trip_id, v_uid, 'settlement.withdrawn', 'settlement', p_settlement_id);
end;
$$;

-- Visible counter-booking of a confirmed settlement (R9). Original and its snapshot stay in history.
create or replace function public.reverse_settlement(p_settlement_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_s public.settlements := private.lock_settlement(p_settlement_id, v_uid);
  v_trip public.trips;
  v_id uuid;
begin
  select * into v_trip from public.trips where id = v_s.trip_id;
  perform private.require_admin(v_trip, v_uid);
  if v_s.status <> 'confirmed' then perform private.fail('settlement_not_confirmed'); end if;
  if exists (select 1 from public.settlement_reversals r where r.settlement_id = p_settlement_id) then
    perform private.fail('settlement_already_reversed');
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then perform private.fail('reason_required'); end if;

  insert into public.settlement_reversals (trip_id, settlement_id, reason, reversed_base_minor, created_by)
  values (v_s.trip_id, p_settlement_id, btrim(p_reason), v_s.confirmed_base_minor, v_uid)
  returning id into v_id;

  perform private.audit(v_s.trip_id, v_uid, 'settlement.reversed', 'settlement', p_settlement_id, null,
    jsonb_build_object('reason', btrim(p_reason), 'reversed_base_minor', v_s.confirmed_base_minor));
  perform private.notify_user(p.linked_user_id, v_s.trip_id, 'settlement_reversed',
    jsonb_build_object('settlement_id', p_settlement_id, 'reason', btrim(p_reason)))
  from public.trip_people p where p.id in (v_s.sender_person_id, v_s.receiver_person_id);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invitations and claims (R3)
-- ---------------------------------------------------------------------------

-- Returns the plain token exactly once; only its SHA-256 hash is stored.
create or replace function public.create_invitation(p_person_id uuid, p_valid_days integer default 7)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_person public.trip_people;
  v_trip public.trips;
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  select * into v_person from public.trip_people where id = p_person_id;
  if not found then perform private.fail('person_not_found'); end if;
  v_trip := private.lock_active_trip(v_person.trip_id, v_uid);
  perform private.require_admin(v_trip, v_uid);
  if v_person.status <> 'placeholder' then perform private.fail('person_already_joined'); end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 30 then perform private.fail('invalid_validity'); end if;

  -- One open invitation per person: older ones are revoked.
  update public.trip_invitations set revoked_at = now()
   where target_person_id = p_person_id and consumed_at is null and revoked_at is null;

  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  v_expires := now() + make_interval(days => p_valid_days);
  insert into public.trip_invitations (trip_id, target_person_id, token_hash, created_by, expires_at)
  values (v_trip.id, p_person_id, extensions.digest(v_token, 'sha256'), v_uid, v_expires)
  returning id into v_id;

  perform private.audit(v_trip.id, v_uid, 'invitation.created', 'trip_invitation', v_id, null,
    jsonb_build_object('person_id', p_person_id, 'expires_at', v_expires));
  return jsonb_build_object('invitation_id', v_id, 'token', v_token, 'expires_at', v_expires);
end;
$$;

create or replace function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_inv public.trip_invitations;
  v_trip public.trips;
begin
  select * into v_inv from public.trip_invitations where id = p_invitation_id;
  if not found then perform private.fail('invitation_not_found'); end if;
  v_trip := private.lock_active_trip(v_inv.trip_id, v_uid);
  perform private.require_admin(v_trip, v_uid);
  update public.trip_invitations set revoked_at = now() where id = p_invitation_id and revoked_at is null;
  perform private.audit(v_trip.id, v_uid, 'invitation.revoked', 'trip_invitation', p_invitation_id);
end;
$$;

create or replace function private.person_has_bookings(p_person_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.expenses e where e.paid_by_person_id = p_person_id)
      or exists (select 1 from public.expense_splits s where s.person_id = p_person_id)
      or exists (select 1 from public.settlements s
                 where s.sender_person_id = p_person_id or s.receiver_person_id = p_person_id)
$$;

-- Atomic, single-use redemption. A placeholder with existing bookings needs admin approval first (R3).
create or replace function public.redeem_invitation(p_token text, p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_inv public.trip_invitations;
  v_trip public.trips;
  v_person public.trip_people;
  v_claim_id uuid;
begin
  if p_token is null or char_length(p_token) <> 43 then perform private.fail('invitation_invalid'); end if;
  select * into v_inv from public.trip_invitations i
   where i.token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found then perform private.fail('invitation_invalid'); end if;
  if v_inv.consumed_at is not null then perform private.fail('invitation_used'); end if;
  if v_inv.revoked_at is not null then perform private.fail('invitation_revoked'); end if;
  if v_inv.expires_at <= now() then perform private.fail('invitation_expired'); end if;

  select * into v_trip from public.trips where id = v_inv.trip_id for update;
  if v_trip.status <> 'active' then perform private.fail('trip_archived'); end if;
  if exists (select 1 from public.trip_people p
             where p.trip_id = v_trip.id and p.linked_user_id = v_uid and p.status = 'active') then
    perform private.fail('already_member');
  end if;
  if exists (select 1 from public.membership_claims c
             where c.trip_id = v_trip.id and c.claimant_user_id = v_uid and c.status = 'pending_admin_approval') then
    perform private.fail('claim_pending');
  end if;
  select * into v_person from public.trip_people p where p.id = v_inv.target_person_id for update;
  if v_person.status <> 'placeholder' then perform private.fail('invitation_invalid'); end if;

  insert into public.profiles (user_id, display_name)
  values (v_uid, btrim(p_display_name))
  on conflict (user_id) do nothing;

  update public.trip_invitations set consumed_at = now(), consumed_by = v_uid where id = v_inv.id;

  if private.person_has_bookings(v_person.id) then
    insert into public.membership_claims (trip_id, person_id, claimant_user_id, claimant_display_name, invitation_id)
    values (v_trip.id, v_person.id, v_uid, btrim(p_display_name), v_inv.id)
    returning id into v_claim_id;
    perform private.audit(v_trip.id, v_uid, 'claim.requested', 'membership_claim', v_claim_id, null,
      jsonb_build_object('person_id', v_person.id, 'claimant_display_name', btrim(p_display_name)));
    perform private.notify_user(v_trip.admin_user_id, v_trip.id, 'claim_awaiting_approval',
      jsonb_build_object('claim_id', v_claim_id, 'person_display_name', v_person.display_name,
                         'claimant_display_name', btrim(p_display_name)));
    return jsonb_build_object('status', 'pending_admin_approval', 'trip_title', v_trip.title);
  end if;

  update public.trip_people set linked_user_id = v_uid, status = 'active', linked_at = now() where id = v_person.id;
  perform private.audit(v_trip.id, v_uid, 'person.joined', 'trip_person', v_person.id, null,
    jsonb_build_object('invitation_id', v_inv.id));
  perform private.notify_user(v_trip.admin_user_id, v_trip.id, 'person_joined',
    jsonb_build_object('person_display_name', v_person.display_name));
  return jsonb_build_object('status', 'joined', 'trip_id', v_trip.id, 'trip_title', v_trip.title);
end;
$$;

create or replace function public.decide_claim(p_claim_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_claim public.membership_claims;
  v_trip public.trips;
  v_person public.trip_people;
begin
  select * into v_claim from public.membership_claims where id = p_claim_id;
  if not found then perform private.fail('claim_not_found'); end if;
  v_trip := private.lock_active_trip(v_claim.trip_id, v_uid);
  perform private.require_admin(v_trip, v_uid);
  select * into v_claim from public.membership_claims where id = p_claim_id for update;
  if v_claim.status <> 'pending_admin_approval' then perform private.fail('claim_not_pending'); end if;

  if p_approve then
    select * into v_person from public.trip_people where id = v_claim.person_id for update;
    if v_person.status <> 'placeholder' then perform private.fail('person_already_joined'); end if;
    if exists (select 1 from public.trip_people p
               where p.trip_id = v_trip.id and p.linked_user_id = v_claim.claimant_user_id) then
      perform private.fail('already_member');
    end if;
    update public.trip_people set linked_user_id = v_claim.claimant_user_id, status = 'active', linked_at = now()
     where id = v_person.id;
  end if;
  update public.membership_claims
     set status = case when p_approve then 'approved' else 'rejected' end, decided_at = now(), decided_by = v_uid
   where id = p_claim_id;
  perform private.audit(v_trip.id, v_uid, case when p_approve then 'claim.approved' else 'claim.rejected' end,
    'membership_claim', p_claim_id, null, jsonb_build_object('person_id', v_claim.person_id));
  perform private.notify_user(v_claim.claimant_user_id, v_trip.id,
    case when p_approve then 'claim_approved' else 'claim_rejected' end, jsonb_build_object('trip_title', v_trip.title));
end;
$$;

-- ---------------------------------------------------------------------------
-- Archive with immutable snapshot (decision 17/18, R9)
-- ---------------------------------------------------------------------------

create or replace function private.build_trip_snapshot(p_trip_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'trip', (select jsonb_build_object('id', t.id, 'title', t.title, 'base_currency', t.base_currency,
                                       'start_date', t.start_date, 'end_date', t.end_date)
             from public.trips t where t.id = p_trip_id),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name,
                                                            'status', p.status) order by p.id)
                        from public.trip_people p where p.trip_id = p_trip_id), '[]'),
    'fx_rates', coalesce((select jsonb_agg(jsonb_build_object('currency', r.currency, 'eur_per_unit', r.eur_per_unit,
                                                              'revision', r.revision) order by r.currency)
                          from public.trip_fx_rates r where r.trip_id = p_trip_id), '[]'),
    'balances', coalesce((select jsonb_agg(jsonb_build_object('person_id', b.person_id,
                                                              'balance_minor', b.balance_minor) order by b.person_id)
                          from private.trip_balances(p_trip_id) b), '[]'),
    'expense_shares', coalesce((select jsonb_agg(jsonb_build_object('expense_id', s.expense_id,
                                 'person_id', s.person_id, 'base_total', s.base_total, 'base_minor', s.base_minor)
                                 order by s.expense_id, s.person_id)
                                from private.expense_base_shares(p_trip_id) s), '[]'),
    'settlements', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'status', s.status,
                               'sender_person_id', s.sender_person_id, 'receiver_person_id', s.receiver_person_id,
                               'currency', s.currency, 'original_minor', s.original_minor,
                               'confirmed_base_minor', s.confirmed_base_minor,
                               'confirmed_from_rate', s.confirmed_from_rate, 'confirmed_base_rate', s.confirmed_base_rate,
                               'reversed', exists (select 1 from public.settlement_reversals r where r.settlement_id = s.id))
                               order by s.created_at, s.id)
                             from public.settlements s where s.trip_id = p_trip_id), '[]'),
    'created_at', now()
  )
$$;

create or replace function public.archive_trip(p_trip_id uuid, p_accept_open_balances boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip public.trips := private.lock_active_trip(p_trip_id, v_uid);
  v_snapshot jsonb;
  v_version integer;
begin
  perform private.require_admin(v_trip, v_uid);
  if exists (select 1 from public.settlements s where s.trip_id = p_trip_id and s.status = 'pending') then
    perform private.fail('pending_settlements_exist');
  end if;
  if exists (select 1 from private.trip_balances(p_trip_id) b where b.balance_minor <> 0)
     and not coalesce(p_accept_open_balances, false) then
    perform private.fail('open_balances_need_confirmation');
  end if;

  v_snapshot := private.build_trip_snapshot(p_trip_id);
  select coalesce(max(version), 0) + 1 into v_version from public.trip_closures where trip_id = p_trip_id;
  insert into public.trip_closures (trip_id, version, snapshot, snapshot_sha256, closed_by)
  values (p_trip_id, v_version, v_snapshot, encode(extensions.digest(v_snapshot::text, 'sha256'), 'hex'), v_uid);
  update public.trips set status = 'archived', archived_at = now(), version = version + 1, updated_at = now()
   where id = p_trip_id;
  perform private.audit(p_trip_id, v_uid, 'trip.archived', 'trip', p_trip_id, null,
    jsonb_build_object('closure_version', v_version));
  perform private.notify_members(p_trip_id, 'trip_archived', jsonb_build_object('closure_version', v_version), v_uid);
  return v_version;
end;
$$;

create or replace function public.reopen_trip(p_trip_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip public.trips;
begin
  select * into v_trip from public.trips where id = p_trip_id for update;
  if not found or not private.is_trip_member(p_trip_id) then perform private.fail('trip_not_found'); end if;
  perform private.require_admin(v_trip, v_uid);
  if v_trip.status <> 'archived' then perform private.fail('trip_not_archived'); end if;
  update public.trips set status = 'active', archived_at = null, version = version + 1, updated_at = now()
   where id = p_trip_id;
  perform private.audit(p_trip_id, v_uid, 'trip.reopened', 'trip', p_trip_id);
  perform private.notify_members(p_trip_id, 'trip_reopened', '{}'::jsonb, v_uid);
end;
$$;

-- ---------------------------------------------------------------------------
-- Operator-only procedures (R11). Not callable through the API; run in the SQL editor.
-- ---------------------------------------------------------------------------

create or replace function private.operator_grant_creator(p_email text, p_granted_by text, p_note text default null)
returns void
language sql
set search_path = ''
as $$
  insert into private.creator_allowlist (email, granted_by, note)
  values (lower(btrim(p_email)), p_granted_by, p_note)
  on conflict (email) do update set revoked_at = null, granted_by = excluded.granted_by,
                                    granted_at = now(), note = excluded.note
$$;

create or replace function private.operator_revoke_creator(p_email text)
returns void
language sql
set search_path = ''
as $$
  update private.creator_allowlist set revoked_at = now() where email = lower(btrim(p_email))
$$;

-- Admin recovery after verified identity check outside the app. Target must be an active Google member.
create or replace function private.operator_recover_admin(p_trip_id uuid, p_new_admin_user_id uuid, p_operator_note text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_old uuid;
begin
  if p_operator_note is null or char_length(btrim(p_operator_note)) < 10 then
    raise exception 'operator note with identity check details required';
  end if;
  if not exists (select 1 from public.trip_people p
                 where p.trip_id = p_trip_id and p.linked_user_id = p_new_admin_user_id and p.status = 'active') then
    raise exception 'target is not an active member of this trip';
  end if;
  if private.google_email(p_new_admin_user_id) is null then raise exception 'target has no Google identity'; end if;
  select admin_user_id into v_old from public.trips where id = p_trip_id for update;
  update public.trips set admin_user_id = p_new_admin_user_id, version = version + 1, updated_at = now()
   where id = p_trip_id;
  insert into public.audit_events (trip_id, actor_user_id, action, entity, entity_id, old_values, new_values)
  values (p_trip_id, null, 'operator.admin_recovered', 'trip', p_trip_id,
          jsonb_build_object('admin_user_id', v_old),
          jsonb_build_object('admin_user_id', p_new_admin_user_id, 'operator_note', p_operator_note));
end;
$$;

revoke all on function private.operator_grant_creator(text, text, text) from public, anon, authenticated;
revoke all on function private.operator_revoke_creator(text) from public, anon, authenticated;
revoke all on function private.operator_recover_admin(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Grants: RPCs for signed-in users only (guests included); nothing for anon.
-- ---------------------------------------------------------------------------

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname not in ('currency_exponent', 'convert_minor', 'allocate_largest_remainder')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end;
$$;
