set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.price_owner'), true);
do $test$
declare shop jsonb; item text; saved jsonb; snapshot jsonb; peer jsonb; seat jsonb; incoming jsonb;
begin
  shop := public.get_circle_shop();
  if shop ->> 'balance' is distinct from '95' or jsonb_array_length(shop -> 'unlocked') is distinct from 4
    then raise exception 'Migration changed an existing wallet or removed purchases'; end if;
  foreach item in array array['hat:crown','color:blue','color:orange','color:pink'] loop
    if (select cost from public.camp_group_unlocks where group_id = current_setting('test.price_group')::uuid and item_id = item) is distinct from 1
      then raise exception 'Migration rewrote historical purchase cost: %', item; end if;
    if public.purchase_circle_item(current_setting('test.price_group')::uuid, item) ->> 'balance' is distinct from '95'
      then raise exception 'Old unlock was charged again at new price: %', item; end if;
  end loop;
  snapshot := public.get_app_snapshot_v2();
  saved := snapshot #> '{profile,character}';
  if saved #>> '{appearance,hat}' is distinct from 'crown' or saved #>> '{appearance,color}' is distinct from 'blue'
    or saved ->> 'revision' is distinct from '1' then raise exception 'Owned legacy cosmetics were reset'; end if;
  select value -> 'character' into peer from jsonb_array_elements(snapshot -> 'friends') where value ->> 'id' = current_setting('test.price_free_hat');
  select value -> 'character' into seat from jsonb_array_elements(snapshot #> '{campfire,seats}') where value ->> 'id' = current_setting('test.price_free_hat');
  incoming := snapshot #> '{incomingRequests,0,friend,character}';
  if peer #>> '{appearance,hat}' is distinct from 'none' or peer ->> 'revision' is distinct from '1'
    or seat is distinct from peer or incoming is distinct from peer
  then raise exception 'Unowned pre-upgrade peer hat leaked into a snapshot before owner refresh'; end if;
  if (select character_hat from public.profiles where id = current_setting('test.price_free_hat')::uuid) is distinct from 'wizard'
    or (select character_revision from public.profiles where id = current_setting('test.price_free_hat')::uuid) is distinct from 1
  then raise exception 'Peer serialization mutated another profile or revision'; end if;
  if has_function_privilege('authenticated','public.camp_character(public.profiles)','EXECUTE')
    or has_function_privilege('anon','public.camp_character(public.profiles)','EXECUTE')
  then raise exception 'Private character serialization became remotely executable'; end if;
  perform public.update_my_character(auth.uid(), 'crown', 'short', 1);
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.price_free_hat'), true);
do $test$
declare snapshot jsonb;
begin
  snapshot := public.get_app_snapshot_v2();
  if snapshot #>> '{profile,character,appearance,hat}' is distinct from 'none'
    or snapshot #>> '{profile,character,revision}' is distinct from '2'
    or snapshot #>> '{circleShop,balance}' is distinct from '95'
  then raise exception 'Formerly free paid hat was not reconciled without charging'; end if;
  if public.get_app_snapshot_v2() #>> '{profile,character,revision}' is distinct from '2'
    then raise exception 'Repeated refresh needlessly changed the character revision'; end if;
  begin
    perform public.update_my_character(auth.uid(), 'wizard', 'short', 2);
    raise exception 'Old free hat bypassed its new lock';
  exception when raise_exception then if sqlerrm <> 'Unlock this hat in your circle’s shop first' then raise; end if; end;
  if public.purchase_circle_item(current_setting('test.price_group')::uuid, 'hat:wizard', 5) ->> 'balance' is distinct from '90'
    then raise exception 'New hat did not charge five after upgrade'; end if;
  perform public.update_my_character(auth.uid(), 'wizard', 'short', 2);
end;
$test$;

select set_config('request.jwt.claim.sub', current_setting('test.price_owner'), true);
do $test$
declare snapshot jsonb; peer jsonb;
begin
  snapshot := public.get_app_snapshot_v2();
  select value -> 'character' into peer from jsonb_array_elements(snapshot -> 'friends') where value ->> 'id' = current_setting('test.price_free_hat');
  if peer #>> '{appearance,hat}' is distinct from 'wizard' or peer ->> 'revision' is distinct from '3'
    or snapshot #> '{incomingRequests,0,friend,character}' is distinct from peer
  then raise exception 'Purchased hat failed to appear with the owner’s real updated revision'; end if;
end;
$test$;
reset role;
