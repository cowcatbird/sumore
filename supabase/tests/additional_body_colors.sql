-- Disposable database only. Purchases use the normal 99-s'more group seed;
-- fixture identities, requests, balance changes and grants are rolled back.
begin;
select set_config('test.colors_owner', gen_random_uuid()::text, true);
select set_config('test.colors_peer', gen_random_uuid()::text, true);
select set_config('test.colors_outsider', gen_random_uuid()::text, true);
insert into auth.users (id, raw_user_meta_data) values
  (current_setting('test.colors_owner')::uuid, '{"display_name":"Color QA owner"}'),
  (current_setting('test.colors_peer')::uuid, '{"display_name":"Color QA peer"}'),
  (current_setting('test.colors_outsider')::uuid, '{"display_name":"Color QA outsider"}');
select set_config('test.colors_code', friend_code, true) from public.profiles
  where id = current_setting('test.colors_owner')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.colors_owner'), true);
select set_config('test.colors_group', public.get_circle_shop_v3('UTC') ->> 'id', true);
select set_config('request.jwt.claim.sub', current_setting('test.colors_peer'), true);
select public.join_shared_circle(current_setting('test.colors_code'));
select set_config('request.jwt.claim.sub', current_setting('test.colors_outsider'), true);
select set_config('test.colors_other_group', public.get_circle_shop_v3('UTC') ->> 'id', true);
select set_config('request.jwt.claim.sub', current_setting('test.colors_owner'), true);

do $test$
declare color text; body text; item text; wrong_price integer; balance integer := 99;
  revision integer := 0; peer_revision integer := 0; shop jsonb; before_shop jsonb; saved jsonb;
