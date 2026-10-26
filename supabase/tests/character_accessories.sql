-- In-memory/disposable database only. All accounts and wallet changes roll back.
begin;
select set_config('test.accessory_owner',gen_random_uuid()::text,true);
select set_config('test.accessory_peer',gen_random_uuid()::text,true);
select set_config('test.accessory_other',gen_random_uuid()::text,true);
insert into auth.users(id,raw_user_meta_data) values
  (current_setting('test.accessory_owner')::uuid,'{"display_name":"Accessory owner"}'),
  (current_setting('test.accessory_peer')::uuid,'{"display_name":"Accessory peer"}'),
  (current_setting('test.accessory_other')::uuid,'{"display_name":"Accessory outsider"}');
select set_config('test.accessory_owner_code',friend_code,true) from public.profiles where id=current_setting('test.accessory_owner')::uuid;
select set_config('test.accessory_other_code',friend_code,true) from public.profiles where id=current_setting('test.accessory_other')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('test.accessory_owner'),true);
select set_config('test.accessory_group',public.get_circle_shop_v5('UTC')->>'id',true);
select set_config('request.jwt.claim.sub',current_setting('test.accessory_peer'),true);
select public.join_shared_circle_v5(current_setting('test.accessory_owner_code'));
select set_config('request.jwt.claim.sub',current_setting('test.accessory_owner'),true);

do $test$
declare hat text; body text; revision integer:=0; peer_revision integer:=0; cost integer; before_shop jsonb; wallet jsonb; saved jsonb;
  endpoint text; old_snapshot jsonb; snapshot jsonb; expected_balance integer:=99;
begin
  if public.get_circle_shop_v5()->>'balance' is distinct from '99' then raise exception 'Accessory catalog changed starter balance'; end if;
  foreach hat in array array['sunflower','lollipop'] loop
    foreach body in array array['short','tall'] loop
      saved:=public.update_my_character(auth.uid(),hat,body,revision);
      revision:=revision+1;
      if saved#>>'{appearance,hat}' is distinct from hat or saved#>>'{appearance,body}' is distinct from body
        or (saved->>'revision')::integer<>revision then raise exception 'Free accessory failed: %',hat; end if;
      if public.get_circle_shop_v5()->>'balance' is distinct from '99'
        or public.get_circle_shop_v5()->'unlocked' is distinct from '[]'::jsonb then raise exception 'Free accessory charged wallet'; end if;
      foreach endpoint in array array['get_app_snapshot_v4','get_app_snapshot_v3','get_app_snapshot_v2','get_app_snapshot'] loop
        execute format('select public.%I()',endpoint) into old_snapshot;
        if old_snapshot#>>'{profile,character,appearance,hat}' is distinct from 'none'
          or (old_snapshot#>>'{profile,character,revision}')::integer<>revision
          then raise exception 'Legacy snapshot rejected or changed revision for free accessory: %',endpoint; end if;
      end loop;
    end loop;
    begin perform public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'hat:'||hat,5);
      raise exception 'Free accessory was purchasable';
    exception when raise_exception then if sqlerrm<>'Choose an available shop item' then raise; end if; end;
  end loop;

  foreach hat in array array['cat-ears','bubble-gum','googly-eyes','disguise-glasses'] loop
    before_shop:=public.get_circle_shop_v5();
    begin perform public.update_my_character(auth.uid(),hat,'short',revision);
      raise exception 'Unpaid accessory equipped';
    exception when raise_exception then if sqlerrm<>'Unlock this hat in your circle’s shop first' then raise; end if; end;
    foreach cost in array array[-1,0,1,4,6,10] loop
      begin perform public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'hat:'||hat,cost);
        raise exception 'Wrong price accepted';
      exception when raise_exception then if sqlerrm<>'The price changed. Refresh the shop and try again' then raise; end if; end;
    end loop;
    begin perform public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'hat:'||hat);
      raise exception 'Missing price accepted';
    exception when raise_exception then if sqlerrm<>'Update sumore to see the latest shop prices' then raise; end if; end;
    if public.get_circle_shop_v5() is distinct from before_shop then raise exception 'Refused accessory changed wallet'; end if;
    wallet:=public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'hat:'||hat,5);
    expected_balance:=expected_balance-5;
    if (wallet->>'balance')::integer<>expected_balance or not (wallet->'unlocked' ? ('hat:'||hat))
      then raise exception 'Accessory price or entitlement wrong: %',hat; end if;
    if (select count(*) from public.camp_group_unlocks u where u.group_id=current_setting('test.accessory_group')::uuid and u.item_id='hat:'||hat and u.cost=5)<>1
      then raise exception 'Incorrect accessory ledger'; end if;
    if public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'hat:'||hat,5) is distinct from wallet
      or public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'hat:'||hat,1) is distinct from wallet
      or public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'hat:'||hat) is distinct from wallet
      then raise exception 'Owned retry charged twice'; end if;
    saved:=public.update_my_character(auth.uid(),hat,'tall',revision);
    revision:=revision+1;
    if saved#>>'{appearance,hat}' is distinct from hat then raise exception 'Paid accessory could not equip'; end if;
    perform set_config('request.jwt.claim.sub',current_setting('test.accessory_peer'),true);
    if public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'hat:'||hat,5) is distinct from wallet
      then raise exception 'A peer paid again for the shared accessory'; end if;
    saved:=public.update_my_character(auth.uid(),hat,'short',peer_revision);
    peer_revision:=peer_revision+1;
    snapshot:=public.get_app_snapshot_v5();
    if snapshot#>>'{friends,0,character,appearance,hat}' is distinct from hat
      or snapshot#>>'{profile,character,appearance,hat}' is distinct from hat
      then raise exception 'Shared accessory missing from full snapshot'; end if;
    foreach endpoint in array array['get_app_snapshot_v4','get_app_snapshot_v3','get_app_snapshot_v2','get_app_snapshot'] loop
      execute format('select public.%I()',endpoint) into old_snapshot;
      if old_snapshot#>>'{profile,character,appearance,hat}' is distinct from 'none'
        or old_snapshot#>>'{friends,0,character,appearance,hat}' is distinct from 'none'
        or old_snapshot#>>'{campfire,seats,0,character,appearance,hat}' is distinct from 'none'
        or old_snapshot#>>'{campfire,seats,1,character,appearance,hat}' is distinct from 'none'
        or old_snapshot#>>'{circleShop,balance}' is distinct from snapshot#>>'{circleShop,balance}'
        or old_snapshot#>>'{profile,character,revision}' is distinct from snapshot#>>'{profile,character,revision}'
        or old_snapshot#>>'{friends,0,character,revision}' is distinct from snapshot#>>'{friends,0,character,revision}'
        or old_snapshot#>'{circleShop,unlocked}' ? ('hat:'||hat)
        then raise exception 'Legacy snapshot exposed accessory/changed wallet or revisions: %',endpoint; end if;
    end loop;
    perform set_config('request.jwt.claim.sub',current_setting('test.accessory_owner'),true);
  end loop;
  perform set_config('test.accessory_revision',revision::text,true);
  perform set_config('test.accessory_peer_revision',peer_revision::text,true);
  begin perform public.update_my_character(auth.uid(),'lollipop','short',revision,'green'); raise exception 'Free hat bypassed color purchase';
  exception when raise_exception then if sqlerrm<>'Unlock this color in your circle’s shop first' then raise; end if; end;
  perform public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'color:blue',5);
  perform public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'hat:crown',10);
  perform public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'background:beach',30);
  wallet:=public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'background:snow',30);
  if wallet->>'balance' is distinct from '4' then raise exception 'Existing prices changed'; end if;
  perform public.set_circle_background_v5(current_setting('test.accessory_group')::uuid,'snow');
  saved:=public.update_my_character(auth.uid(),'cat-ears','tall',revision,'blue'); revision:=revision+1;
  saved:=public.update_my_character(auth.uid(),'sunflower','short',revision); revision:=revision+1;
  if saved#>>'{appearance,color}' is distinct from 'blue' then raise exception 'Legacy four-arg save lost existing color'; end if;
  perform set_config('test.accessory_revision',revision::text,true);
  perform public.create_time_request(15::smallint,'Accessory sync QA');
