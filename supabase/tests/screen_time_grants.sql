-- ROLLBACK-ONLY preflight after migration 0016. No real user requests are edited.
-- The private activation timestamp is temporarily moved back in this transaction
-- so the ten-minute boundary can be tested without sleeping. Other transactions
-- cannot see that uncommitted value; ROLLBACK restores it. Do not remove ROLLBACK.
-- To test migration DDL too, prepend its SQL AFTER BEGIN and before these tests.
begin;

do $test$
declare role_name text; table_name text; operation text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    foreach table_name in array array['screen_time_grants', 'screen_time_grant_config'] loop
      foreach operation in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
        if has_table_privilege(role_name, 'public.' || table_name, operation) then
          raise exception 'Unexpected % privilege for % on %', operation, role_name, table_name;
        end if;
      end loop;
      if not (select relrowsecurity from pg_class where oid = ('public.' || table_name)::regclass) then
        raise exception 'RLS is disabled on %', table_name;
      end if;
    end loop;
  end loop;
  if has_function_privilege('anon', 'public.claim_screen_time_grant(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.get_active_screen_time_grant()', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.claim_screen_time_grant(uuid)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.get_active_screen_time_grant()', 'EXECUTE') then
    raise exception 'Incorrect grant RPC privileges';
  end if;
  if exists (
    select 1 from pg_proc where oid in (
      'public.claim_screen_time_grant(uuid)'::regprocedure,
      'public.get_active_screen_time_grant()'::regprocedure
    ) and (not prosecdef or not ('search_path=""' = any(proconfig)))
  ) then raise exception 'Grant RPC security-definer/search-path contract changed'; end if;
end;
$test$;

select set_config('test.grants_a', gen_random_uuid()::text, true);
select set_config('test.grants_b', gen_random_uuid()::text, true);
select set_config('test.grants_stranger', gen_random_uuid()::text, true);
insert into auth.users (id, raw_user_meta_data) values
  (current_setting('test.grants_a')::uuid, '{"display_name":"Grant QA A"}'),
  (current_setting('test.grants_b')::uuid, '{"display_name":"Grant QA B"}'),
  (current_setting('test.grants_stranger')::uuid, '{"display_name":"Grant QA stranger"}');
update public.screen_time_grant_config set activated_at = clock_timestamp() - interval '13 minutes' where singleton;

with created as (
  insert into public.time_requests
    (requester_id, circle_id, minutes, status, decided_by, decided_at, reason)
  select current_setting('test.grants_a')::uuid,
    (select id from public.circles where owner_id = current_setting('test.grants_a')::uuid),
    minutes, status::public.request_status,
    case when status in ('approved','denied') then current_setting('test.grants_b')::uuid end,
    case when status in ('approved','denied') then clock_timestamp() + decision_offset end,
    label
  from (values
    ('first', 15::smallint, 'approved', interval '0 seconds'),
    ('second', 30::smallint, 'approved', interval '0 seconds'),
    ('legacy5', 5::smallint, 'approved', interval '0 seconds'),
    ('legacy10', 10::smallint, 'approved', interval '0 seconds'),
    ('denied', 15::smallint, 'denied', interval '0 seconds'),
    ('pending', 15::smallint, 'pending', interval '0 seconds'),
    ('cancelled', 15::smallint, 'cancelled', interval '0 seconds'),
    ('expired', 15::smallint, 'expired', interval '0 seconds'),
    ('preactivation', 15::smallint, 'approved', interval '-14 minutes'),
    ('late', 15::smallint, 'approved', interval '-10 minutes'),
    ('future', 15::smallint, 'approved', interval '1 minute')
  ) fixtures(label, minutes, status, decision_offset)
  returning id, reason
)
select set_config('test.grants_' || reason, id::text, true) from created;

with created as (
  insert into public.time_requests (requester_id, circle_id, minutes, status, decided_by, decided_at)
  values (current_setting('test.grants_b')::uuid,
    (select id from public.circles where owner_id = current_setting('test.grants_b')::uuid),
    15, 'approved', current_setting('test.grants_a')::uuid, clock_timestamp())
  returning id
)
select set_config('test.grants_other', id::text, true) from created;

-- The existing request schema itself forbids approved rows without a decision
-- timestamp. The RPC also rejects null explicitly as defense in depth. Do not
-- drop a live request constraint merely to inject an otherwise impossible row.
do $test$ begin
  begin
    update public.time_requests
    set status = 'approved', decided_by = current_setting('test.grants_b')::uuid, decided_at = null
    where id = current_setting('test.grants_pending')::uuid;
    raise exception 'An approved request with no decision timestamp was accepted';
  exception when check_violation then null;
  end;
end;
$test$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.grants_a'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.grants_a'))::text, true);
do $test$
declare rejected record; granted jsonb; repeated jsonb;
begin
  if public.get_active_screen_time_grant() is not null then raise exception 'A new account has a grant'; end if;
  for rejected in select * from (values
    ('denied','An approved request for your account is required'),
    ('pending','An approved request for your account is required'),
    ('cancelled','An approved request for your account is required'),
    ('expired','An approved request for your account is required'),
    ('other','An approved request for your account is required'),
    ('legacy5','Screen Time grants currently support 15 or 30 minutes'),
    ('legacy10','Screen Time grants currently support 15 or 30 minutes'),
    ('preactivation','Send a new request to use Screen Time blocking'),
    ('late','This approval is too old to start. Send a new request'),
    ('future','This approval is too old to start. Send a new request')
  ) cases(label, message) loop
    begin
      perform public.claim_screen_time_grant(current_setting('test.grants_' || rejected.label)::uuid);
      raise exception 'Invalid claim unexpectedly succeeded: %', rejected.label;
    exception when raise_exception then
      if sqlerrm <> rejected.message then raise; end if;
    end;
  end loop;
  begin
    perform public.claim_screen_time_grant(null);
    raise exception 'A null request was accepted';
  exception when raise_exception then
    if sqlerrm <> 'An approved request for your account is required' then raise; end if;
  end;
  begin
    perform public.claim_screen_time_grant(gen_random_uuid());
    raise exception 'An unknown request was accepted';
  exception when raise_exception then
    if sqlerrm <> 'An approved request for your account is required' then raise; end if;
  end;

  granted := public.claim_screen_time_grant(current_setting('test.grants_first')::uuid);
  if (select count(*) from jsonb_object_keys(granted)) <> 6
    or granted ->> 'requesterId' is distinct from current_setting('test.grants_a')
    or granted ->> 'requestId' is distinct from current_setting('test.grants_first')
    or (granted ->> 'grantId')::uuid is null
    or (granted ->> 'expiresAt')::timestamptz - (granted ->> 'startedAt')::timestamptz <> interval '15 minutes'
    or (granted ->> 'serverNow')::timestamptz < (granted ->> 'startedAt')::timestamptz then
    raise exception 'Fresh claim payload/deadline is incorrect';
  end if;
  perform set_config('test.grants_first_payload', granted::text, true);
  repeated := public.claim_screen_time_grant(current_setting('test.grants_first')::uuid);
  if (repeated - 'serverNow') is distinct from (granted - 'serverNow') then
    raise exception 'Retry restarted or replaced a grant';
  end if;
  if (public.get_active_screen_time_grant() - 'serverNow') is distinct from (granted - 'serverNow') then
    raise exception 'Status cannot recover a lost claim response';
  end if;
  begin
    perform public.claim_screen_time_grant(current_setting('test.grants_second')::uuid);
    raise exception 'Overlapping grant unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Extra time is already active. Wait for it to finish' then raise; end if;
  end;
  begin
    perform 1 from public.screen_time_grants;
    raise exception 'Authenticated user can read the grant table directly';
  exception when insufficient_privilege then null;
  end;
