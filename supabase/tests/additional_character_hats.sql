-- Disposable/isolated database only. These profiles and all changes roll back.
begin;
select set_config('test.hats_a', gen_random_uuid()::text, true);
select set_config('test.hats_b', gen_random_uuid()::text, true);
select set_config('test.hats_stranger', gen_random_uuid()::text, true);
insert into auth.users (id, raw_user_meta_data) values
  (current_setting('test.hats_a')::uuid, '{"display_name":"Hat QA A"}'),
  (current_setting('test.hats_b')::uuid, '{"display_name":"Hat QA B"}'),
  (current_setting('test.hats_stranger')::uuid, '{"display_name":"Hat QA stranger"}');
select set_config('test.hats_a_code', friend_code, true) from public.profiles where id = current_setting('test.hats_a')::uuid;

do $test$
begin
  if has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
    or has_function_privilege('anon', 'public.update_my_character(uuid,text,text,integer,text)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.update_my_character(uuid,text,text,integer,text)', 'EXECUTE')
    or not (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass)
  then raise exception 'Hat migration widened profile permissions'; end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'update_my_character') <> 1
    or not (select prosecdef and pronargdefaults = 1 from pg_proc
      where oid = 'public.update_my_character(uuid,text,text,integer,text)'::regprocedure)
  then raise exception 'Hat RPC overload/default compatibility changed'; end if;
end;
$test$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.hats_a'), true);
select set_config('test.hats_group', public.get_circle_shop('UTC') ->> 'id', true);
select set_config('request.jwt.claim.sub', current_setting('test.hats_b'), true);
select public.join_shared_circle(current_setting('test.hats_a_code'));
select set_config('request.jwt.claim.sub', current_setting('test.hats_a'), true);

