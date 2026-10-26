-- Disposable database only. No production seed/top-up: normal new circles
-- still start with 99. The UI's 200-s'more preview balance never enters SQL.
begin;
select set_config('test.prices_a', gen_random_uuid()::text, true);
select set_config('test.prices_b', gen_random_uuid()::text, true);
select set_config('test.prices_c', gen_random_uuid()::text, true);
select set_config('test.prices_low', gen_random_uuid()::text, true);
insert into auth.users (id, raw_user_meta_data) values
  (current_setting('test.prices_a')::uuid, '{"display_name":"Pricing QA A"}'),
  (current_setting('test.prices_b')::uuid, '{"display_name":"Pricing QA B"}'),
  (current_setting('test.prices_c')::uuid, '{"display_name":"Pricing QA C"}'),
  (current_setting('test.prices_low')::uuid, '{"display_name":"Pricing QA low balance"}');
select set_config('test.prices_a_code', friend_code, true) from public.profiles where id = current_setting('test.prices_a')::uuid;
select set_config('test.prices_c_code', friend_code, true) from public.profiles where id = current_setting('test.prices_c')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.prices_a'), true);
select set_config('test.prices_a_group', public.get_circle_shop_v2('UTC') ->> 'id', true);
select set_config('request.jwt.claim.sub', current_setting('test.prices_b'), true);
select public.join_shared_circle(current_setting('test.prices_a_code'));
select set_config('request.jwt.claim.sub', current_setting('test.prices_c'), true);
select set_config('test.prices_c_group', public.get_circle_shop_v2('UTC') ->> 'id', true);
select set_config('request.jwt.claim.sub', current_setting('test.prices_a'), true);

do $test$
declare item record; free_hat text; wanted_hat text; balance integer := 99; revision integer := 0;
  peer_revision integer := 0; shop jsonb; saved jsonb; snapshot jsonb;