begin
  if public.get_circle_shop_v3() ->> 'balance' is distinct from '99'
    then raise exception 'Six-color catalog changed the normal circle seed'; end if;
  foreach color in array array['red','orange','yellow','green','blue','pink'] loop
    item := 'color:' || color;
    before_shop := public.get_circle_shop_v3();
    begin
      perform public.update_my_character(auth.uid(), 'cat', 'short', revision, color);
      raise exception 'Unowned color equipped: %', color;
    exception when raise_exception then
      if sqlerrm <> 'Unlock this color in your circle’s shop first' then raise; end if;
    end;
    begin
      perform public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, item);
      raise exception 'An unpriced purchase bought a new color: %', color;
    exception when raise_exception then
      if sqlerrm <> 'Update sumore to see the latest shop prices' then raise; end if;
    end;
    foreach wrong_price in array array[0, 1, 4, 6] loop
      begin
        perform public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, item, wrong_price);
        raise exception 'Wrong displayed color price accepted: % / %', item, wrong_price;
      exception when raise_exception then
        if sqlerrm <> 'The price changed. Refresh the shop and try again' then raise; end if;
      end;
    end loop;
    if public.get_circle_shop_v3() is distinct from before_shop
      then raise exception 'Rejected color save/purchase changed shared wallet: %', color; end if;
    shop := public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, item, 5);
    balance := balance - 5;
    if (shop ->> 'balance')::integer is distinct from balance or not (shop -> 'unlocked' ? item)
      then raise exception 'Color did not cost exactly five shared s’mores: %', color; end if;
    if (select cost from public.camp_group_unlocks where group_id = current_setting('test.colors_group')::uuid and item_id = item)
      is distinct from 5 then raise exception 'Wrong recorded color cost: %', color; end if;
    if public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, item, 5) is distinct from shop
      or public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, item, 1) is distinct from shop
      or public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, item) is distinct from shop
      then raise exception 'An owned color retry charged twice: %', color; end if;
    foreach body in array array['short','tall'] loop
      saved := public.update_my_character(auth.uid(), 'cat', body, revision, color);
      revision := revision + 1;
      if saved #>> '{appearance,color}' is distinct from color
        or saved #>> '{appearance,body}' is distinct from body
        or (saved ->> 'revision')::integer is distinct from revision
        then raise exception 'Owner color/body save was not confirmed: % / %', color, body; end if;
    end loop;

    perform set_config('request.jwt.claim.sub', current_setting('test.colors_peer'), true);
    if public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, item, 5) is distinct from shop
      then raise exception 'A peer was charged again for a shared color: %', color; end if;
    saved := public.update_my_character(auth.uid(), 'cow', 'tall', peer_revision, color);
    peer_revision := peer_revision + 1;
    if saved #>> '{appearance,color}' is distinct from color
      or not (public.get_app_snapshot_v3() #> '{circleShop,unlocked}' ? item)
      then raise exception 'Shared color unavailable to a second member: %', color; end if;
    perform set_config('request.jwt.claim.sub', current_setting('test.colors_owner'), true);
  end loop;
  if balance <> 69 or (select count(*) from public.camp_group_unlocks where group_id = current_setting('test.colors_group')::uuid) <> 6
    then raise exception 'Six colors changed wallet totals or duplicated unlocks'; end if;
  saved := public.update_my_character(auth.uid(), 'beanie', 'short', revision);
  revision := revision + 1;
  if saved #>> '{appearance,color}' is distinct from 'pink'
    then raise exception 'A four-argument save reset the existing paid color'; end if;
  begin
    perform public.update_my_character(auth.uid(), 'cat', 'tall', revision - 1, 'green');
    raise exception 'A stale color revision overwrote the current look';
  exception when serialization_failure then null; end;
  foreach color in array array['purple','Red','green ','color:red','#FF6464',''] loop
    begin
      perform public.update_my_character(auth.uid(), 'cat', 'tall', revision, color);
      raise exception 'Unsupported color accepted: %', color;
    exception when raise_exception then
      if sqlerrm <> 'Choose a supported hat, body and color' then raise; end if;
    end;
  end loop;
  begin
    perform public.update_my_character(current_setting('test.colors_peer')::uuid, 'cat', 'short', peer_revision, 'red');
    raise exception 'A caller changed a different member’s appearance';
  exception when raise_exception then
    if sqlerrm <> 'This camper belongs to a different account' then raise; end if;
  end;
  if (select character_color from public.profiles where id = auth.uid()) is distinct from 'pink'
    or (select character_revision from public.profiles where id = auth.uid()) is distinct from revision
    then raise exception 'Rejected appearance operations changed the stored look'; end if;
  perform set_config('test.colors_revision', revision::text, true);
  perform set_config('test.colors_peer_revision', peer_revision::text, true);

  -- Include both a v1-supported paid hat and a v2-only hat in the same wallet.
  perform public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, 'hat:crown', 10);
  perform public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, 'hat:wizard', 5);
  perform public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, 'background:beach', 30);
  if public.get_circle_shop_v3() ->> 'balance' is distinct from '24'
    then raise exception 'Compatibility fixtures changed the expected shared balance'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.colors_peer'), true);
select public.create_time_request(15::smallint, 'Six-color compatibility QA');
select set_config('request.jwt.claim.sub', current_setting('test.colors_owner'), true);

do $test$
declare color text; wanted_color text; revision integer := current_setting('test.colors_revision')::integer;
  peer_revision integer := current_setting('test.colors_peer_revision')::integer;
  modern jsonb; previous jsonb; legacy jsonb; expected_previous jsonb; expected_legacy jsonb;
  full_shop jsonb; previous_shop jsonb; legacy_shop jsonb; node_path text[]; procedure_name text;
