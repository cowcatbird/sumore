-- Rollback-only preflight after migration 0015. Uses only dedicated ephemeral
-- profiles/circles; never run the collision-injection test against production.
-- To test the migration itself, run its SQL in this transaction before these
-- fixtures and leave the final ROLLBACK in place. Nothing is committed.
begin;

-- get_app_snapshot's existing implementation expires overdue requests. Refuse
-- this preflight if that would touch an unrelated live row in this transaction.
do $$ begin
  if exists (select 1 from public.time_requests where status = 'pending' and expires_at <= now()) then
    raise exception 'Preflight paused: existing overdue requests would be touched by the snapshot. Run in an isolated database instead.';
  end if;
  if has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
    or has_function_privilege('anon', 'public.update_my_character(uuid,text,text,integer)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.update_my_character(uuid,text,text,integer)', 'EXECUTE')
  then raise exception 'Character write permissions are incorrect'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass)
    or has_function_privilege('authenticated', 'public.campfire_days(uuid,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.campfire_asked_days(uuid,text)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.campfire_standing(uuid,text)', 'EXECUTE')
  then raise exception 'Profile RLS or private history-helper permissions changed'; end if;
end $$;

select set_config('test.character_a', gen_random_uuid()::text, true);
select set_config('test.character_b', gen_random_uuid()::text, true);
select set_config('test.character_stranger', gen_random_uuid()::text, true);
insert into auth.users (id, raw_user_meta_data) values
  (current_setting('test.character_a')::uuid, jsonb_build_object('display_name', 'Character QA A')),
  (current_setting('test.character_b')::uuid, jsonb_build_object('display_name', 'Character QA B')),
  (current_setting('test.character_stranger')::uuid, jsonb_build_object('display_name', 'Character QA stranger'));
select set_config('test.character_a_code', friend_code, true) from public.profiles where id = current_setting('test.character_a')::uuid;
select set_config('test.character_b_code', friend_code, true) from public.profiles where id = current_setting('test.character_b')::uuid;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.character_a'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.character_a'))::text, true);
do $test$
declare saved jsonb; snapshot jsonb; bad record;
begin
  snapshot := public.get_app_snapshot();
  if snapshot #> '{profile,character,appearance}' is distinct from 'null'::jsonb
    or snapshot #>> '{profile,character,revision}' is distinct from '0'
  then raise exception 'A current name-only profile must have an unset shared look'; end if;
  saved := public.update_my_character(auth.uid(), 'cat', 'tall', 0);
  if saved #>> '{appearance,hat}' is distinct from 'cat' or saved #>> '{appearance,body}' is distinct from 'tall' or saved ->> 'revision' is distinct from '1'
  then raise exception 'Initial own-character save failed'; end if;
  begin
    perform public.update_my_character(current_setting('test.character_b')::uuid, 'cow', 'short', 0);
    raise exception 'Wrong-account save unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'This camper belongs to a different account' then raise; end if;
  end;
  begin
    perform public.update_my_character(auth.uid(), 'cow', 'short', 0);
    raise exception 'Stale revision unexpectedly succeeded';
  exception when serialization_failure then null;
  end;
  begin
    perform public.update_my_character(auth.uid(), 'unsupported', 'short', 1);
    raise exception 'Unsupported hat unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Choose a supported hat and body' then raise; end if;
  end;
  for bad in select * from (values
    ('cat'::text, 'giant'::text, 1::integer),
    (null::text, 'short'::text, 1::integer),
    ('cat'::text, null::text, 1::integer),
    ('cat'::text, 'short'::text, null::integer),
    ('cat'::text, 'short'::text, -1::integer)
  ) invalid(hat, body, revision) loop
    begin
      perform public.update_my_character(auth.uid(), bad.hat, bad.body, bad.revision);
      raise exception 'Invalid cosmetic input unexpectedly succeeded';
    exception when raise_exception then
      if sqlerrm <> 'Choose a supported hat and body' then raise; end if;
    end;
  end loop;
  saved := public.update_my_character(auth.uid(), 'crown', 'short', 1);
  if saved ->> 'revision' is distinct from '2' then raise exception 'Second own save did not increment the revision'; end if;
  perform public.add_friend_by_code(current_setting('test.character_b_code'));
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.character_b'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.character_b'))::text, true);
do $test$
declare snapshot jsonb; friend jsonb; seat jsonb;
begin
  snapshot := public.get_app_snapshot('UTC');
  if snapshot #> '{profile,character,appearance}' is distinct from 'null'::jsonb
    or snapshot #>> '{profile,character,revision}' is distinct from '0'
  then raise exception 'Rejected cross-account write changed another camper'; end if;
  select value into friend from jsonb_array_elements(snapshot -> 'friends') where value ->> 'id' = current_setting('test.character_a');
  select value into seat from jsonb_array_elements(snapshot #> '{campfire,seats}') where value ->> 'id' = current_setting('test.character_a');
  if friend #>> '{character,appearance,hat}' is distinct from 'crown'
    or seat #>> '{character,appearance,body}' is distinct from 'short'
    or seat #>> '{character,revision}' is distinct from '2'
  then raise exception 'Active circle member cannot see the saved character in friends and campsite'; end if;
  if not exists (select 1 from public.profiles where id = current_setting('test.character_a')::uuid and character_hat = 'crown')
  then raise exception 'Existing peer profile RLS visibility was lost'; end if;
  if snapshot #>> '{profile,friendCode}' is distinct from current_setting('test.character_b_code')
    or friend ->> 'friendCode' is distinct from current_setting('test.character_a_code')
  then raise exception 'Cosmetics changed a friend code'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.character_stranger'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.character_stranger'))::text, true);
do $test$
declare snapshot jsonb;
begin
  if exists (select 1 from public.profiles where id in (current_setting('test.character_a')::uuid, current_setting('test.character_b')::uuid))
  then raise exception 'A stranger can read private circle profiles'; end if;
  snapshot := public.get_app_snapshot('UTC');
  if jsonb_array_length(snapshot -> 'friends') <> 0 or jsonb_array_length(snapshot #> '{campfire,seats}') <> 1
  then raise exception 'A stranger received other circle members in the snapshot'; end if;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.update_my_character(current_setting('test.character_a')::uuid, 'cow', 'short', 2);
    raise exception 'Unauthenticated character save unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Authentication required' then raise; end if;
  end;
end;
$test$;

reset role;
rollback;
