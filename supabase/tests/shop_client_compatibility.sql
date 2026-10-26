-- Exercise old installed clients and the new catalog against the same group.
-- All users, purchases and requests are disposable and rolled back.
begin;
select set_config('test.compat_owner', gen_random_uuid()::text, true);
select set_config('test.compat_peer', gen_random_uuid()::text, true);
insert into auth.users (id, raw_user_meta_data) values
  (current_setting('test.compat_owner')::uuid, '{"display_name":"Compatibility owner"}'),
  (current_setting('test.compat_peer')::uuid, '{"display_name":"Compatibility peer"}');
select set_config('test.compat_code', friend_code, true) from public.profiles where id = current_setting('test.compat_owner')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.compat_owner'), true);
select set_config('test.compat_group', public.get_circle_shop_v2('UTC') ->> 'id', true);

do $test$
declare item record; wanted_price integer; before_shop jsonb; shop jsonb;
begin
  if to_regprocedure('public.purchase_circle_item(uuid,text)') is not null
    or (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'purchase_circle_item') <> 1
  then raise exception 'Ambiguous purchase overload remains'; end if;
  if not has_function_privilege('authenticated','public.purchase_circle_item(uuid,text,integer)','EXECUTE')
    then raise exception 'Authenticated caller lost purchase access'; end if;
  before_shop := public.get_circle_shop_v2();
  for item in select * from (values
    ('hat:crown'::text, 10), ('color:blue', 5), ('color:orange', 5), ('color:pink', 5),
    ('hat:wizard', 5), ('hat:pirate', 5), ('hat:clown', 5), ('hat:viking', 5)
  ) catalog(id, price) loop
    begin
      perform public.purchase_circle_item(current_setting('test.compat_group')::uuid, item.id);
      raise exception 'Legacy client silently paid a new price: %', item.id;
    exception when raise_exception then
      if sqlerrm <> 'Update sumore to see the latest shop prices' then raise; end if;
    end;
    -- Includes the price of 1 still displayed by installed older clients.
    foreach wanted_price in array array[1, 0, -1, item.price + 1] loop
      begin
        perform public.purchase_circle_item(current_setting('test.compat_group')::uuid, item.id, wanted_price);
        raise exception 'Mismatched displayed price was accepted: %', item.id;
      exception when raise_exception then
        if sqlerrm <> 'The price changed. Refresh the shop and try again' then raise; end if;
      end;
    end loop;
    if public.get_circle_shop_v2() is distinct from before_shop
      then raise exception 'Rejected offer changed the wallet'; end if;
  end loop;
  begin
    perform public.purchase_circle_item(current_setting('test.compat_group')::uuid, 'background:beach', 29);
    raise exception 'Incorrect beach price accepted';
  exception when raise_exception then
    if sqlerrm <> 'The price changed. Refresh the shop and try again' then raise; end if;
  end;
  -- Beach retained its old price, so two-argument legacy purchases still work.
  shop := public.purchase_circle_item(current_setting('test.compat_group')::uuid, 'background:beach');
  if shop ->> 'balance' is distinct from '69' or shop -> 'unlocked' is distinct from '["background:beach"]'::jsonb
    then raise exception 'Legacy beach compatibility failed'; end if;
  for item in select * from (values
    ('hat:crown'::text, 10), ('color:blue', 5), ('color:orange', 5), ('color:pink', 5),
    ('hat:wizard', 5), ('hat:pirate', 5), ('hat:clown', 5), ('hat:viking', 5)
  ) catalog(id, price) loop
    shop := public.purchase_circle_item(current_setting('test.compat_group')::uuid, item.id, item.price);
    if not (shop -> 'unlocked' ? item.id) then raise exception 'Priced response omitted owned item'; end if;
    if public.purchase_circle_item(current_setting('test.compat_group')::uuid, item.id, 1) is distinct from shop
      then raise exception 'Already-owned stale-price retry charged again'; end if;
    if public.purchase_circle_item(current_setting('test.compat_group')::uuid, item.id) ->> 'balance' is distinct from shop ->> 'balance'
      then raise exception 'Legacy owned retry charged again'; end if;
  end loop;
  if public.get_circle_shop_v2() ->> 'balance' is distinct from '24'
    or jsonb_array_length(public.get_circle_shop_v2() -> 'unlocked') <> 9
    or jsonb_array_length(public.get_circle_shop() -> 'unlocked') <> 5
  then raise exception 'Versioned wallets lost shared balance or ownership'; end if;
  if (public.get_circle_shop_v2() - 'unlocked') is distinct from (public.get_circle_shop() - 'unlocked')
    then raise exception 'Legacy filtering changed wallet dates, group or balance'; end if;
  if public.set_circle_background(current_setting('test.compat_group')::uuid, 'beach') ->> 'background' is distinct from 'beach'
    or jsonb_array_length(public.set_circle_background(current_setting('test.compat_group')::uuid, 'beach') -> 'unlocked') <> 5
    or jsonb_array_length(public.set_circle_background_v2(current_setting('test.compat_group')::uuid, 'beach') -> 'unlocked') <> 9
    or jsonb_array_length(public.purchase_circle_item(current_setting('test.compat_group')::uuid, 'background:beach') -> 'unlocked') <> 5
  then raise exception 'Background or owned legacy purchase leaked new catalog'; end if;
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.compat_peer'), true);
select public.join_shared_circle(current_setting('test.compat_code'));
select public.update_my_character(auth.uid(), 'wizard', 'tall', 0, 'blue');
select public.create_time_request(15::smallint, 'Catalog compatibility QA');
select set_config('request.jwt.claim.sub', current_setting('test.compat_owner'), true);

