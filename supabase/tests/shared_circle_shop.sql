-- Disposable/isolated database only. Everything, including time fixtures, rolls back.
begin;
select set_config('test.camp_a', gen_random_uuid()::text, true);
select set_config('test.camp_b', gen_random_uuid()::text, true);
select set_config('test.camp_c', gen_random_uuid()::text, true);
insert into auth.users (id, raw_user_meta_data) values
  (current_setting('test.camp_a')::uuid, '{"display_name":"Camp A"}'),
  (current_setting('test.camp_b')::uuid, '{"display_name":"Camp B"}'),
  (current_setting('test.camp_c')::uuid, '{"display_name":"Camp C"}');
select set_config('test.camp_a_code', friend_code, true) from public.profiles where id = current_setting('test.camp_a')::uuid;
select set_config('test.camp_b_code', friend_code, true) from public.profiles where id = current_setting('test.camp_b')::uuid;
select set_config('test.camp_c_code', friend_code, true) from public.profiles where id = current_setting('test.camp_c')::uuid;

do $test$
declare function_name text; table_name text;
begin
  foreach table_name in array array['camp_groups','camp_group_members','camp_group_unlocks','camp_group_days'] loop
    if has_table_privilege('authenticated', 'public.' || table_name, 'INSERT, UPDATE, DELETE')
      or has_table_privilege('anon', 'public.' || table_name, 'SELECT, INSERT, UPDATE, DELETE')
      or not (select relrowsecurity from pg_class where oid = ('public.' || table_name)::regclass)
      then raise exception 'Wallet table exposure: %', table_name; end if;
  end loop;
  foreach function_name in array array[
    'camp_now()','camp_settle(uuid,timestamptz)','camp_ensure_group(uuid,text)','camp_shop_payload(uuid)',
    'camp_reconcile_character(uuid,uuid)','camp_legacy_snapshot(text)',
    'camp_accept_request()','camp_request_day()','camp_roster_day()','camp_check_character_unlock()', 'camp_character(public.profiles)'
  ] loop
    if has_function_privilege('authenticated', 'public.' || function_name, 'EXECUTE')
      or has_function_privilege('anon', 'public.' || function_name, 'EXECUTE')
      then raise exception 'Private helper exposed: %', function_name; end if;
  end loop;
  foreach function_name in array array[
    'get_circle_shop(text)','purchase_circle_item(uuid,text)','set_circle_background(uuid,text)',
    'join_shared_circle(text)','get_app_snapshot(text)','update_my_character(uuid,text,text,integer,text)'
  ] loop
    if not has_function_privilege('authenticated', 'public.' || function_name, 'EXECUTE')
      or has_function_privilege('anon', 'public.' || function_name, 'EXECUTE')
      then raise exception 'Shop RPC permission error: %', function_name; end if;
  end loop;
  if has_table_privilege('authenticated','public.profiles','UPDATE') then raise exception 'Direct paid profile write exposed'; end if;
end;
$test$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.camp_a'), true);
do $test$
declare shop jsonb; again jsonb;
begin
  shop := public.get_circle_shop('America/Los_Angeles');
  perform set_config('test.camp_a_group', shop ->> 'id', true);
  if shop ->> 'balance' <> '99' or shop ->> 'eligibleToday' <> 'false'
    or shop ->> 'askedToday' <> 'false' or shop ->> 'timeZone' <> 'America/Los_Angeles'
    or shop -> 'unlocked' <> '[]'::jsonb then raise exception 'Initial group/99/partial-day contract failed'; end if;
  again := public.get_circle_shop('Asia/Tokyo');
  if again <> shop then raise exception 'Retry/reset/timezone change modified group'; end if;
  perform public.add_friend_by_code(current_setting('test.camp_b_code'));
  -- Legacy friend graphs must not become shared camps implicitly.
  if jsonb_array_length(public.get_app_snapshot() -> 'friends') <> 0 then raise exception 'Implicit friend group merge'; end if;
  begin
    perform public.purchase_circle_item(gen_random_uuid(), 'hat:crown');
    raise exception 'Wrong group unexpectedly purchased';
  exception when raise_exception then if sqlerrm <> 'Your circle changed. Refresh and try again' then raise; end if; end;
  begin
    perform public.update_my_character(auth.uid(), 'crown', 'short', 0);
    raise exception 'Unpaid crown unexpectedly equipped';
  exception when raise_exception then if sqlerrm <> 'Unlock the crown in your circle’s shop first' then raise; end if; end;
  begin
    perform public.update_my_character(auth.uid(), 'none', 'short', 0, 'blue');
    raise exception 'Unpaid color unexpectedly equipped';
  exception when raise_exception then if sqlerrm <> 'Unlock this color in your circle’s shop first' then raise; end if; end;
  begin
    perform public.set_circle_background((shop ->> 'id')::uuid, 'beach');
    raise exception 'Unpaid beach unexpectedly selected';
  exception when raise_exception then if sqlerrm <> 'Unlock the beach in your circle’s shop first' then raise; end if; end;
  shop := public.purchase_circle_item((shop ->> 'id')::uuid, 'hat:crown');
  if shop ->> 'balance' <> '98' then raise exception 'Crown price is wrong'; end if;
  again := public.purchase_circle_item((shop ->> 'id')::uuid, 'hat:crown');
  if again <> shop then raise exception 'Duplicate purchase charged twice'; end if;
  shop := public.purchase_circle_item((shop ->> 'id')::uuid, 'color:blue');
  shop := public.purchase_circle_item((shop ->> 'id')::uuid, 'background:beach');
  if shop ->> 'balance' <> '67' then raise exception 'Color/beach prices are wrong'; end if;
  shop := public.set_circle_background((shop ->> 'id')::uuid, 'beach');
  if shop ->> 'background' <> 'beach' then raise exception 'Shared background not selected'; end if;
  perform public.update_my_character(auth.uid(), 'crown', 'tall', 0, 'blue');
  -- Old binary's four-argument save preserves color instead of resetting it.
  if public.update_my_character(auth.uid(), 'cat', 'short', 1) #>> '{appearance,color}' <> 'blue'
    then raise exception 'Legacy save erased paid color'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.camp_b'), true);
