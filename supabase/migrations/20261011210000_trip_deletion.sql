-- M8 / OPS-03: complete deletion of an archived trip, photos included.
-- Two steps, because storage files can only be removed through the Storage API:
--   1. request_trip_deletion: admin confirms with the exact trip title; returns every stored file path.
--      From now on the admin may delete those files (and nothing else).
--   2. delete_trip: succeeds only when no file of the trip is left, then removes all rows in one statement.
-- Only a content-free tombstone remains for the operator.

create table private.trip_deletion_requests (
  trip_id uuid primary key references public.trips (id) on delete cascade,
  requested_by uuid not null references auth.users (id),
  requested_at timestamptz not null default now()
);

create table private.deleted_trips (
  trip_id uuid primary key,
  deleted_by uuid,
  deleted_at timestamptz not null default now(),
  expense_count integer not null,
  file_count integer not null
);

-- Admin of an archived trip that is marked for deletion may remove its files, including those of
-- soft-deleted expenses and replaced receipts that no longer have a database row.
alter table private.trip_deletion_requests enable row level security;
alter table private.deleted_trips enable row level security;
revoke all on private.trip_deletion_requests, private.deleted_trips from public, anon, authenticated;

create or replace function private.can_purge_receipt(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_trip_id uuid;
begin
  begin
    v_trip_id := split_part(p_object_name, '/', 1)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return exists (
    select 1 from public.trips t
    join private.trip_deletion_requests d on d.trip_id = t.id
    where t.id = v_trip_id and t.status = 'archived' and t.admin_user_id = (select auth.uid())
  );
end;
$$;
revoke all on function private.can_purge_receipt(text) from public, anon;
grant execute on function private.can_purge_receipt(text) to authenticated;

create policy receipts_purge on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and private.can_purge_receipt(name));
-- Deleting needs to see the object first.
create policy receipts_purge_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and private.can_purge_receipt(name));

create or replace function private.require_archived_admin(p_trip_id uuid, p_uid uuid)
returns public.trips
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip public.trips;
begin
  select * into v_trip from public.trips t where t.id = p_trip_id for update;
  if not found or not private.is_trip_member(p_trip_id) then perform private.fail('trip_not_found'); end if;
  if v_trip.admin_user_id <> p_uid then perform private.fail('admin_required'); end if;
  if v_trip.status <> 'archived' then perform private.fail('trip_not_archived'); end if;
  return v_trip;
end;
$$;

create or replace function public.request_trip_deletion(p_trip_id uuid, p_confirm_title text)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip public.trips := private.require_archived_admin(p_trip_id, v_uid);
begin
  if p_confirm_title is distinct from v_trip.title then perform private.fail('confirm_title_mismatch'); end if;
  insert into private.trip_deletion_requests (trip_id, requested_by) values (p_trip_id, v_uid)
  on conflict (trip_id) do nothing;
  return coalesce((
    select array_agg(o.name order by o.name) from storage.objects o
    where o.bucket_id = 'receipts' and o.name like p_trip_id::text || '/%'
  ), '{}');
end;
$$;

create or replace function public.cancel_trip_deletion(p_trip_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
begin
  perform private.require_archived_admin(p_trip_id, v_uid);
  delete from private.trip_deletion_requests where trip_id = p_trip_id;
end;
$$;

create or replace function public.delete_trip(p_trip_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_trip public.trips := private.require_archived_admin(p_trip_id, v_uid);
  v_members uuid[];
  v_files integer;
begin
  if not exists (select 1 from private.trip_deletion_requests d where d.trip_id = p_trip_id) then
    perform private.fail('deletion_not_requested');
  end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'receipts' and o.name like p_trip_id::text || '/%') then
    perform private.fail('receipts_remaining');
  end if;
  select coalesce(array_agg(p.linked_user_id), '{}') into v_members
  from public.trip_people p where p.trip_id = p_trip_id and p.status = 'active' and p.linked_user_id <> v_uid;
  select count(*) into v_files from public.receipt_files r where r.trip_id = p_trip_id;

  insert into private.deleted_trips (trip_id, deleted_by, expense_count, file_count)
  values (p_trip_id, v_uid, (select count(*) from public.expenses e where e.trip_id = p_trip_id), v_files);

  perform set_config('travelsplit.deleting_trip', p_trip_id::text, true);
  -- Children that reference trip_people first; everything else goes with the trip (on delete cascade).
  delete from public.settlement_reversals where trip_id = p_trip_id;
  delete from public.settlements where trip_id = p_trip_id;
  delete from public.receipt_files where trip_id = p_trip_id;
  delete from public.expense_splits where trip_id = p_trip_id;
  delete from public.expenses where trip_id = p_trip_id;
  delete from public.trips where id = p_trip_id;

  -- Members learn that the trip is gone; the notice carries only the title.
  insert into public.in_app_notices (user_id, trip_id, kind, payload)
  select m, null, 'trip_deleted', jsonb_build_object('trip_title', v_trip.title) from unnest(v_members) m;
end;
$$;

revoke all on function public.request_trip_deletion(uuid, text), public.cancel_trip_deletion(uuid), public.delete_trip(uuid) from public, anon;
grant execute on function public.request_trip_deletion(uuid, text), public.cancel_trip_deletion(uuid), public.delete_trip(uuid) to authenticated;
revoke all on function private.require_archived_admin(uuid, uuid) from public, anon, authenticated;

-- Reopening a trip cancels a pending deletion, so its files cannot be purged later without a new confirmation.
create or replace function private.cancel_deletion_on_reopen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active' and old.status = 'archived' then
    delete from private.trip_deletion_requests where trip_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function private.cancel_deletion_on_reopen() from public, anon, authenticated;
create trigger trips_cancel_deletion_on_reopen
  after update of status on public.trips
  for each row execute function private.cancel_deletion_on_reopen();