begin
  if public.get_circle_shop_v2() ->> 'balance' is distinct from '99' then raise exception 'Production circle seed changed'; end if;
  foreach free_hat in array array['beanie','bucket','headband','propeller'] loop
    saved := public.update_my_character(auth.uid(), free_hat, 'short', revision);
    revision := revision + 1;
    if saved #>> '{appearance,hat}' is distinct from free_hat then raise exception 'Remaining free hat was locked'; end if;
    begin
      perform public.purchase_circle_item(current_setting('test.prices_a_group')::uuid, 'hat:' || free_hat);
      raise exception 'Free hat unexpectedly offered as a paid item';
    exception when raise_exception then if sqlerrm <> 'Choose an available shop item' then raise; end if; end;
  end loop;
  begin
    perform public.update_my_character(auth.uid(), 'beanie', 'short', revision, 'blue');
    raise exception 'Unowned body color equipped';
  exception when raise_exception then if sqlerrm <> 'Unlock this color in your circle’s shop first' then raise; end if; end;
  begin
    perform public.set_circle_background(current_setting('test.prices_a_group')::uuid, 'beach');
    raise exception 'Unowned beach selected';
  exception when raise_exception then if sqlerrm <> 'Unlock the beach in your circle’s shop first' then raise; end if; end;

  for item in select * from (values
    ('hat:wizard'::text, 5), ('hat:pirate', 5), ('hat:clown', 5), ('hat:viking', 5),
    ('hat:crown', 10), ('color:blue', 5), ('color:orange', 5), ('color:pink', 5), ('background:beach', 30)
  ) catalog(id, price) loop
    if item.id like 'hat:%' then
      wanted_hat := substr(item.id, 5);
      begin
        perform public.update_my_character(auth.uid(), wanted_hat, 'short', revision);
        raise exception 'Unowned paid hat equipped: %', wanted_hat;
      exception when raise_exception then
        if sqlerrm <> (case when wanted_hat = 'crown' then 'Unlock the crown in your circle’s shop first'
          else 'Unlock this hat in your circle’s shop first' end) then raise; end if;
      end;
    end if;
    shop := public.purchase_circle_item(current_setting('test.prices_a_group')::uuid, item.id, item.price);
    balance := balance - item.price;
    if (shop ->> 'balance')::integer is distinct from balance or not (shop -> 'unlocked' ? item.id)
      then raise exception 'Wrong price or missing shared unlock: %', item.id; end if;
    if (select cost from public.camp_group_unlocks where group_id = current_setting('test.prices_a_group')::uuid and item_id = item.id)
      is distinct from item.price then raise exception 'Wrong recorded purchase price: %', item.id; end if;
    if public.purchase_circle_item(current_setting('test.prices_a_group')::uuid, item.id, item.price) is distinct from shop
      then raise exception 'Repeat purchase charged again: %', item.id; end if;

    if item.id like 'hat:%' then
      saved := public.update_my_character(auth.uid(), wanted_hat, 'short', revision);
      revision := revision + 1;
      if saved #>> '{appearance,hat}' is distinct from wanted_hat or (saved ->> 'revision')::integer is distinct from revision
        then raise exception 'Owned paid hat could not be equipped'; end if;
    elsif item.id like 'color:%' then
      saved := public.update_my_character(auth.uid(), 'crown', 'tall', revision, substr(item.id, 7));
      revision := revision + 1;
      if saved #>> '{appearance,color}' is distinct from substr(item.id, 7) then raise exception 'Owned color could not be equipped'; end if;
    else
      if public.set_circle_background_v2(current_setting('test.prices_a_group')::uuid, 'beach') ->> 'background' is distinct from 'beach'
        then raise exception 'Owned beach could not be selected'; end if;
    end if;

    -- A second member sees and may equip the same unlock without paying again.
    perform set_config('request.jwt.claim.sub', current_setting('test.prices_b'), true);
    shop := public.purchase_circle_item(current_setting('test.prices_a_group')::uuid, item.id, item.price);
    if (shop ->> 'balance')::integer is distinct from balance then raise exception 'Peer paid twice for shared item: %', item.id; end if;
    if item.id like 'hat:%' then
      perform public.update_my_character(auth.uid(), wanted_hat, 'tall', peer_revision);
      peer_revision := peer_revision + 1;
    end if;
    snapshot := public.get_app_snapshot_v2();
    if not (snapshot #> '{circleShop,unlocked}' ? item.id) then raise exception 'Peer snapshot lacks unlock: %', item.id; end if;
    perform set_config('request.jwt.claim.sub', current_setting('test.prices_a'), true);
  end loop;
  if balance <> 24 or (select count(*) from public.camp_group_unlocks where group_id = current_setting('test.prices_a_group')::uuid) <> 9
    then raise exception 'Catalog total or unique ownership count is wrong'; end if;
  -- Legacy calls still preserve a bought color; stale saves still cannot win.
  saved := public.update_my_character(auth.uid(), 'wizard', 'tall', revision);
  revision := revision + 1;
  if saved #>> '{appearance,color}' is distinct from 'pink' then raise exception 'Four-argument save reset paid color'; end if;
  begin
    perform public.update_my_character(auth.uid(), 'pirate', 'short', revision - 1);
    raise exception 'Stale save unexpectedly succeeded';
  exception when serialization_failure then null; end;
  perform set_config('test.prices_peer_revision', peer_revision::text, true);
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.prices_b'), true);
do $test$
declare saved jsonb; joined jsonb; snapshot jsonb; revision integer := current_setting('test.prices_peer_revision')::integer;
begin
  saved := public.update_my_character(auth.uid(), 'viking', 'short', revision, 'blue');
  revision := revision + 1;
  joined := public.join_shared_circle(current_setting('test.prices_c_code'));
  if joined ->> 'balance' is distinct from '99' or joined -> 'unlocked' is distinct from '[]'::jsonb
    then raise exception 'Joining transferred money or purchases'; end if;
  snapshot := public.get_app_snapshot_v2();
  if snapshot #>> '{profile,character,appearance,hat}' is distinct from 'none'
    or snapshot #>> '{profile,character,appearance,color}' is distinct from 'cream'
    or (snapshot #>> '{profile,character,revision}')::integer is distinct from revision + 1
    then raise exception 'Unowned hat/color carried into destination circle'; end if;
  begin
    perform public.update_my_character(auth.uid(), 'viking', 'short', revision + 1);
    raise exception 'Former-circle unlock bypassed destination ownership';
  exception when raise_exception then if sqlerrm <> 'Unlock this hat in your circle’s shop first' then raise; end if; end;
  begin
    perform public.purchase_circle_item(current_setting('test.prices_a_group')::uuid, 'hat:wizard');
    raise exception 'Stale group purchase succeeded';
  exception when raise_exception then if sqlerrm <> 'Your circle changed. Refresh and try again' then raise; end if; end;
  if exists (select 1 from public.camp_group_unlocks where group_id = current_setting('test.prices_a_group')::uuid)
    then raise exception 'Former member can inspect private purchases'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.prices_a'), true);
do $test$
begin
  if public.get_circle_shop_v2() ->> 'balance' is distinct from '24' then raise exception 'Leaving peer changed original wallet'; end if;
  if jsonb_array_length(public.get_circle_shop_v2() -> 'unlocked') is distinct from 9 then raise exception 'Leaving peer took original unlocks'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.prices_low'), true);
select set_config('test.prices_low_group', public.get_circle_shop_v2('UTC') ->> 'id', true);
reset role;
-- Deliberate isolated low-balance fixture, never a production top-up.
update public.camp_groups set balance = 4 where id = current_setting('test.prices_low_group')::uuid;
set local role authenticated;
do $test$
declare item text;
begin
  foreach item in array array['hat:wizard','hat:pirate','hat:clown','hat:viking','hat:crown','color:blue','color:orange','color:pink','background:beach'] loop
    begin
      perform public.purchase_circle_item(current_setting('test.prices_low_group')::uuid, item,
        case when item = 'hat:crown' then 10 when item = 'background:beach' then 30 else 5 end);
      raise exception 'Insufficient balance purchase unexpectedly succeeded';
    exception when raise_exception then if sqlerrm <> 'Your circle needs more s’mores' then raise; end if; end;
  end loop;
  if public.get_circle_shop_v2() ->> 'balance' is distinct from '4' or public.get_circle_shop_v2() -> 'unlocked' is distinct from '[]'::jsonb
    then raise exception 'Failed purchase spent money or granted ownership'; end if;
  perform public.update_my_character(auth.uid(), 'beanie', 'short', 0);
  if has_table_privilege('authenticated', 'public.camp_group_unlocks', 'INSERT,UPDATE,DELETE')
    or has_function_privilege('authenticated','public.camp_reconcile_character(uuid,uuid)','EXECUTE')
    or has_function_privilege('authenticated','public.camp_check_character_unlock()','EXECUTE')
    or has_function_privilege('anon','public.purchase_circle_item(uuid,text,integer)','EXECUTE')
  then raise exception 'Pricing migration exposed a write bypass'; end if;
end;
$test$;

-- Simulate a future accidental column grant: the trigger must still guard hats
-- and colors. Rollback restores all privileges and fixture state afterwards.
reset role;
grant update(character_hat, character_color) on public.profiles to authenticated;
set local role authenticated;
do $test$
declare hat text;
begin
  foreach hat in array array['wizard','pirate','clown','viking'] loop
    begin
      update public.profiles set character_hat = hat where id = auth.uid();
      raise exception 'Direct UPDATE bypassed paid hat';
    exception when raise_exception then if sqlerrm <> 'Unlock this hat in your circle’s shop first' then raise; end if; end;
  end loop;
  begin
    update public.profiles set character_color = 'pink' where id = auth.uid();
    raise exception 'Direct UPDATE bypassed paid color';
  exception when raise_exception then if sqlerrm <> 'Unlock this color in your circle’s shop first' then raise; end if; end;
end;
$test$;
reset role;

do $test$
begin
  begin
    insert into public.camp_group_unlocks(group_id, item_id, cost) values (current_setting('test.prices_low_group')::uuid, 'hat:wizard', 1);
    raise exception 'Ledger accepted legacy discount for a newly paid hat';
  exception when check_violation then null; end;
  begin
    insert into public.camp_group_unlocks(group_id, item_id, cost) values (current_setting('test.prices_low_group')::uuid, 'color:blue', 2);
    raise exception 'Ledger accepted an invalid price';
  exception when check_violation then null; end;
  begin
    insert into public.camp_group_unlocks(group_id, item_id, cost) values (current_setting('test.prices_low_group')::uuid, 'hat:beanie', 5);
    raise exception 'Ledger accepted a free hat';
  exception when check_violation then null; end;
end;
$test$;
rollback;