do $test$
declare solo jsonb; joined jsonb; snapshot jsonb; request_id uuid;
begin
  solo := public.get_circle_shop('Pacific/Auckland');
  perform set_config('test.camp_b_solo', solo ->> 'id', true);
  if solo ->> 'balance' <> '99' then raise exception 'B solo seed missing'; end if;
  joined := public.join_shared_circle(current_setting('test.camp_a_code'));
  if joined ->> 'id' <> current_setting('test.camp_a_group') or joined ->> 'balance' <> '67'
    or joined ->> 'background' <> 'beach' or jsonb_array_length(joined -> 'unlocked') <> 3
    then raise exception 'Join did not share exact wallet/background/unlocks'; end if;
  if public.join_shared_circle(current_setting('test.camp_a_code')) <> joined then raise exception 'Joining twice modified wallet'; end if;
  snapshot := public.get_app_snapshot('UTC');
  if jsonb_array_length(snapshot -> 'friends') <> 1 or jsonb_array_length(snapshot #> '{campfire,seats}') <> 2
    or snapshot #>> '{circleShop,balance}' <> '67' or snapshot #>> '{campfire,groupGolden}' <> '67'
    or snapshot #>> '{friends,0,character,appearance,color}' <> 'blue'
    then raise exception 'Shared snapshot roster/appearance/wallet mismatch'; end if;
  perform public.update_my_character(auth.uid(), 'crown', 'short', 0, 'blue');
  request_id := public.create_time_request(15::smallint, 'test', 'Social apps');
  perform set_config('test.camp_request', request_id::text, true);
  if public.get_circle_shop() ->> 'askedToday' <> 'true' then raise exception 'Member request did not burn group day'; end if;
  perform public.cancel_time_request(request_id);
  if public.get_circle_shop() ->> 'askedToday' <> 'true' then raise exception 'Cancelled request restored reward'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.camp_a'), true);
do $test$
begin
  if public.get_circle_shop() ->> 'askedToday' <> 'true' then raise exception 'Peers disagree about burnt day'; end if;
  if not exists (select 1 from public.request_recipients where request_id = current_setting('test.camp_request')::uuid
    and recipient_id = auth.uid()) then raise exception 'Shared member was not request recipient'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.camp_c'), true);
do $test$
declare snapshot jsonb; shop jsonb;
begin
  shop := public.get_circle_shop('invalid/timezone');
  perform set_config('test.camp_c_group', shop ->> 'id', true);
  if shop ->> 'timeZone' <> 'UTC' then raise exception 'Invalid timezone fallback failed'; end if;
  if exists (select 1 from public.camp_groups where id = current_setting('test.camp_a_group')::uuid)
    or exists (select 1 from public.camp_group_members where user_id = current_setting('test.camp_a')::uuid)
    or exists (select 1 from public.camp_group_unlocks where group_id = current_setting('test.camp_a_group')::uuid)
    then raise exception 'Stranger can inspect shared wallet/roster/unlocks'; end if;
  snapshot := public.get_app_snapshot();
  if jsonb_array_length(snapshot -> 'friends') <> 0 or jsonb_array_length(snapshot #> '{campfire,seats}') <> 1
    then raise exception 'Stranger received camp roster'; end if;
  begin
    perform public.purchase_circle_item(current_setting('test.camp_a_group')::uuid, 'color:pink');
    raise exception 'Stranger could spend another wallet';
  exception when raise_exception then if sqlerrm <> 'Your circle changed. Refresh and try again' then raise; end if; end;
end;
$test$;

-- New group has none of B's previous group's items, and move carries no money.
select set_config('request.jwt.claim.sub', current_setting('test.camp_b'), true);
do $test$
declare shop jsonb; snapshot jsonb;
begin
  shop := public.join_shared_circle(current_setting('test.camp_c_code'));
  if shop ->> 'balance' <> '99' or shop -> 'unlocked' <> '[]'::jsonb then raise exception 'Moving transferred or reset money/items'; end if;
  snapshot := public.get_app_snapshot();
  if snapshot #>> '{profile,character,appearance,hat}' <> 'none'
    or snapshot #>> '{profile,character,appearance,color}' <> 'cream'
    or snapshot #>> '{profile,character,revision}' <> '2' then raise exception 'Unowned cosmetics carried to destination'; end if;
  begin
    perform public.purchase_circle_item(current_setting('test.camp_a_group')::uuid, 'color:pink');
    raise exception 'Stale group action spent previous camp funds';
  exception when raise_exception then if sqlerrm <> 'Your circle changed. Refresh and try again' then raise; end if; end;
end;
$test$;

reset role;
do $test$
declare g uuid := current_setting('test.camp_a_group')::uuid; today date; shop jsonb; before integer; d integer;
begin
  select (clock_timestamp() at time zone time_zone)::date, balance into today, before from public.camp_groups where id = g;
  -- Seven completed days: 2 burnt, 1 roster-partial, 4 clean. Every clean day
  -- earns ONE for the group, not one for each member. Fixture data is private.
  update public.camp_groups set last_settled_day = today - 8 where id = g;
  insert into public.camp_group_days (group_id, day, requested, roster_changed) values
    (g, today - 7, true, false), (g, today - 6, true, false), (g, today - 5, false, true);
  perform public.camp_settle(g);
  if (select balance from public.camp_groups where id = g) <> before + 4 then raise exception 'Whole-day reward calculation failed'; end if;
  perform public.camp_settle(g);
  if (select balance from public.camp_groups where id = g) <> before + 4 then raise exception 'Settlement replay minted extra money'; end if;
  if (select count(*) from public.camp_group_days where group_id = g and day < today and earned) <> 4
    then raise exception 'One-row-per-earned-day ledger mismatch'; end if;
  -- Empty abandoned solo group's offline interval earns zero.
  update public.camp_groups set last_settled_day = today - 100 where id = current_setting('test.camp_b_solo')::uuid;
  perform public.camp_settle(current_setting('test.camp_b_solo')::uuid);
  if (select balance from public.camp_groups where id = current_setting('test.camp_b_solo')::uuid) <> 99
    then raise exception 'Empty camp earned offline rewards'; end if;
  -- Deleting the cancelled request or its account cannot erase the durable mark.
  delete from public.time_requests where id = current_setting('test.camp_request')::uuid;
  if not (select requested from public.camp_group_days where group_id = g and day = today)
    then raise exception 'Request deletion erased burnt history'; end if;
  delete from auth.users where id = current_setting('test.camp_a')::uuid;
  if not (select requested from public.camp_group_days where group_id = g and day = today)
    or (select balance from public.camp_groups where id = g) <> before + 4
    then raise exception 'Account deletion erased burnt history or wallet'; end if;
  -- Exactly one current membership and one item per group are DB constraints.
  begin
    insert into public.camp_group_members(user_id,group_id) values (current_setting('test.camp_b')::uuid, g);
    raise exception 'Duplicate active group accepted';
  exception when unique_violation then null; end;
end;
$test$;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.camp_c'), true);
do $test$
declare g uuid := current_setting('test.camp_c_group')::uuid; snapshot jsonb;
begin
  -- Fixed group timezone determines day boundaries for all members/devices.
  snapshot := public.get_circle_shop('Pacific/Honolulu');
  if snapshot ->> 'timeZone' <> 'UTC' or (snapshot ->> 'dayStartedAt')::timestamptz
    <> (snapshot ->> 'localDate')::date::timestamp at time zone 'UTC'
    or (snapshot ->> 'nextAwardAt')::timestamptz
    <> ((snapshot ->> 'localDate')::date + 2)::timestamp at time zone 'UTC'
    then raise exception 'Shared day boundary/partial day countdown incorrect'; end if;
  begin
    update public.camp_groups set balance = 999999 where id = g;
    raise exception 'Direct wallet mutation accepted';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.camp_group_unlocks(group_id,item_id,cost) values (g,'color:pink',1);
    raise exception 'Direct free unlock accepted';
  exception when insufficient_privilege then null; end;
  begin
    update public.profiles set character_color = 'pink' where id = auth.uid();
    raise exception 'Direct paid appearance mutation accepted';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.get_circle_shop();
    raise exception 'No-session shop call accepted';
  exception when raise_exception then if sqlerrm <> 'Authentication required' then raise; end if; end;
end;
$test$;
reset role;
-- Even an accidental future column grant cannot bypass paid-item ownership.
grant update(character_hat, character_color) on public.profiles to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.camp_c'), true);
do $test$
begin
  begin
    update public.profiles set character_color = 'pink' where id = auth.uid();
    raise exception 'Profile RLS bypass equipped unpaid color';
  exception when raise_exception then if sqlerrm <> 'Unlock this color in your circle’s shop first' then raise; end if; end;
  begin
    update public.profiles set character_hat = 'crown' where id = auth.uid();
    raise exception 'Profile RLS bypass equipped unpaid crown';
  exception when raise_exception then if sqlerrm <> 'Unlock the crown in your circle’s shop first' then raise; end if; end;
end;
$test$;
reset role;
revoke update(character_hat, character_color) on public.profiles from authenticated;

-- An old/trusted writer's already-denied/expired request must still burn the
-- day. This does not rely on the new create_time_request RPC being used.
do $test$
declare g uuid := current_setting('test.camp_c_group')::uuid; today date; circle_key uuid;
begin
  select (clock_timestamp() at time zone time_zone)::date into today from public.camp_groups where id = g;
  select id into circle_key from public.circles where owner_id = current_setting('test.camp_c')::uuid;
  insert into public.time_requests(requester_id,circle_id,minutes,status,decided_by,decided_at)
    values (current_setting('test.camp_c')::uuid, circle_key,15,'denied',current_setting('test.camp_b')::uuid,clock_timestamp());
  if not (select requested from public.camp_group_days where group_id = g and day = today)
    then raise exception 'Denied legacy request did not burn day'; end if;
  insert into public.time_requests(requester_id,circle_id,minutes,status)
    values (current_setting('test.camp_c')::uuid, circle_key,15,'expired');
  if not (select requested from public.camp_group_days where group_id = g and day = today)
    then raise exception 'Expired legacy request did not burn day'; end if;
  -- Time-zone conversion uses local midnights, not a fixed 24-hour duration.
  if ('2026-03-09'::date::timestamp at time zone 'America/Los_Angeles')
    - ('2026-03-08'::date::timestamp at time zone 'America/Los_Angeles') <> interval '23 hours'
    or ('2026-11-02'::date::timestamp at time zone 'America/Los_Angeles')
    - ('2026-11-01'::date::timestamp at time zone 'America/Los_Angeles') <> interval '25 hours'
    then raise exception 'DST local-midnight assumptions are incorrect'; end if;
end;
$test$;

-- Insufficient funds cannot create an entitlement or a partial deduction.
update public.camp_groups set balance = 0 where id = current_setting('test.camp_c_group')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.camp_c'), true);
do $test$
declare before jsonb; after jsonb;
begin
  before := public.get_circle_shop();
  begin
    perform public.purchase_circle_item((before ->> 'id')::uuid, 'color:pink');
    raise exception 'Insufficient funds purchase unexpectedly succeeded';
  exception when raise_exception then if sqlerrm <> 'Your circle needs more s’mores' then raise; end if; end;
  after := public.get_circle_shop();
  if after <> before then raise exception 'Failed purchase partly changed wallet/unlocks'; end if;
  begin
    perform public.purchase_circle_item((before ->> 'id')::uuid, 'free:anything');
    raise exception 'Unknown item unexpectedly accepted';
  exception when raise_exception then if sqlerrm <> 'Choose an available shop item' then raise; end if; end;
end;
$test$;
reset role;
-- Deterministic midnight race: after the real BEFORE trigger fixes acceptance
-- time, advance the test clock before the real AFTER trigger marks the day.
-- The request must burn its accepted day and prevent that completed day's award.
do $test$
declare group_key uuid := current_setting('test.camp_c_group')::uuid; today date;
begin
  select (clock_timestamp() at time zone time_zone)::date into today from public.camp_groups where id = group_key;
  if (select count(*) from public.camp_group_members where group_id = group_key) <> 2
    then raise exception 'Two-member reward fixture is incorrect'; end if;
  update public.camp_groups set last_settled_day = today - 3 where id = group_key;
  perform public.camp_settle(group_key);
  if (select balance from public.camp_groups where id = group_key) <> 2
    then raise exception 'Two clean group days must give 2, not 2 per member'; end if;
end;
$test$;

-- A brand-new solo camp has no pre-registration rewards. Its first partial
-- day earns zero, then its first whole completed day earns exactly one.
select set_config('test.camp_new', gen_random_uuid()::text, true);
insert into auth.users(id,raw_user_meta_data) values
  (current_setting('test.camp_new')::uuid, '{"display_name":"New camp"}');
-- Simulate an existing free crown saved before 0017 installed its guard.
alter table public.profiles disable trigger profiles_paid_character_guard;
update public.profiles set character_hat = 'crown', character_body = 'short', character_revision = 4
  where id = current_setting('test.camp_new')::uuid;
alter table public.profiles enable trigger profiles_paid_character_guard;
do $test$
declare group_key uuid; today date;
begin
  group_key := public.camp_ensure_group(current_setting('test.camp_new')::uuid, 'UTC');
  if not exists (select 1 from public.profiles where id = current_setting('test.camp_new')::uuid
    and character_hat = 'none' and character_revision = 5)
    then raise exception 'Legacy free crown was not reconciled on first group setup'; end if;
  today := (clock_timestamp() at time zone 'UTC')::date;
  perform public.camp_settle(group_key, (today + 1)::timestamp at time zone 'UTC');
  if (select balance from public.camp_groups where id = group_key) <> 99 then raise exception 'Partial first day earned money'; end if;
  perform public.camp_settle(group_key, (today + 2)::timestamp at time zone 'UTC');
  if (select balance from public.camp_groups where id = group_key) <> 100 then raise exception 'First completed full day did not earn exactly one'; end if;
end;
$test$;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.camp_new'), true);
select public.delete_my_account();
reset role;
do $test$
begin
  if exists (select 1 from auth.users where id = current_setting('test.camp_new')::uuid)
    or exists (select 1 from public.camp_group_members where user_id = current_setting('test.camp_new')::uuid)
    then raise exception 'Self-service account deletion did not clear private identity/membership'; end if;
end;
$test$;

create or replace function public.camp_now() returns timestamptz
language sql volatile set search_path = '' as $$
  select coalesce(nullif(current_setting('test.camp_clock', true), '')::timestamptz, clock_timestamp())
$$;
select set_config('test.camp_clock', '2030-04-02T23:59:59.999+00:00', true);
update public.camp_groups set initialized_at = '2030-04-01T12:00:00+00:00',
  last_settled_day = '2030-04-01', balance = 0 where id = current_setting('test.camp_c_group')::uuid;
delete from public.camp_group_days where group_id = current_setting('test.camp_c_group')::uuid;
create function public.test_advance_camp_clock() returns trigger language plpgsql as $$
begin
  perform set_config('test.camp_clock', '2030-04-03T00:00:00.001+00:00', true);
  return new;
end;
$$;
create trigger zz_test_advance_camp_clock before insert on public.time_requests
for each row execute function public.test_advance_camp_clock();
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.camp_c'), true);
select set_config('test.camp_midnight_request', public.create_time_request(15::smallint, null, 'Games')::text, true);
do $test$
declare shop jsonb;
begin
  shop := public.get_circle_shop();
  if shop ->> 'localDate' <> '2030-04-03' or shop ->> 'balance' <> '0'
    or shop ->> 'askedToday' <> 'false' or shop ->> 'eligibleToday' <> 'true'
    then raise exception 'Midnight acceptance burned wrong day or awarded burnt day'; end if;
end;
$test$;
reset role;
do $test$
begin
  if not exists (select 1 from public.camp_group_days where group_id = current_setting('test.camp_c_group')::uuid
    and day = '2030-04-02' and requested and not earned and settled_at is not null)
    or not exists (select 1 from public.time_requests where id = current_setting('test.camp_midnight_request')::uuid
      and created_at = '2030-04-02T23:59:59.999+00:00'::timestamptz and expires_at = created_at + interval '20 minutes')
    then raise exception 'Acceptance timestamp and durable group day disagree'; end if;
end;
$test$;
drop trigger zz_test_advance_camp_clock on public.time_requests;
drop function public.test_advance_camp_clock();
set local role anon;
do $test$
begin
  begin perform public.get_circle_shop(); raise exception 'Anonymous shop call accepted';
  exception when insufficient_privilege then null; end;
end;
$test$;
reset role;
rollback;
