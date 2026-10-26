-- Disposable PostgreSQL only. Nothing here is a production wallet reset.
begin;
select set_config('test.snow_owner', gen_random_uuid()::text, true);
select set_config('test.snow_peer', gen_random_uuid()::text, true);
select set_config('test.snow_outsider', gen_random_uuid()::text, true);
insert into auth.users (id, raw_user_meta_data) values
  (current_setting('test.snow_owner')::uuid, '{"display_name":"Snow QA owner"}'),
  (current_setting('test.snow_peer')::uuid, '{"display_name":"Snow QA peer"}'),
  (current_setting('test.snow_outsider')::uuid, '{"display_name":"Snow QA outsider"}');
select set_config('test.snow_code', friend_code, true) from public.profiles where id = current_setting('test.snow_owner')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.snow_owner'), true);
select set_config('test.snow_group', public.get_circle_shop_v4('UTC') ->> 'id', true);

do $test$
declare wallet jsonb; before_shop jsonb; wrong_price integer; item text; color text;
begin
  if public.get_circle_shop_v4() ->> 'balance' is distinct from '99'
    then raise exception 'Snow catalog changed the production starter balance'; end if;
  -- Beach remains 30 and does not authorize the new snow artwork.
  wallet := public.purchase_circle_item_v4(current_setting('test.snow_group')::uuid, 'background:beach', 30);
  if wallet ->> 'balance' is distinct from '69' then raise exception 'Beach price changed'; end if;
  perform public.set_circle_background_v4(current_setting('test.snow_group')::uuid, 'beach');
  before_shop := public.get_circle_shop_v4();
  begin
    perform public.set_circle_background_v4(current_setting('test.snow_group')::uuid, 'snow');
    raise exception 'Beach ownership incorrectly unlocked snow';
  exception when raise_exception then
    if sqlerrm <> 'Unlock the snow campsite in your circle’s shop first' then raise; end if;
  end;
  foreach wrong_price in array array[-1, 0, 1, 29, 31] loop
    begin
      perform public.purchase_circle_item_v4(current_setting('test.snow_group')::uuid, 'background:snow', wrong_price);
      raise exception 'Snow accepted an incorrect displayed price';
    exception when raise_exception then
      if sqlerrm <> 'The price changed. Refresh the shop and try again' then raise; end if;
    end;
  end loop;
  begin
    perform public.purchase_circle_item_v4(current_setting('test.snow_group')::uuid, 'background:snow');
    raise exception 'Snow accepted a purchase without price confirmation';
  exception when raise_exception then
    if sqlerrm <> 'Update sumore to see the latest shop prices' then raise; end if;
  end;
  foreach item in array array['background:forest','background:space','color:cream'] loop
    begin
      perform public.purchase_circle_item_v4(current_setting('test.snow_group')::uuid, item, 30);
      raise exception 'A free or unsupported item was sold';
    exception when raise_exception then
      if sqlerrm <> 'Choose an available shop item' then raise; end if;
    end;
  end loop;
  if public.get_circle_shop_v4() is distinct from before_shop
    then raise exception 'Rejected background changes or purchases mutated the wallet'; end if;
  wallet := public.purchase_circle_item_v4(current_setting('test.snow_group')::uuid, 'background:snow', 30);
  if wallet ->> 'balance' is distinct from '39' or not (wallet -> 'unlocked' ? 'background:snow')
    or wallet ->> 'background' is distinct from 'beach'
    then raise exception 'Snow purchase charged incorrectly, lost its unlock, or auto-selected artwork'; end if;
  if (select cost from public.camp_group_unlocks where group_id = current_setting('test.snow_group')::uuid and item_id = 'background:snow')
    is distinct from 30 then raise exception 'Snow ledger cost is incorrect'; end if;
  if public.purchase_circle_item_v4(current_setting('test.snow_group')::uuid, 'background:snow', 30) is distinct from wallet
    or public.purchase_circle_item_v4(current_setting('test.snow_group')::uuid, 'background:snow', 1) is distinct from wallet
    or public.purchase_circle_item_v4(current_setting('test.snow_group')::uuid, 'background:snow') is distinct from wallet
    then raise exception 'Retrying an owned snow purchase charged twice'; end if;
  foreach color in array array['red','orange','yellow','green','blue','pink'] loop
    wallet := public.purchase_circle_item_v4(current_setting('test.snow_group')::uuid, 'color:' || color, 5);
  end loop;
  if wallet ->> 'balance' is distinct from '9' or jsonb_array_length(wallet -> 'unlocked') <> 8
    then raise exception 'Snow changed existing color prices or ownership'; end if;
  perform public.update_my_character(auth.uid(), 'beanie', 'short', 0, 'red');
  if public.set_circle_background_v4(current_setting('test.snow_group')::uuid, 'snow') ->> 'background' is distinct from 'snow'
    then raise exception 'Owned snow could not be selected'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.snow_peer'), true);