end $test$;

select set_config('request.jwt.claim.sub',current_setting('test.accessory_peer'),true);
do $test$
declare endpoint text; snapshot jsonb; wallet jsonb;
begin
  snapshot:=public.get_app_snapshot_v5();
  if snapshot#>>'{incomingRequests,0,friend,character,appearance,hat}' is distinct from 'sunflower'
    then raise exception 'Full incoming request lost accessory'; end if;
  foreach endpoint in array array['get_app_snapshot_v4','get_app_snapshot_v3','get_app_snapshot_v2','get_app_snapshot'] loop
    execute format('select public.%I()',endpoint) into snapshot;
    if snapshot#>>'{incomingRequests,0,friend,character,appearance,hat}' is distinct from 'none'
      or snapshot#>>'{incomingRequests,0,friend,character,revision}' is distinct from current_setting('test.accessory_revision')
      then raise exception 'Old incoming request exposed accessory or changed revision'; end if;
  end loop;
  foreach endpoint in array array['get_circle_shop_v4','get_circle_shop_v3','get_circle_shop_v2','get_circle_shop'] loop
    execute format('select public.%I()',endpoint) into wallet;
    if wallet->>'balance' is distinct from '4'
      or wallet->'unlocked' ?| array['hat:cat-ears','hat:bubble-gum','hat:googly-eyes','hat:disguise-glasses']
      then raise exception 'Old wallet exposed accessory/changed balance: %',endpoint; end if;
  end loop;
  wallet:=public.purchase_circle_item_v4(current_setting('test.accessory_group')::uuid,'hat:crown',10);
  if wallet->>'balance' is distinct from '4' or wallet->'unlocked' ? 'hat:cat-ears' then raise exception 'Old purchase response exposed accessory'; end if;
  wallet:=public.set_circle_background_v4(current_setting('test.accessory_group')::uuid,'snow');
  if wallet->>'background' is distinct from 'snow' or wallet->'unlocked' ? 'hat:cat-ears' then raise exception 'Old background response exposed accessory'; end if;
  wallet:=public.join_shared_circle_v4(current_setting('test.accessory_owner_code'));
  if wallet->>'balance' is distinct from '4' or wallet->'unlocked' ? 'hat:cat-ears' then raise exception 'Old join response exposed accessory'; end if;
  begin perform public.update_my_character(current_setting('test.accessory_owner')::uuid,'lollipop','short',0); raise exception 'Cross-account equip accepted';
  exception when raise_exception then if sqlerrm<>'This camper belongs to a different account' then raise; end if; end;
  begin perform public.update_my_character(auth.uid(),'lollipop','short',0); raise exception 'Stale revision accepted';
  exception when serialization_failure then null; end;