do $test$
declare hat text; revision integer := 0; saved jsonb; snapshot jsonb; friend jsonb; seat jsonb; shop jsonb; body text;
begin
  foreach hat in array array['beanie','bucket','headband','propeller','wizard','pirate','clown','viking'] loop
    body := case when revision % 2 = 0 then 'short' else 'tall' end;
    -- Exercise the old four-argument signature for every free new hat.
    saved := public.update_my_character(auth.uid(), hat, body, revision);
    revision := revision + 1;
    if saved #>> '{appearance,hat}' is distinct from hat or saved #>> '{appearance,body}' is distinct from body
      or saved #>> '{appearance,color}' is distinct from 'cream'
      or (saved ->> 'revision')::integer is distinct from revision then raise exception 'New hat save failed: %', hat; end if;
    snapshot := public.get_app_snapshot();
    if snapshot #> '{profile,character}' is distinct from saved then raise exception 'Own snapshot lost hat: %', hat; end if;
    shop := public.get_circle_shop();
    if shop ->> 'balance' is distinct from '99' or shop -> 'unlocked' is distinct from '[]'::jsonb
      then raise exception 'Free hat modified the shared wallet: %', hat; end if;
    begin
      perform public.purchase_circle_item(current_setting('test.hats_group')::uuid, 'hat:' || hat);
      raise exception 'Free hat unexpectedly became a paid shop item';
    exception when raise_exception then
      if sqlerrm <> 'Choose an available shop item' then raise; end if;
    end;
    perform set_config('request.jwt.claim.sub', current_setting('test.hats_b'), true);
    snapshot := public.get_app_snapshot();
    select value into friend from jsonb_array_elements(snapshot -> 'friends') where value ->> 'id' = current_setting('test.hats_a');
    select value into seat from jsonb_array_elements(snapshot #> '{campfire,seats}') where value ->> 'id' = current_setting('test.hats_a');
    if friend -> 'character' is distinct from saved or seat -> 'character' is distinct from saved
      then raise exception 'Peer snapshot lost hat/revision: %', hat; end if;
    perform set_config('request.jwt.claim.sub', current_setting('test.hats_a'), true);
  end loop;
  perform set_config('test.hats_revision', revision::text, true);
end;
$test$;

do $test$
declare invalid record; revision integer := current_setting('test.hats_revision')::integer; saved jsonb; shop jsonb;
begin
  begin
    perform public.update_my_character(current_setting('test.hats_b')::uuid, 'beanie', 'short', 0);
    raise exception 'New hat overwrote another account';
  exception when raise_exception then if sqlerrm <> 'This camper belongs to a different account' then raise; end if; end;
  begin
    perform public.update_my_character(auth.uid(), 'wizard', 'short', revision - 1);
    raise exception 'Stale hat revision unexpectedly succeeded';
  exception when serialization_failure then null; end;
  for invalid in select * from (values
    ('unsupported'::text, 'short'::text, revision, 'cream'::text),
    (null::text, 'short'::text, revision, 'cream'::text),
    ('beanie'::text, 'giant'::text, revision, 'cream'::text),
    ('bucket'::text, null::text, revision, 'cream'::text),
    ('headband'::text, 'short'::text, -1, 'cream'::text),
    ('propeller'::text, 'short'::text, null::integer, 'cream'::text),
    ('clown'::text, 'short'::text, revision, 'cyan'::text)
  ) bad(hat, body, expected, color) loop
    begin
      perform public.update_my_character(auth.uid(), invalid.hat, invalid.body, invalid.expected, invalid.color);
      raise exception 'Invalid character input unexpectedly succeeded';
    exception when raise_exception then if sqlerrm <> 'Choose a supported hat, body and color' then raise; end if; end;
  end loop;
  begin
    perform public.update_my_character(auth.uid(), 'crown', 'short', revision);
    raise exception 'Unpaid crown equipped after hat expansion';
  exception when raise_exception then if sqlerrm <> 'Unlock the crown in your circle’s shop first' then raise; end if; end;
  begin
    perform public.update_my_character(auth.uid(), 'viking', 'short', revision, 'blue');
    raise exception 'Free hat bypassed paid body color';
  exception when raise_exception then if sqlerrm <> 'Unlock this color in your circle’s shop first' then raise; end if; end;

  shop := public.purchase_circle_item(current_setting('test.hats_group')::uuid, 'color:blue');
  if shop ->> 'balance' is distinct from '98' then raise exception 'Paid color price changed'; end if;
  saved := public.update_my_character(auth.uid(), 'wizard', 'short', revision, 'blue');
  revision := revision + 1;
  saved := public.update_my_character(auth.uid(), 'pirate', 'tall', revision);
  revision := revision + 1;
  if saved #>> '{appearance,color}' is distinct from 'blue' or (saved ->> 'revision')::integer is distinct from revision
    then raise exception 'Legacy save reset color or changed revision behavior'; end if;
  shop := public.purchase_circle_item(current_setting('test.hats_group')::uuid, 'hat:crown');
  if shop ->> 'balance' is distinct from '97' then raise exception 'Crown no longer costs one'; end if;
  saved := public.update_my_character(auth.uid(), 'crown', 'short', revision);
  revision := revision + 1;
  if saved #>> '{appearance,hat}' is distinct from 'crown' or saved #>> '{appearance,color}' is distinct from 'blue'
    then raise exception 'Previously supported crown/color combination failed'; end if;
  saved := public.update_my_character(auth.uid(), 'viking', 'tall', revision);
  perform set_config('test.hats_revision', saved ->> 'revision', true);
  perform public.create_time_request(15::smallint, 'Hat sync QA', 'Social apps');
end;
$test$;

-- Pending request cards must carry the same new hat/color as the camp roster.
select set_config('request.jwt.claim.sub', current_setting('test.hats_b'), true);
do $test$
declare snapshot jsonb;
begin
  snapshot := public.get_app_snapshot();
  if snapshot #>> '{incomingRequests,0,friend,character,appearance,hat}' is distinct from 'viking'
    or snapshot #>> '{incomingRequests,0,friend,character,appearance,color}' is distinct from 'blue'
    or snapshot #>> '{incomingRequests,0,friend,character,revision}' is distinct from current_setting('test.hats_revision')
  then raise exception 'Incoming request lost shared hat/color/revision'; end if;
  if (select character_revision from public.profiles where id = auth.uid()) is distinct from 0
    then raise exception 'Cross-account save changed the peer'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.hats_stranger'), true);
do $test$
declare snapshot jsonb;
begin
  snapshot := public.get_app_snapshot();
  if jsonb_array_length(snapshot -> 'friends') is distinct from 0 or jsonb_array_length(snapshot #> '{campfire,seats}') is distinct from 1
    or exists (select 1 from public.profiles where id = current_setting('test.hats_a')::uuid)
  then raise exception 'New hats widened circle visibility'; end if;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.update_my_character(current_setting('test.hats_a')::uuid, 'beanie', 'short', 0);
    raise exception 'Unauthenticated new-hat save unexpectedly succeeded';
  exception when raise_exception then if sqlerrm <> 'Authentication required' then raise; end if; end;
end;
$test$;

reset role;
-- Even privileged writes must retain a valid hat/body pair in stored data.
do $test$
begin
  begin
    update public.profiles set character_hat = 'unknown-hat' where id = current_setting('test.hats_a')::uuid;
    raise exception 'Hat shape constraint accepted an unknown ID';
  exception when check_violation then null; end;
  begin
    update public.profiles set character_body = null where id = current_setting('test.hats_a')::uuid;
    raise exception 'Hat shape constraint accepted a half-empty appearance';
  exception when check_violation then null; end;
end;
$test$;
rollback;
