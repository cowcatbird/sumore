-- Friend codes identify an account; they are no longer editable profile data.
-- This migration does not rewrite any existing code (including legacy custom
-- codes), account, membership, wallet, purchase, request, or recovery record.
-- It is independent of the separate 0025 starting-balance change.

create or replace function public.guard_profile_friend_code() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Never trust a supplied code, even from signup metadata, an old writer,
    -- or a future insert/upsert endpoint. The UNIQUE constraint arbitrates
    -- concurrent candidates; handle_new_user retries only that collision.
    new.friend_code := public.generate_friend_code();
  elsif new.friend_code is distinct from old.friend_code then
    raise exception 'Friend codes are automatically assigned and cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_friend_code
before insert or update on public.profiles
for each row execute function public.guard_profile_friend_code();

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

  loop
    attempt := attempt + 1;
    begin
      -- The profile trigger generates exactly one candidate per attempt.
      insert into public.profiles (id, display_name)
      values (new.id, requested_name);
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

  -- A circle failure is not a code collision. Keep account/profile/circle
  -- creation atomic, just as in 0013.
  insert into public.circles (owner_id) values (new.id);
  return new;
end;
$$;

-- Retain the old endpoint so installed clients receive an explicit refusal,
-- not false success or a missing-function error. No input is accepted.
create or replace function public.update_my_friend_code(new_friend_code text) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  raise exception 'Friend codes are automatically assigned and cannot be changed.';
end;
$$;

-- RPCs remain the only client write path. Revoke column grants as well as
-- table grants: PostgreSQL tracks those privileges separately. The trigger
-- also rejects changed codes inside existing SECURITY DEFINER writers.
revoke insert, update, delete on public.profiles from public, anon, authenticated;
revoke insert (friend_code), update (friend_code) on public.profiles from public, anon, authenticated;
revoke all on function public.guard_profile_friend_code() from public, anon, authenticated, service_role;
revoke all on function public.generate_friend_code() from public, anon, authenticated, service_role;
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
revoke all on function public.update_my_friend_code(text) from public, anon, authenticated, service_role;
grant execute on function public.update_my_friend_code(text) to authenticated;

-- Preserve the existing random 8-character generator and the format, NOT NULL,
-- and UNIQUE constraints. Legacy 4–16 character codes remain valid forever;
-- names, appearance, account recovery, and code-based joins are unchanged.
