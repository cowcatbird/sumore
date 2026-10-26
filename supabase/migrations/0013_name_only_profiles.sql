-- Display names are not usernames. Existing account IDs, friend codes, circle
-- relationships, and legacy handle values stay untouched.
alter table public.profiles drop constraint if exists profiles_handle_key;

-- Match JavaScript String.trim() at the API boundary without collapsing spaces
-- inside a name. Keep this helper private; clients use the authenticated RPC.
create or replace function public.normalize_profile_display_name(input_name text) returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select btrim(
    coalesce(input_name, ''),
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
  )
$$;

create or replace function public.update_my_profile_name(new_display_name text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  requested_name := public.normalize_profile_display_name(new_display_name);
  if char_length(requested_name) not between 1 and 60 then
    raise exception 'Display name must be between 1 and 60 characters';
  end if;

  update public.profiles
  set display_name = requested_name
  where id = auth.uid();
  if not found then raise exception 'Your profile is not available. Please sign in again.'; end if;
end;
$$;

-- Older binaries can still finish their existing two-field settings form. The
-- retired handle argument is intentionally ignored, not erased or reassigned.
create or replace function public.update_my_profile(
  new_display_name text,
  new_handle text
) returns void
language sql
security definer
set search_path = ''
as $$ select public.update_my_profile_name(new_display_name) $$;

-- Older binaries preflight this endpoint before signup. Retain their format
-- contract without querying profile identities or reserving a unique username.
create or replace function public.is_handle_available(candidate_handle text) returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(lower(btrim(candidate_handle)) ~ '^[a-z0-9_]{3,24}$', false)
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text;
  attempt integer := 0;
  conflict_constraint text;
  conflict_table text;
  conflict_schema text;
begin
  requested_name := public.normalize_profile_display_name(new.raw_user_meta_data ->> 'display_name');
  if char_length(requested_name) not between 1 and 60 then
    raise exception 'Display name must be between 1 and 60 characters';
  end if;

  -- Friend-code generation checks existing codes, but two concurrent signups
  -- can still choose the same candidate. Retry just that specific constraint.
  -- Profile IDs, circle ownership, and any other errors must not be swallowed.
  loop
    attempt := attempt + 1;
    begin
      insert into public.profiles (id, display_name, friend_code)
      values (new.id, requested_name, public.generate_friend_code());
      exit;
    exception when unique_violation then
      get stacked diagnostics
        conflict_constraint = constraint_name,
        conflict_table = table_name,
        conflict_schema = schema_name;
      if conflict_schema is distinct from 'public'
        or conflict_table is distinct from 'profiles'
        or conflict_constraint is distinct from 'profiles_friend_code_unique'
        or attempt >= 5
      then
        raise;
      end if;
    end;
  end loop;

  -- Keep this outside the retry block: a circle-ownership failure is not a
  -- friend-code collision. The auth transaction rolls both inserts back.
  insert into public.circles (owner_id) values (new.id);
  return new;
end;
$$;

revoke all on function public.normalize_profile_display_name(text) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.update_my_profile_name(text) from public, anon, authenticated;
revoke all on function public.update_my_profile(text, text) from public, anon, authenticated;
revoke all on function public.is_handle_available(text) from public, anon, authenticated;
grant execute on function public.update_my_profile_name(text) to authenticated;
grant execute on function public.update_my_profile(text, text) to authenticated;
grant execute on function public.is_handle_available(text) to anon, authenticated;

-- Table policies, the display-name length check, and friend-code format,
-- NOT NULL, and uniqueness constraints are deliberately unchanged.