do $test$
declare hat text; revision integer := 0; legacy jsonb; modern jsonb; member jsonb; peer jsonb; procedure_name text;
begin
  foreach hat in array array['beanie','bucket','headband','propeller','wizard','pirate','clown','viking'] loop
    perform public.update_my_character(auth.uid(), hat, 'short', revision, 'pink');
    revision := revision + 1;
    modern := public.get_app_snapshot_v2();
    legacy := public.get_app_snapshot();
    if modern #>> '{profile,character,appearance,hat}' is distinct from hat
      or legacy #>> '{profile,character,appearance,hat}' is distinct from 'none'
      or (legacy #>> '{profile,character,revision}')::integer is distinct from revision
      or legacy #>> '{profile,character,appearance,color}' is distinct from 'pink'
      or legacy #>> '{profile,character,appearance,body}' is distinct from 'short'
    then raise exception 'Old/new own character compatibility failed: %', hat; end if;
    if jsonb_array_length(legacy #> '{circleShop,unlocked}') <> 5
      or jsonb_array_length(modern #> '{circleShop,unlocked}') <> 9
      or legacy #>> '{circleShop,balance}' is distinct from '24'
      or legacy #>> '{campfire,groupGolden}' is distinct from '24'
      or jsonb_array_length(legacy -> 'friends') <> 1
      or jsonb_array_length(legacy #> '{campfire,seats}') <> 2
      or jsonb_array_length(legacy -> 'incomingRequests') <> 1
    then raise exception 'Snapshot filtering changed wallet, roster or pending requests'; end if;
    peer := legacy #> '{friends,0,character}';
    if peer #>> '{appearance,hat}' is distinct from 'none' or peer ->> 'revision' is distinct from '1'
      or peer #>> '{appearance,color}' is distinct from 'blue'
      or legacy #> '{incomingRequests,0,friend,character}' is distinct from peer
      or modern #>> '{friends,0,character,appearance,hat}' is distinct from 'wizard'
      or modern #>> '{incomingRequests,0,friend,character,appearance,hat}' is distinct from 'wizard'
    then raise exception 'Peer or incoming request compatibility failed'; end if;
    for member in select value from jsonb_array_elements(legacy #> '{campfire,seats}') loop
      if member #>> '{character,appearance,hat}' is distinct from 'none'
        then raise exception 'Legacy campfire leaked a new hat'; end if;
      if member ->> 'id' = current_setting('test.compat_peer') and member -> 'character' is distinct from peer
        then raise exception 'Peer seat lost its real revision'; end if;
    end loop;
    if (select character_hat from public.profiles where id = auth.uid()) is distinct from hat
      or (select character_revision from public.profiles where id = auth.uid()) is distinct from revision
    then raise exception 'Legacy serialization mutated stored paid appearance'; end if;
  end loop;
  perform public.update_my_character(auth.uid(), 'crown', 'short', revision);
  if public.get_app_snapshot() #>> '{profile,character,appearance,hat}' is distinct from 'crown'
    then raise exception 'Old supported crown was incorrectly hidden'; end if;
  foreach procedure_name in array array[
    'public.get_circle_shop(text)', 'public.get_circle_shop_v2(text)',
    'public.get_app_snapshot(text)', 'public.get_app_snapshot_v2(text)',
    'public.set_circle_background(uuid,text)', 'public.set_circle_background_v2(uuid,text)',
    'public.purchase_circle_item(uuid,text,integer)'
  ] loop
    if has_function_privilege('anon', procedure_name, 'EXECUTE')
      or not has_function_privilege('authenticated', procedure_name, 'EXECUTE')
      then raise exception 'Versioned endpoint ACL failed: %', procedure_name; end if;
  end loop;
  foreach procedure_name in array array['public.camp_catalog_v1_shop(jsonb)', 'public.camp_catalog_v1_character(jsonb)'] loop
    if has_function_privilege('anon', procedure_name, 'EXECUTE')
      or has_function_privilege('authenticated', procedure_name, 'EXECUTE')
      then raise exception 'Private compatibility helper exposed: %', procedure_name; end if;
  end loop;
end;
$test$;
reset role;
rollback;