do $test$
declare wallet jsonb; legacy jsonb;
begin
  wallet := public.join_shared_circle_v4(current_setting('test.snow_code'));
  if wallet ->> 'background' is distinct from 'snow' or wallet ->> 'balance' is distinct from '9'
    or not (wallet -> 'unlocked' ? 'background:snow')
    then raise exception 'Joining a snowy camp lost its real shared wallet'; end if;
  if public.purchase_circle_item_v4(current_setting('test.snow_group')::uuid, 'background:snow', 30) is distinct from wallet
    then raise exception 'Second member paid again for shared snow'; end if;
  legacy := public.join_shared_circle(current_setting('test.snow_code'));
  if legacy ->> 'background' is distinct from 'forest' or legacy ->> 'balance' is distinct from '9'
    or legacy -> 'unlocked' ? 'background:snow'
    or jsonb_array_length(legacy -> 'unlocked') <> 4
    then raise exception 'Unversioned join leaked snow or newer color IDs to old clients'; end if;
  perform public.update_my_character(auth.uid(), 'cow', 'tall', 0, 'green');
  perform public.create_time_request(10::smallint, 'Snow compatibility QA');
end;
$test$;
select set_config('request.jwt.claim.sub', current_setting('test.snow_owner'), true);

do $test$
declare modern jsonb; older jsonb; wallet jsonb; older_wallet jsonb; background text;
  endpoint text; expected_count integer; saved_background text;