end;
$test$;

-- A different owner can start their own grant, but cannot view/redeem A's.
select set_config('request.jwt.claim.sub', current_setting('test.grants_b'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.grants_b'))::text, true);
do $test$
declare granted jsonb;
begin
  if public.get_active_screen_time_grant() is not null then raise exception 'B received A''s grant'; end if;
  begin
    perform public.claim_screen_time_grant(current_setting('test.grants_first')::uuid);
    raise exception 'Cross-account retry unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'An approved request for your account is required' then raise; end if;
  end;
  granted := public.claim_screen_time_grant(current_setting('test.grants_other')::uuid);
  if granted ->> 'requesterId' is distinct from current_setting('test.grants_b') then
    raise exception 'Independent account claim has the wrong owner';
  end if;
end;
$test$;

-- Simulate elapsed wall-clock time only on this dedicated fixture's row. This
-- avoids a 15-minute sleep while preserving the database duration constraint.
reset role;
with elapsed as (select clock_timestamp() - interval '16 minutes' as started)
update public.screen_time_grants
set started_at = elapsed.started, expires_at = elapsed.started + interval '15 minutes'
from elapsed where request_id = current_setting('test.grants_first')::uuid;
update public.time_requests set decided_at = clock_timestamp() - interval '16 minutes'
where id = current_setting('test.grants_first')::uuid;
select set_config('test.grants_expired_payload', jsonb_build_object(
  'grantId', id, 'requesterId', requester_id, 'requestId', request_id,
  'startedAt', started_at, 'expiresAt', expires_at
)::text, true) from public.screen_time_grants where request_id = current_setting('test.grants_first')::uuid;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.grants_a'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.grants_a'))::text, true);
do $test$
declare original jsonb; replayed jsonb; next_grant jsonb;
begin
  original := current_setting('test.grants_expired_payload')::jsonb;
  if public.get_active_screen_time_grant() is not null then raise exception 'Expired grant is active'; end if;
  replayed := public.claim_screen_time_grant(current_setting('test.grants_first')::uuid);
  if (replayed - 'serverNow') is distinct from original then raise exception 'Expired grant was restarted'; end if;
  next_grant := public.claim_screen_time_grant(current_setting('test.grants_second')::uuid);
  if next_grant ->> 'grantId' = original ->> 'grantId'
    or (next_grant ->> 'expiresAt')::timestamptz - (next_grant ->> 'startedAt')::timestamptz <> interval '30 minutes' then
    raise exception 'Next approved grant was not a separate fixed thirty-minute grant';
  end if;
  if (public.claim_screen_time_grant(current_setting('test.grants_first')::uuid) - 'serverNow') is distinct from original then
    raise exception 'An old retry changed the newer active grant';
  end if;
  if (public.get_active_screen_time_grant() - 'serverNow') is distinct from (next_grant - 'serverNow') then
    raise exception 'Status returned an older grant';
  end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.grants_stranger'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('test.grants_stranger'))::text, true);
