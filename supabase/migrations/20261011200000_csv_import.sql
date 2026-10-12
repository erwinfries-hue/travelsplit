-- M7: CSV import (R7). One atomic batch per file; the same file cannot be imported twice into a trip.
-- Imported expenses go through the normal create_expense checks (payer rules, rates, split sums).
-- Settlements are never imported: a repayment always needs the receiver's own confirmation.

create table public.csv_import_batches (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  schema_version integer not null,
  imported_by uuid not null references auth.users (id),
  expense_count integer not null,
  people_created integer not null,
  rates_set integer not null,
  created_at timestamptz not null default now(),
  unique (trip_id, content_sha256)
);
alter table public.csv_import_batches enable row level security;
create policy csv_import_batches_select on public.csv_import_batches
  for select to authenticated using (private.is_trip_member(trip_id));
revoke all on public.csv_import_batches from anon, authenticated;
grant select on public.csv_import_batches to authenticated;

create or replace function private.fail_row(p_code text, p_row text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using message = p_code, detail = 'row ' || coalesce(p_row, '?'), errcode = 'P0001';
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
  -- Set only inside public.import_expenses_csv (transaction-local, not reachable through the API).
  v_import text := nullif(current_setting('travelsplit.import_batch', true), '');
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
    original_minor, split_mode, admin_reconstruction, idempotency_key, source
  ) values (
    p_trip_id, v_uid, v_payer, btrim(p_title), p_category, nullif(btrim(p_note), ''), p_expense_date, p_currency,
    p_original_minor, p_split_mode, v_reconstruction, p_idempotency_key,
    case when v_import is null then 'app' else 'csv_import' end
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
  if v_import is null then
    perform private.notify_members(p_trip_id, 'expense_created',
      jsonb_build_object('expense_id', v_id, 'title', btrim(p_title)), v_uid);
  end if;
  return v_id;
end;
$$;

create or replace function public.import_expenses_csv(
  p_trip_id uuid,
  p_content_sha256 text,
  p_schema_version integer,
  p_rates jsonb,
  p_expenses jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip public.trips := private.lock_active_trip(p_trip_id, v_uid);
  v_batch uuid := gen_random_uuid();
  v_people jsonb := '{}'::jsonb;
  v_people_created integer := 0;
  v_rates_set integer := 0;
  v_count integer := 0;
  v_rate jsonb;
  v_existing numeric;
  v_exp jsonb;
  v_share jsonb;
  v_name text;
  v_key text;
  v_person uuid;
  v_participants jsonb;
  v_row text;
begin
  perform private.require_admin(v_trip, v_uid);
  if p_schema_version is distinct from 1 then perform private.fail('import_unsupported_version'); end if;
  if p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$' then perform private.fail('import_invalid_file'); end if;
  if exists (select 1 from public.csv_import_batches b where b.trip_id = p_trip_id and b.content_sha256 = p_content_sha256) then
    perform private.fail('import_duplicate');
  end if;
  if jsonb_typeof(p_expenses) <> 'array' or jsonb_array_length(p_expenses) = 0 then perform private.fail('import_empty'); end if;
  if jsonb_array_length(p_expenses) > 2000 then perform private.fail('import_too_large'); end if;
  if p_rates is not null and jsonb_typeof(p_rates) <> 'array' then perform private.fail('import_invalid_file'); end if;

  perform set_config('travelsplit.import_batch', v_batch::text, true);

  -- Existing, not removed people by case-insensitive name; duplicate names are ambiguous.
  for v_key, v_person in
    select lower(btrim(p.display_name)), p.id from public.trip_people p
    where p.trip_id = p_trip_id and p.status <> 'removed'
  loop
    if v_people ? v_key then perform private.fail_row('import_ambiguous_person', v_key); end if;
    v_people := v_people || jsonb_build_object(v_key, v_person);
  end loop;

  for v_rate in select * from jsonb_array_elements(coalesce(p_rates, '[]'::jsonb)) loop
    if v_rate ->> 'currency' = 'EUR' then continue; end if;
    select r.eur_per_unit into v_existing from public.trip_fx_rates r
     where r.trip_id = p_trip_id and r.currency = v_rate ->> 'currency';
    if found then
      if v_existing <> (v_rate ->> 'eur_per_unit')::numeric then
        perform private.fail_row('import_rate_conflict', v_rate ->> 'currency');
      end if;
    else
      perform public.set_fx_rate(p_trip_id, v_rate ->> 'currency', (v_rate ->> 'eur_per_unit')::numeric);
      v_rates_set := v_rates_set + 1;
    end if;
  end loop;

  for v_exp in select * from jsonb_array_elements(p_expenses) loop
    v_row := v_exp ->> 'row_id';
    if v_row is null or char_length(v_row) > 64 then perform private.fail_row('import_invalid_row', v_row); end if;
    if char_length(btrim(coalesce(v_exp ->> 'title', ''))) not between 1 and 120
       or (v_exp ->> 'category') is not null and (v_exp ->> 'category') not in ('transport', 'accommodation', 'food', 'activities', 'shopping', 'other')
       or char_length(coalesce(v_exp ->> 'note', '')) > 1000
       or jsonb_typeof(v_exp -> 'shares') <> 'array' then
      perform private.fail_row('import_invalid_row', v_row);
    end if;

    -- Map payer and participant names; unknown names become placeholders.
    v_participants := '[]'::jsonb;
    for v_name in
      select v_exp ->> 'paid_by_name'
      union all
      select s ->> 'name' from jsonb_array_elements(v_exp -> 'shares') s
    loop
      v_key := lower(btrim(coalesce(v_name, '')));
      if v_key = '' or char_length(v_key) > 60 then perform private.fail_row('import_invalid_row', v_row); end if;
      if not v_people ? v_key then
        v_person := public.add_trip_person(p_trip_id, btrim(v_name));
        v_people := v_people || jsonb_build_object(v_key, v_person);
        v_people_created := v_people_created + 1;
      end if;
    end loop;
    for v_share in select * from jsonb_array_elements(v_exp -> 'shares') loop
      v_participants := v_participants || jsonb_build_array(jsonb_build_object(
        'person_id', v_people ->> lower(btrim(v_share ->> 'name')),
        'value', v_share -> 'value'));
    end loop;

    begin
      perform public.create_expense(
        p_trip_id,
        -- Deterministic per file and row, so a retried request cannot double-book.
        (md5(p_content_sha256 || ':' || v_row))::uuid,
        v_exp ->> 'title',
        (v_exp ->> 'date')::date,
        v_exp ->> 'currency',
        (v_exp ->> 'original_minor')::bigint,
        v_exp ->> 'split_mode',
        v_participants,
        (v_people ->> lower(btrim(v_exp ->> 'paid_by_name')))::uuid,
        v_exp ->> 'category',
        v_exp ->> 'note');
    exception
      when sqlstate 'P0001' then perform private.fail_row(sqlerrm, v_row);
      when invalid_datetime_format or datetime_field_overflow or invalid_text_representation or numeric_value_out_of_range then
        perform private.fail_row('import_invalid_row', v_row);
    end;
    v_count := v_count + 1;
  end loop;

  insert into public.csv_import_batches (id, trip_id, content_sha256, schema_version, imported_by, expense_count, people_created, rates_set)
  values (v_batch, p_trip_id, p_content_sha256, p_schema_version, v_uid, v_count, v_people_created, v_rates_set);
  perform private.audit(p_trip_id, v_uid, 'import.completed', 'csv_import_batch', v_batch, null,
    jsonb_build_object('expenses', v_count, 'people_created', v_people_created, 'rates_set', v_rates_set, 'sha256', p_content_sha256));
  perform private.notify_members(p_trip_id, 'csv_imported', jsonb_build_object('count', v_count), v_uid);
  return jsonb_build_object('batch_id', v_batch, 'expenses', v_count, 'people_created', v_people_created, 'rates_set', v_rates_set);
end;
$$;

revoke all on function public.import_expenses_csv(uuid, text, integer, jsonb, jsonb) from public, anon;
grant execute on function public.import_expenses_csv(uuid, text, integer, jsonb, jsonb) to authenticated;
revoke all on function private.fail_row(text, text) from public, anon, authenticated;
