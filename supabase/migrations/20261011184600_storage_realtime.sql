-- Private receipt storage (R8) and realtime publication (R12).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 1048576, array['image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Path layout: <trip_id>/<expense_id>/<random>.jpg. The path is never the authority:
-- every check looks up the expense and the caller's membership in the database.
create or replace function private.can_edit_receipt(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_parts text[] := string_to_array(p_object_name, '/');
  v_trip_id uuid;
  v_expense_id uuid;
begin
  if array_length(v_parts, 1) <> 3 then return false; end if;
  begin
    v_trip_id := v_parts[1]::uuid;
    v_expense_id := v_parts[2]::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return exists (
    select 1
    from public.expenses e
    join public.trips t on t.id = e.trip_id
    where e.id = v_expense_id and e.trip_id = v_trip_id and e.deleted_at is null and t.status = 'active'
      and private.is_trip_member(t.id)
      and (e.created_by = (select auth.uid()) or t.admin_user_id = (select auth.uid()))
  );
end;
$$;

create or replace function private.can_read_receipt(p_object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.receipt_files r
    where r.storage_path = p_object_name and private.is_trip_member(r.trip_id)
  )
$$;

grant execute on function private.can_edit_receipt(text), private.can_read_receipt(text) to authenticated;

create policy receipts_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and private.can_read_receipt(name));

create policy receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and private.can_edit_receipt(name));

create policy receipts_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and private.can_edit_receipt(name));

-- Registers an uploaded object as the (single) receipt of an expense.
-- Returns the previous object path, which the client then deletes from storage.
create or replace function public.attach_receipt(p_expense_id uuid, p_storage_path text, p_sha256 text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_expense public.expenses;
  v_object record;
  v_old text;
begin
  select * into v_expense from public.expenses where id = p_expense_id;
  if not found then perform private.fail('expense_not_found'); end if;
  perform private.lock_active_trip(v_expense.trip_id, v_uid);
  if p_storage_path not like v_expense.trip_id::text || '/' || p_expense_id::text || '/%'
     or not private.can_edit_receipt(p_storage_path) then
    perform private.fail('not_allowed');
  end if;
  select o.owner_id, o.metadata into v_object
  from storage.objects o where o.bucket_id = 'receipts' and o.name = p_storage_path;
  if not found then perform private.fail('receipt_not_uploaded'); end if;
  if v_object.owner_id is distinct from v_uid::text then perform private.fail('not_allowed'); end if;

  select storage_path into v_old from public.receipt_files where expense_id = p_expense_id for update;
  insert into public.receipt_files (expense_id, trip_id, storage_path, size_bytes, mime_type, sha256, created_by)
  values (p_expense_id, v_expense.trip_id, p_storage_path, (v_object.metadata ->> 'size')::integer,
          v_object.metadata ->> 'mimetype', lower(p_sha256), v_uid)
  on conflict (expense_id) do update
    set storage_path = excluded.storage_path, size_bytes = excluded.size_bytes, mime_type = excluded.mime_type,
        sha256 = excluded.sha256, created_by = excluded.created_by, created_at = now();
  perform private.audit(v_expense.trip_id, v_uid, 'receipt.attached', 'expense', p_expense_id,
    case when v_old is null then null else jsonb_build_object('storage_path', v_old) end,
    jsonb_build_object('storage_path', p_storage_path, 'sha256', lower(p_sha256)));
  return v_old;
end;
$$;

create or replace function public.detach_receipt(p_expense_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_receipt public.receipt_files;
begin
  select * into v_receipt from public.receipt_files where expense_id = p_expense_id;
  if not found then return null; end if;
  perform private.lock_active_trip(v_receipt.trip_id, v_uid);
  if not private.can_edit_receipt(v_receipt.storage_path) then perform private.fail('not_allowed'); end if;
  delete from public.receipt_files where expense_id = p_expense_id;
  perform private.audit(v_receipt.trip_id, v_uid, 'receipt.detached', 'expense', p_expense_id,
    jsonb_build_object('storage_path', v_receipt.storage_path), null);
  return v_receipt.storage_path;
end;
$$;

revoke all on function public.attach_receipt(uuid, text, text), public.detach_receipt(uuid) from public, anon;
grant execute on function public.attach_receipt(uuid, text, text), public.detach_receipt(uuid) to authenticated;

-- Realtime: clients only receive rows their RLS select policies allow; they use events as
-- "something changed" signals and re-read through the RPCs.
alter publication supabase_realtime add table
  public.trips, public.trip_people, public.trip_fx_rates, public.expenses, public.settlements,
  public.settlement_reversals, public.membership_claims, public.in_app_notices;