do $test$ begin
  if public.get_active_screen_time_grant() is not null then raise exception 'A stranger saw another grant'; end if;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.claim_screen_time_grant(current_setting('test.grants_first')::uuid);
    raise exception 'Missing authentication was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Authentication required' then raise; end if;
  end;
  begin
    perform public.get_active_screen_time_grant();
    raise exception 'Missing authentication could query grant status';
  exception when raise_exception then
    if sqlerrm <> 'Authentication required' then raise; end if;
  end;
end;
$test$;

reset role;
do $test$
declare violated_constraint text;
begin
  if (select count(*) from public.screen_time_grants
    where requester_id in (current_setting('test.grants_a')::uuid, current_setting('test.grants_b')::uuid)) <> 3 then
    raise exception 'Duplicate/rejected claims created unexpected rows';
  end if;
  if (select count(*) from public.screen_time_grants
    where active_requester_id = current_setting('test.grants_a')::uuid) <> 1
    or exists (select 1 from public.screen_time_grants
      where request_id = current_setting('test.grants_first')::uuid and active_requester_id is not null) then
    raise exception 'The expired slot was not released for the new grant';
  end if;
  -- The uniqueness constraint itself is the backstop if two transactions ever
  -- have different snapshots (for example, a non-default isolation level).
  begin
    insert into public.screen_time_grants
      (request_id, requester_id, active_requester_id, minutes, started_at, expires_at)
    values (current_setting('test.grants_pending')::uuid,
      current_setting('test.grants_a')::uuid, current_setting('test.grants_a')::uuid,
      15, now(), now() + interval '15 minutes');
    raise exception 'The database allowed two occupied slots for one account';
  exception when unique_violation then
    get stacked diagnostics violated_constraint = constraint_name;
    if violated_constraint <> 'screen_time_grants_active_requester_id_key' then raise; end if;
  end;
end;
$test$;
rollback;