begin
  modern := public.get_app_snapshot_v4();
  wallet := modern -> 'circleShop';
  if wallet ->> 'background' is distinct from 'snow' or wallet ->> 'balance' is distinct from '9'
    or modern #>> '{campfire,groupGolden}' is distinct from '9'
    or jsonb_array_length(modern -> 'friends') <> 1
    or jsonb_array_length(modern #> '{campfire,seats}') <> 2
    or jsonb_array_length(modern -> 'incomingRequests') <> 1
    then raise exception 'Snow snapshot changed balances, standing or the roster'; end if;
  foreach endpoint in array array['get_app_snapshot_v3','get_app_snapshot_v2','get_app_snapshot'] loop
    execute format('select public.%I()', endpoint) into older;
    older_wallet := older -> 'circleShop';
    expected_count := case when endpoint = 'get_app_snapshot_v3' then 7 else 4 end;
    if older_wallet ->> 'background' is distinct from 'forest'
      or older_wallet -> 'unlocked' ? 'background:snow'
      or jsonb_array_length(older_wallet -> 'unlocked') <> expected_count
      or (older_wallet - 'unlocked' - 'background') is distinct from (wallet - 'unlocked' - 'background')
      or older #>> '{campfire,groupGolden}' is distinct from '9'
      then raise exception 'Old snapshot failed snow fallback or changed wallet metadata: %', endpoint; end if;
    if endpoint = 'get_app_snapshot_v3' and (older - 'circleShop') is distinct from (modern - 'circleShop')
      then raise exception 'v3 snow fallback changed unrelated snapshot fields'; end if;
    if endpoint <> 'get_app_snapshot_v3' and (
      older #>> '{profile,character,appearance,color}' is distinct from 'cream'
      or older #>> '{friends,0,character,appearance,color}' is distinct from 'cream'
      or older #>> '{incomingRequests,0,friend,character,appearance,color}' is distinct from 'cream')
      then raise exception 'Snow migration broke older color compatibility'; end if;
  end loop;
  foreach endpoint in array array['get_circle_shop_v3','get_circle_shop_v2','get_circle_shop'] loop
    execute format('select public.%I()', endpoint) into older_wallet;
    expected_count := case when endpoint = 'get_circle_shop_v3' then 7 else 4 end;
    if older_wallet ->> 'background' is distinct from 'forest'
      or older_wallet -> 'unlocked' ? 'background:snow'
      or jsonb_array_length(older_wallet -> 'unlocked') <> expected_count
      or (older_wallet - 'unlocked' - 'background') is distinct from (wallet - 'unlocked' - 'background')
      then raise exception 'Old wallet reader leaked snow or changed balances: %', endpoint; end if;
  end loop;
  foreach endpoint in array array['purchase_circle_item_v3','purchase_circle_item'] loop
    execute format('select public.%I($1,$2,$3)', endpoint)
      into older_wallet using current_setting('test.snow_group')::uuid, 'color:blue', 5;
    if older_wallet ->> 'background' is distinct from 'forest' or older_wallet -> 'unlocked' ? 'background:snow'
      or older_wallet ->> 'balance' is distinct from '9'
      then raise exception 'Old purchase response leaked snow or charged an existing unlock: %', endpoint; end if;
  end loop;
  older_wallet := public.purchase_circle_item(current_setting('test.snow_group')::uuid, 'background:beach');
  if older_wallet ->> 'background' is distinct from 'forest'
    or jsonb_array_length(older_wallet -> 'unlocked') <> 4
    or older_wallet ->> 'balance' is distinct from '9'
    then raise exception 'Unpriced legacy purchase lost its compatible wallet'; end if;
  select g.background into saved_background from public.camp_groups g where g.id = current_setting('test.snow_group')::uuid;
  if saved_background is distinct from 'snow'
    or (select character_color from public.profiles where id = auth.uid()) is distinct from 'red'
    or (select character_revision from public.profiles where id = auth.uid()) is distinct from 1
    then raise exception 'Legacy reads/retries reset real snow or paid appearance'; end if;
  -- Older setters still return their supported wallet even if explicitly given snow.
  foreach endpoint in array array['set_circle_background_v3','set_circle_background_v2','set_circle_background'] loop
    execute format('select public.%I($1,$2)', endpoint)
      into older_wallet using current_setting('test.snow_group')::uuid, 'snow';
    expected_count := case when endpoint = 'set_circle_background_v3' then 7 else 4 end;
    if older_wallet ->> 'background' is distinct from 'forest'
      or older_wallet -> 'unlocked' ? 'background:snow'
      or jsonb_array_length(older_wallet -> 'unlocked') <> expected_count
      or older_wallet ->> 'balance' is distinct from '9'
      then raise exception 'Old background response leaked snow or changed balance: %', endpoint; end if;
  end loop;
  foreach background in array array['forest','beach','snow'] loop
    older_wallet := public.set_circle_background_v4(current_setting('test.snow_group')::uuid, background);
    if older_wallet ->> 'background' is distinct from background
      or (older_wallet - 'background') is distinct from (wallet - 'background')
      then raise exception 'Switching among owned backgrounds changed the wallet'; end if;
  end loop;
  begin
    perform public.set_circle_background_v4(current_setting('test.snow_group')::uuid, 'space');
    raise exception 'Unsupported background accepted';
  exception when raise_exception then if sqlerrm <> 'Choose an available campsite' then raise; end if; end;
  foreach endpoint in array array[
    'public.get_app_snapshot_v4(text)', 'public.get_circle_shop_v4(text)',
    'public.purchase_circle_item_v4(uuid,text,integer)', 'public.set_circle_background_v4(uuid,text)',
    'public.join_shared_circle_v4(text)', 'public.join_shared_circle(text)'
  ] loop
    if has_function_privilege('anon', endpoint, 'EXECUTE') or not has_function_privilege('authenticated', endpoint, 'EXECUTE')
      then raise exception 'Snow endpoint has incorrect access: %', endpoint; end if;
  end loop;
  if has_function_privilege('authenticated', 'public.camp_catalog_v3_shop(jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.camp_catalog_v3_shop(jsonb)', 'EXECUTE')
    or has_table_privilege('authenticated', 'public.camp_groups', 'INSERT,UPDATE,DELETE')
    or has_table_privilege('authenticated', 'public.camp_group_unlocks', 'INSERT,UPDATE,DELETE')
    then raise exception 'Snow exposed a private helper or direct wallet write'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.snow_outsider'), true);
select set_config('test.snow_other_group', public.get_circle_shop_v4('UTC') ->> 'id', true);
do $test$
begin
  begin
    perform public.purchase_circle_item_v4(current_setting('test.snow_group')::uuid, 'background:snow', 30);
    raise exception 'A nonmember purchased through another circle';
  exception when raise_exception then if sqlerrm <> 'Your circle changed. Refresh and try again' then raise; end if; end;
  begin
    perform public.set_circle_background_v4(current_setting('test.snow_group')::uuid, 'forest');
    raise exception 'A nonmember changed another circle’s background';
  exception when raise_exception then if sqlerrm <> 'Your circle changed. Refresh and try again' then raise; end if; end;
  if exists (select 1 from public.camp_group_unlocks where group_id = current_setting('test.snow_group')::uuid)
    then raise exception 'Snow unlocks leaked through RLS'; end if;
end;
$test$;
reset role;
-- Controlled boundary fixture only: it is removed by this transaction rollback.
update public.camp_groups set balance = 29 where id = current_setting('test.snow_other_group')::uuid;
set local role authenticated;
do $test$
begin
  begin
    perform public.purchase_circle_item_v4(current_setting('test.snow_other_group')::uuid, 'background:snow', 30);
    raise exception 'Snow purchase ignored insufficient shared funds';
  exception when raise_exception then if sqlerrm <> 'Your circle needs more s’mores' then raise; end if; end;
  if public.get_circle_shop_v4() ->> 'balance' is distinct from '29'
    or public.get_circle_shop_v4() -> 'unlocked' is distinct from '[]'::jsonb
    then raise exception 'Failed snow purchase changed the wallet'; end if;
end;
$test$;
reset role;
update public.camp_groups set balance = 30 where id = current_setting('test.snow_other_group')::uuid;
set local role authenticated;
do $test$
declare wallet jsonb;
begin
  wallet := public.purchase_circle_item_v4(current_setting('test.snow_other_group')::uuid, 'background:snow', 30);
  if wallet ->> 'balance' is distinct from '0' or wallet -> 'unlocked' is distinct from '["background:snow"]'::jsonb
    then raise exception 'Exact-price snow purchase failed'; end if;
  if public.purchase_circle_item_v4(current_setting('test.snow_other_group')::uuid, 'background:snow', 30) is distinct from wallet
    then raise exception 'Zero-balance owned retry was not free'; end if;
  begin
    perform public.set_circle_background_v4(current_setting('test.snow_other_group')::uuid, 'beach');
    raise exception 'Snow ownership incorrectly unlocked beach';
  exception when raise_exception then if sqlerrm <> 'Unlock the beach in your circle’s shop first' then raise; end if; end;
end;
$test$;
reset role;
rollback;
