-- Final privilege sweep. Functions are created with EXECUTE for PUBLIC by default in Postgres
-- (and Supabase adds anon/authenticated defaults), so normalise everything here:
-- nothing for anon, authenticated only where needed. Operator procedures stay owner-only.

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig, n.nspname as schema, p.proname as name
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.name not like 'operator\_%' and f.name not in ('audit_events_guard', 'settlements_freeze_guard',
                                                         'expenses_immutable_guard', 'closures_guard') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end;
$$;

-- Public, harmless helper used for client-side validation hints.
grant execute on function public.currency_exponent(text) to anon;

alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges in schema private revoke execute on functions from public, anon;
