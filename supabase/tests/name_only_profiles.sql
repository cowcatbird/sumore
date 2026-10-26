-- Manual regression test for an ISOLATED Supabase test database after 0013.
-- This creates temporary auth fixtures and replaces a generator transactionally.
-- Never run this against the live project. Every change is rolled back.
begin;

create temporary table name_only_profile_test_state (
  first_id uuid, second_id uuid, collision_id uuid, exhausted_id uuid,
  used_code text, fresh_code text
) on commit drop;
insert into name_only_profile_test_state (first_id, second_id, collision_id, exhausted_id)
values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid());

do $test$
declare
  fixture record;
  invalid_name text;
begin
  select * into fixture from pg_temp.name_only_profile_test_state;
  if not (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass) then
    raise exception 'Profile RLS must remain enabled';
  end if;
  if not exists (select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass and conname = 'profiles_friend_code_unique' and contype = 'u')
  then raise exception 'Friend-code uniqueness must remain enforced'; end if;
  if exists (select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass and conname = 'profiles_handle_key')
  then raise exception 'The retired handle uniqueness constraint remains'; end if;
  if has_function_privilege('anon', 'public.update_my_profile_name(text)', 'execute')
    or not has_function_privilege('authenticated', 'public.update_my_profile_name(text)', 'execute')
    or has_function_privilege('authenticated', 'public.normalize_profile_display_name(text)', 'execute')
  then raise exception 'Name RPC privileges are incorrect'; end if;

  -- An obsolete, invalid handle must not prevent a name-only signup.
  insert into auth.users (id, raw_user_meta_data) values
    (fixture.first_id, jsonb_build_object('display_name', U&'\00A0Alex\3000', 'handle', '! retired')),
    (fixture.second_id, jsonb_build_object('display_name', 'Alex'));
  if (select count(*) from public.profiles where id in (fixture.first_id, fixture.second_id)
    and display_name = 'Alex' and handle is null) <> 2
  then raise exception 'Duplicate names or handle-free signups failed'; end if;
  if (select count(distinct friend_code) from public.profiles
    where id in (fixture.first_id, fixture.second_id)) <> 2
  then raise exception 'New accounts must have distinct friend codes'; end if;
  if (select count(*) from public.circles where owner_id in (fixture.first_id, fixture.second_id)) <> 2
  then raise exception 'Both new accounts must get their own circle'; end if;

  -- Legacy values may repeat and must survive either name-update signature.
  update public.profiles set handle = 'legacy_name' where id in (fixture.first_id, fixture.second_id);
  perform set_config('request.jwt.claim.sub', fixture.first_id::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', fixture.first_id)::text, true);
  perform public.update_my_profile_name(' Zoë  O’Connor ');
  perform public.update_my_profile('李 小明', 'ignored_legacy_argument');
  if not exists (select 1 from public.profiles where id = fixture.first_id
    and display_name = '李 小明' and handle = 'legacy_name')
  then raise exception 'Legacy update did not preserve the handle'; end if;
  if not exists (select 1 from public.profiles where id = fixture.second_id
    and display_name = 'Alex' and handle = 'legacy_name')
  then raise exception 'Name update changed another person'; end if;
  if not public.is_handle_available('legacy_name') or public.is_handle_available('!') then
    raise exception 'Legacy availability RPC must be format-only';
  end if;
  perform public.update_my_profile_name(repeat('🌙', 60));
  foreach invalid_name in array array['', ' ', U&'\00A0\3000', repeat('A', 61), repeat('🌙', 61)] loop
    begin
      perform public.update_my_profile_name(invalid_name);
      raise exception 'Invalid name unexpectedly accepted';
    exception when raise_exception then
      if sqlerrm <> 'Display name must be between 1 and 60 characters' then raise; end if;
    end;
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.update_my_profile_name('No session');
    raise exception 'Unauthenticated name update unexpectedly accepted';
  exception when raise_exception then
    if sqlerrm <> 'Authentication required' then raise; end if;
  end;

  update pg_temp.name_only_profile_test_state
  set used_code = (select friend_code from public.profiles where id = fixture.first_id),
      fresh_code = public.generate_friend_code();
end;
$test$;

-- Force one genuine profiles_friend_code_unique conflict, then a free code.
create temporary sequence name_only_profile_collision_attempts;
create or replace function public.generate_friend_code() returns text
language plpgsql security definer set search_path = ''
as $generator$
begin
  if nextval('pg_temp.name_only_profile_collision_attempts') = 1 then
    return (select used_code from pg_temp.name_only_profile_test_state);
  end if;
  return (select fresh_code from pg_temp.name_only_profile_test_state);
end;
$generator$;

do $test$
declare
  fixture record;
  conflict_name text;
begin
  select * into fixture from pg_temp.name_only_profile_test_state;
  insert into auth.users (id, raw_user_meta_data)
  values (fixture.collision_id, jsonb_build_object('display_name', 'Alex'));
  if (select last_value from pg_temp.name_only_profile_collision_attempts) <> 2 then
    raise exception 'A friend-code collision must retry just once when the next code is free';
  end if;
  if not exists (select 1 from public.profiles where id = fixture.collision_id and friend_code = fixture.fresh_code)
    or not exists (select 1 from public.circles where owner_id = fixture.collision_id)
  then raise exception 'Collision retry did not finish the account and circle'; end if;

  -- The generator now always returns the used fresh_code. Five retries must
  -- rethrow the real constraint failure and roll back the entire new account.
  begin
    insert into auth.users (id, raw_user_meta_data)
    values (fixture.exhausted_id, jsonb_build_object('display_name', 'Alex'));
    raise exception 'Repeated collision unexpectedly succeeded';
  exception when unique_violation then
    get stacked diagnostics conflict_name = constraint_name;
    if conflict_name <> 'profiles_friend_code_unique' then raise; end if;
  end;
  if (select last_value from pg_temp.name_only_profile_collision_attempts) <> 7
    or exists (select 1 from auth.users where id = fixture.exhausted_id)
    or exists (select 1 from public.profiles where id = fixture.exhausted_id)
    or exists (select 1 from public.circles where owner_id = fixture.exhausted_id)
  then raise exception 'Exhausted collision retries must be bounded and atomic'; end if;
end;
$test$;

rollback;
