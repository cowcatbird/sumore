-- Require new device accounts to choose a real display name and unique handle.

create or replace function public.is_handle_available(candidate_handle text) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    lower(trim(candidate_handle)) ~ '^[a-z0-9_]{3,24}$'
    and not exists (
      select 1 from public.profiles where handle = lower(trim(candidate_handle))
    )
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_name text;
  requested_handle text;
begin
  requested_name := trim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  requested_handle := lower(trim(coalesce(new.raw_user_meta_data ->> 'handle', '')));

  if char_length(requested_name) not between 1 and 60 then
    raise exception 'A display name is required';
  end if;
  if requested_handle <> '' and requested_handle !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'Handle must be 3-24 letters, numbers, or underscores';
  end if;

  insert into public.profiles (id, display_name, handle)
  values (new.id, requested_name, nullif(requested_handle, ''));
  insert into public.circles (owner_id) values (new.id);
  return new;
exception
  when unique_violation then
    raise exception 'That handle is already taken';
end;
$$;

revoke all on function public.is_handle_available(text) from public;
grant execute on function public.is_handle_available(text) to anon, authenticated;