end $test$;

-- A circle move must remove paid accessories absent from the destination,
-- without transferring purchases, resetting either wallet or revoking peers.
select public.join_shared_circle_v5(current_setting('test.accessory_other_code'));
do $test$
declare snapshot jsonb;
begin
  snapshot:=public.get_app_snapshot_v5();
  if snapshot#>>'{profile,character,appearance,hat}' is distinct from 'none'
    or (snapshot#>>'{profile,character,revision}')::integer<>current_setting('test.accessory_peer_revision')::integer+1
    or snapshot#>>'{circleShop,balance}' is distinct from '99'
    or snapshot#>'{circleShop,unlocked}' is distinct from '[]'::jsonb then raise exception 'Circle move kept unpaid accessory or transferred wallet'; end if;
  perform public.update_my_character(auth.uid(),'lollipop','short',(snapshot#>>'{profile,character,revision}')::integer);
  perform public.join_shared_circle_v5(current_setting('test.accessory_owner_code'));
  if public.get_app_snapshot_v5()#>>'{profile,character,appearance,hat}' is distinct from 'lollipop' then raise exception 'Circle move removed free accessory'; end if;
end $test$;
select set_config('request.jwt.claim.sub',current_setting('test.accessory_other'),true);
select set_config('test.accessory_other_group',public.get_circle_shop_v5()->>'id',true);
do $test$
begin
  begin perform public.purchase_circle_item_v5(current_setting('test.accessory_group')::uuid,'hat:cat-ears',5); raise exception 'Cross-group purchase accepted';
  exception when raise_exception then if sqlerrm<>'Your circle changed. Refresh and try again' then raise; end if; end;
  if jsonb_array_length(public.get_app_snapshot_v5()->'friends')<>0 then raise exception 'Accessory catalog leaked unrelated circle'; end if;
  begin update public.profiles set character_hat='cat-ears',character_body='short' where id=auth.uid(); raise exception 'Direct profile write allowed';
  exception when insufficient_privilege then null; end;
  begin insert into public.camp_group_unlocks(group_id,item_id,cost) values(current_setting('test.accessory_other_group')::uuid,'hat:cat-ears',5); raise exception 'Direct unlock allowed';
  exception when insufficient_privilege then null; end;
end $test$;
reset role;
update public.camp_groups set balance=4 where id=current_setting('test.accessory_other_group')::uuid;
do $test$
begin
  begin update public.profiles set character_hat='cat-ears',character_body='short' where id=current_setting('test.accessory_other')::uuid;
    raise exception 'Trusted direct write bypassed paid-equip trigger';
  exception when raise_exception then if sqlerrm<>'Unlock this hat in your circle’s shop first' then raise; end if; end;
  if has_function_privilege('authenticated','public.camp_hat_price(text)','execute')
    or has_function_privilege('anon','public.purchase_circle_item_v5(uuid,text,integer)','execute')
    or has_function_privilege('authenticated','public.camp_catalog_v4_character(jsonb)','execute')
    then raise exception 'Accessory helpers/auth boundary exposed'; end if;
end $test$;
set local role authenticated;
do $test$
begin
  begin perform public.purchase_circle_item_v5(current_setting('test.accessory_other_group')::uuid,'hat:cat-ears',5); raise exception 'Insufficient funds accepted';
  exception when raise_exception then if sqlerrm<>'Your circle needs more s’mores' then raise; end if; end;
  if public.get_circle_shop_v5()->>'balance' is distinct from '4' or public.get_circle_shop_v5()->'unlocked' is distinct from '[]'::jsonb
    then raise exception 'Failed debit changed wallet'; end if;
  perform set_config('request.jwt.claim.sub','',true);
  begin perform public.get_app_snapshot_v5(); raise exception 'Unauthenticated snapshot accepted';
  exception when raise_exception then if sqlerrm<>'Authentication required' then raise; end if; end;
end $test$;
reset role;
rollback;
