-- Anonymous device accounts need a safe way to remove their own test or abandoned data.

create or replace function public.delete_my_account() returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  account_id uuid := auth.uid();
begin
  if account_id is null then raise exception 'Authentication required'; end if;
  delete from auth.users where id = account_id;
end;
$$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;