begin
  foreach color in array array['red','orange','yellow','green','blue','pink'] loop
    perform set_config('request.jwt.claim.sub', current_setting('test.colors_peer'), true);
    perform public.update_my_character(auth.uid(), 'wizard', 'tall', peer_revision, color);
    peer_revision := peer_revision + 1;
    perform set_config('request.jwt.claim.sub', current_setting('test.colors_owner'), true);
    perform public.update_my_character(auth.uid(), 'beanie', 'short', revision, color);
    revision := revision + 1;
    modern := public.get_app_snapshot_v3();
    previous := public.get_app_snapshot_v2();
    legacy := public.get_app_snapshot();
    if jsonb_array_length(modern -> 'friends') <> 1
      or jsonb_array_length(modern #> '{campfire,seats}') <> 2
      or jsonb_array_length(modern -> 'incomingRequests') <> 1
      or modern #>> '{profile,character,appearance,color}' is distinct from color
      or modern #>> '{friends,0,character,appearance,color}' is distinct from color
      or modern #> '{incomingRequests,0,friend,character}' is distinct from modern #> '{friends,0,character}'
      or modern #> '{campfire,seats,0,character}' is distinct from modern #> '{profile,character}'
      or modern #> '{campfire,seats,1,character}' is distinct from modern #> '{friends,0,character}'
      then raise exception 'v3 failed to share color throughout the roster and requests: %', color; end if;
    full_shop := modern -> 'circleShop';
    if full_shop ->> 'balance' is distinct from '24' or jsonb_array_length(full_shop -> 'unlocked') <> 9
      then raise exception 'v3 snapshot dropped new unlocks or changed balance'; end if;
    select jsonb_set(full_shop, '{unlocked}', jsonb_agg(item order by position)) into previous_shop
      from jsonb_array_elements(full_shop -> 'unlocked') with ordinality entries(item, position)
      where item #>> '{}' not in ('color:red','color:yellow','color:green');
    select jsonb_set(full_shop, '{unlocked}', jsonb_agg(item order by position)) into legacy_shop
      from jsonb_array_elements(full_shop -> 'unlocked') with ordinality entries(item, position)
      where item #>> '{}' in ('hat:crown','color:orange','color:blue','color:pink','background:beach');
    if jsonb_array_length(previous_shop -> 'unlocked') <> 6 or jsonb_array_length(legacy_shop -> 'unlocked') <> 5
      then raise exception 'Compatibility fixture has the wrong catalog coverage'; end if;
    expected_previous := jsonb_set(modern, '{circleShop}', previous_shop);
    wanted_color := case when color in ('red','yellow','green') then 'cream' else color end;
    for node_path in select path from (values
      ('{profile,character,appearance,color}'::text[]),
      ('{friends,0,character,appearance,color}'::text[]),
      ('{campfire,seats,0,character,appearance,color}'::text[]),
      ('{campfire,seats,1,character,appearance,color}'::text[]),
      ('{incomingRequests,0,friend,character,appearance,color}'::text[])
    ) paths(path) loop
      expected_previous := jsonb_set(expected_previous, node_path, to_jsonb(wanted_color));
    end loop;
    if previous is distinct from expected_previous
      then raise exception 'v2 snapshot leaked a new color/unlock or changed unrelated fields: %', color; end if;
    expected_legacy := jsonb_set(expected_previous, '{circleShop}', legacy_shop);
    for node_path in select path from (values
      ('{profile,character,appearance,hat}'::text[]),
      ('{friends,0,character,appearance,hat}'::text[]),
      ('{campfire,seats,0,character,appearance,hat}'::text[]),
      ('{campfire,seats,1,character,appearance,hat}'::text[]),
      ('{incomingRequests,0,friend,character,appearance,hat}'::text[])
    ) paths(path) loop
      expected_legacy := jsonb_set(expected_legacy, node_path, '"none"'::jsonb);
    end loop;
    if legacy is distinct from expected_legacy
      then raise exception 'v1 snapshot lost its prior hat/color filtering or other fields: %', color; end if;
    if (select character_color from public.profiles where id = auth.uid()) is distinct from color
      or (select character_revision from public.profiles where id = auth.uid()) is distinct from revision
      or (select character_color from public.profiles where id = current_setting('test.colors_peer')::uuid) is distinct from color
      or (select character_revision from public.profiles where id = current_setting('test.colors_peer')::uuid) is distinct from peer_revision
      then raise exception 'Legacy serialization mutated real character colors or revisions'; end if;
  end loop;
  if public.get_circle_shop_v3() is distinct from full_shop
    or public.get_circle_shop_v2() is distinct from previous_shop
    or public.get_circle_shop() is distinct from legacy_shop
    then raise exception 'Versioned wallet filtering changed fields other than unlocks'; end if;
  full_shop := public.set_circle_background_v3(current_setting('test.colors_group')::uuid, 'beach');
  previous_shop := public.set_circle_background_v2(current_setting('test.colors_group')::uuid, 'beach');
  legacy_shop := public.set_circle_background(current_setting('test.colors_group')::uuid, 'beach');
  if full_shop ->> 'background' is distinct from 'beach'
    or jsonb_array_length(full_shop -> 'unlocked') <> 9
    or jsonb_array_length(previous_shop -> 'unlocked') <> 6
    or jsonb_array_length(legacy_shop -> 'unlocked') <> 5
    or (full_shop - 'unlocked') is distinct from (previous_shop - 'unlocked')
    or (full_shop - 'unlocked') is distinct from (legacy_shop - 'unlocked')
    then raise exception 'Background responses leaked new unlocks or changed wallet metadata'; end if;
  if public.purchase_circle_item(current_setting('test.colors_group')::uuid, 'color:blue', 5) is distinct from previous_shop
    or public.purchase_circle_item(current_setting('test.colors_group')::uuid, 'color:blue') is distinct from legacy_shop
    or public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, 'color:red', 5) is distinct from full_shop
    then raise exception 'Owned purchase responses did not preserve client-specific wallets'; end if;
  foreach procedure_name in array array[
    'public.get_app_snapshot_v3(text)', 'public.get_circle_shop_v3(text)',
    'public.set_circle_background_v3(uuid,text)', 'public.purchase_circle_item_v3(uuid,text,integer)'
  ] loop
    if has_function_privilege('anon', procedure_name, 'EXECUTE')
      or not has_function_privilege('authenticated', procedure_name, 'EXECUTE')
      then raise exception 'New color endpoint ACL failed: %', procedure_name; end if;
  end loop;
  foreach procedure_name in array array['public.camp_catalog_v2_shop(jsonb)', 'public.camp_catalog_v2_character(jsonb)'] loop
    if has_function_privilege('anon', procedure_name, 'EXECUTE')
      or has_function_privilege('authenticated', procedure_name, 'EXECUTE')
      then raise exception 'Color compatibility helper is exposed: %', procedure_name; end if;
  end loop;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.colors_outsider'), true);
