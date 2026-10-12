-- Internal helpers used by the RPCs. Schema `private` is not exposed through the API.

create or replace function private.fail(p_code text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- Stable machine-readable codes; the client maps them to translated messages.
  raise exception using message = p_code, errcode = 'P0001';
end;
$$;

create or replace function private.require_uid()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then perform private.fail('not_authenticated'); end if;
  return v_uid;
end;
$$;

-- Anonymous (guest) sessions also have role `authenticated`; check the user record itself.
create or replace function private.is_anonymous_user(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select u.is_anonymous from auth.users u where u.id = p_uid), true)
    or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
$$;

-- Verified Google identity. identity_data comes from the provider and cannot be edited by the user.
create or replace function private.google_email(p_uid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(i.identity_data ->> 'email')
  from auth.identities i
  where i.user_id = p_uid
    and i.provider = 'google'
    and coalesce((i.identity_data ->> 'email_verified')::boolean, false)
  order by i.created_at
  limit 1
$$;

create or replace function private.is_allowed_creator(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not private.is_anonymous_user(p_uid)
    and exists (
      select 1 from private.creator_allowlist a
      where a.email = private.google_email(p_uid) and a.revoked_at is null
    )
$$;

-- Lock a trip row for a write. Caller must be a confirmed member; trip must be active.
create or replace function private.lock_active_trip(p_trip_id uuid, p_uid uuid)
returns public.trips
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips;
begin
  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found or not exists (
    select 1 from public.trip_people p
    where p.trip_id = p_trip_id and p.linked_user_id = p_uid and p.status = 'active'
  ) then
    perform private.fail('trip_not_found');
  end if;
  if v_trip.status <> 'active' then perform private.fail('trip_archived'); end if;
  return v_trip;
end;
$$;

create or replace function private.require_admin(p_trip public.trips, p_uid uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_trip.admin_user_id is distinct from p_uid then perform private.fail('admin_required'); end if;
end;
$$;

create or replace function private.person_of(p_trip_id uuid, p_uid uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from public.trip_people p
  where p.trip_id = p_trip_id and p.linked_user_id = p_uid and p.status = 'active'
$$;

create or replace function private.audit(
  p_trip_id uuid, p_actor uuid, p_action text, p_entity text, p_entity_id uuid,
  p_old jsonb default null, p_new jsonb default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_events (trip_id, actor_user_id, action, entity, entity_id, old_values, new_values)
  values (p_trip_id, p_actor, p_action, p_entity, p_entity_id, p_old, p_new)
$$;

create or replace function private.notify_user(p_user_id uuid, p_trip_id uuid, p_kind text, p_payload jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.in_app_notices (user_id, trip_id, kind, payload)
  select p_user_id, p_trip_id, p_kind, p_payload where p_user_id is not null
$$;

create or replace function private.notify_members(p_trip_id uuid, p_kind text, p_payload jsonb, p_except uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.in_app_notices (user_id, trip_id, kind, payload)
  select p.linked_user_id, p_trip_id, p_kind, p_payload
  from public.trip_people p
  where p.trip_id = p_trip_id and p.status = 'active' and p.linked_user_id is distinct from p_except
$$;

-- EUR per unit for a trip currency; EUR is always 1; null when not set.
create or replace function private.rate_for(
  p_trip_id uuid, p_currency text, p_override_currency text default null, p_override_rate numeric default null
)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_currency = 'EUR' then 1::numeric
    when p_currency = p_override_currency then p_override_rate
    else (select r.eur_per_unit from public.trip_fx_rates r where r.trip_id = p_trip_id and r.currency = p_currency)
  end
$$;

create or replace function private.assert_amount(p_minor bigint, p_currency text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_exp integer := public.currency_exponent(p_currency);
begin
  if v_exp is null then perform private.fail('unsupported_currency'); end if;
  if p_minor is null or p_minor <= 0 then perform private.fail('amount_not_positive'); end if;
  if p_minor > 1000000000::numeric * (10::numeric ^ v_exp) then perform private.fail('amount_too_large'); end if;
end;
$$;

-- Split an original amount into per-person minor units. Mirrors splitOriginal() in TypeScript.
-- p_participants: [{"person_id": uuid, "value": "<bigint>"}]; value ignored for 'equal'.
create or replace function private.compute_original_shares(
  p_trip_id uuid, p_total bigint, p_mode text, p_participants jsonb
)
returns table (person_id uuid, original_minor bigint, input_value bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  v_values bigint[];
  v_parts bigint[];
  v_n integer;
  v_sum numeric;
begin
  if p_total is null or p_total <= 0 then perform private.fail('amount_not_positive'); end if;
  if p_participants is null or jsonb_typeof(p_participants) <> 'array' or jsonb_array_length(p_participants) = 0 then
    perform private.fail('no_participants');
  end if;
  if jsonb_array_length(p_participants) > 50 then perform private.fail('too_many_participants'); end if;

  select array_agg((x ->> 'person_id')::uuid order by (x ->> 'person_id')::uuid),
         array_agg(nullif(x ->> 'value', '')::bigint order by (x ->> 'person_id')::uuid)
    into v_ids, v_values
  from jsonb_array_elements(p_participants) as x;
  v_n := array_length(v_ids, 1);

  if (select count(distinct i) from unnest(v_ids) as i) <> v_n then perform private.fail('duplicate_participant'); end if;
  -- Every participant must be a non-removed person of this very trip.
  if (select count(*) from public.trip_people p
      where p.trip_id = p_trip_id and p.id = any(v_ids) and p.status <> 'removed') <> v_n then
    perform private.fail('invalid_participant');
  end if;

  if p_mode = 'equal' then
    v_parts := public.allocate_largest_remainder(p_total, array_fill(1::bigint, array[v_n]));
    v_values := array_fill(null::bigint, array[v_n]);
  elsif p_mode in ('fixed', 'percent') then
    if exists (select 1 from unnest(v_values) as v where v is null or v < 0) then
      perform private.fail('invalid_share_value');
    end if;
    select sum(v) into v_sum from unnest(v_values) as v;
    if p_mode = 'fixed' then
      if v_sum <> p_total then perform private.fail('fixed_sum_mismatch'); end if;
      v_parts := v_values;
    else
      if v_sum <> 1000000 then perform private.fail('percent_sum_mismatch'); end if;
      v_parts := public.allocate_largest_remainder(p_total, v_values);
    end if;
  else
    perform private.fail('invalid_split_mode');
  end if;

  if not exists (select 1 from unnest(v_parts) as v where v > 0) then perform private.fail('no_positive_share'); end if;

  return query
    select v_ids[i], v_parts[i], v_values[i]
    from generate_series(1, v_n) as i
    where v_parts[i] > 0;
end;
$$;

-- Base-currency view of every live expense of a trip, optionally with one rate overridden (preview).
create or replace function private.expense_base_shares(
  p_trip_id uuid, p_override_currency text default null, p_override_rate numeric default null
)
returns table (expense_id uuid, paid_by_person_id uuid, base_total bigint, person_id uuid, base_minor bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base text;
  e record;
  v_total bigint;
  v_ids uuid[];
  v_weights bigint[];
  v_parts bigint[];
begin
  select t.base_currency into v_base from public.trips t where t.id = p_trip_id;
  for e in
    select x.id, x.paid_by_person_id, x.currency, x.original_minor
    from public.expenses x
    where x.trip_id = p_trip_id and x.deleted_at is null
    order by x.id
  loop
    v_total := public.convert_minor(
      e.original_minor, e.currency, v_base,
      private.rate_for(p_trip_id, e.currency, p_override_currency, p_override_rate),
      private.rate_for(p_trip_id, v_base, p_override_currency, p_override_rate)
    );
    select array_agg(s.person_id order by s.person_id), array_agg(s.original_minor order by s.person_id)
      into v_ids, v_weights
    from public.expense_splits s where s.expense_id = e.id;
    v_parts := public.allocate_largest_remainder(v_total, v_weights);
    return query
      select e.id, e.paid_by_person_id, v_total, v_ids[i], v_parts[i]
      from generate_series(1, array_length(v_ids, 1)) as i;
  end loop;
end;
$$;

-- Net balance per person (positive = is owed money). Mirrors computeBalances() in TypeScript.
create or replace function private.trip_balances(
  p_trip_id uuid, p_override_currency text default null, p_override_rate numeric default null
)
returns table (person_id uuid, balance_minor bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with shares as (
    select * from private.expense_base_shares(p_trip_id, p_override_currency, p_override_rate)
  ),
  movements as (
    select distinct on (s.expense_id) s.paid_by_person_id as person_id, s.base_total as amount
      from shares s
    union all
    select s.person_id, -s.base_minor from shares s
    union all
    select st.sender_person_id, st.confirmed_base_minor
      from public.settlements st
      where st.trip_id = p_trip_id and st.status = 'confirmed'
        and not exists (select 1 from public.settlement_reversals r where r.settlement_id = st.id)
    union all
    select st.receiver_person_id, -st.confirmed_base_minor
      from public.settlements st
      where st.trip_id = p_trip_id and st.status = 'confirmed'
        and not exists (select 1 from public.settlement_reversals r where r.settlement_id = st.id)
  )
  select p.id, coalesce(sum(m.amount), 0)::bigint
  from public.trip_people p
  left join movements m on m.person_id = p.id
  where p.trip_id = p_trip_id
  group by p.id
$$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