do $test$
declare color text;
begin
  foreach color in array array['red','orange','yellow','green','blue','pink'] loop
    begin
      perform public.update_my_character(auth.uid(), 'cat', 'short', 0, color);
      raise exception 'A different group borrowed another circle’s color: %', color;
    exception when raise_exception then
      if sqlerrm <> 'Unlock this color in your circle’s shop first' then raise; end if;
    end;
    begin
      perform public.purchase_circle_item_v3(current_setting('test.colors_group')::uuid, 'color:' || color, 5);
      raise exception 'A nonmember purchased through a different group';
    exception when raise_exception then
      if sqlerrm <> 'Your circle changed. Refresh and try again' then raise; end if;
    end;
  end loop;
  if exists (select 1 from public.camp_group_unlocks where group_id = current_setting('test.colors_group')::uuid)
    then raise exception 'New color unlocks leaked through RLS'; end if;
  if has_table_privilege('authenticated', 'public.camp_group_unlocks', 'INSERT,UPDATE,DELETE')
    then raise exception 'New colors enabled direct wallet writes'; end if;
end;
$test$;

reset role;
-- Isolated negative fixture, never a production grant or balance change.
update public.camp_groups set balance = 4 where id = current_setting('test.colors_other_group')::uuid;
grant update(character_color) on public.profiles to authenticated;
set local role authenticated;
do $test$
declare color text;
begin
  foreach color in array array['red','orange','yellow','green','blue','pink'] loop
    begin
      perform public.purchase_circle_item_v3(current_setting('test.colors_other_group')::uuid, 'color:' || color, 5);
      raise exception 'Four s’mores bought a five-s’more color: %', color;
    exception when raise_exception then
      if sqlerrm <> 'Your circle needs more s’mores' then raise; end if;
    end;
    begin
      update public.profiles set character_color = color where id = auth.uid();
      raise exception 'A direct profile update bypassed shared color ownership: %', color;
    exception when raise_exception then
      if sqlerrm <> 'Unlock this color in your circle’s shop first' then raise; end if;
    end;
  end loop;
  if public.get_circle_shop_v3() ->> 'balance' is distinct from '4'
    or public.get_circle_shop_v3() -> 'unlocked' is distinct from '[]'::jsonb
    then raise exception 'Failed purchases changed the low-balance wallet'; end if;
end;
$test$;
reset role;
rollback;
