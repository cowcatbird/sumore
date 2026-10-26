-- Disposable database only. No production accounts, keys, emails or network.
begin;
select set_config('test.access_self',gen_random_uuid()::text,true);
select set_config('test.access_peer',gen_random_uuid()::text,true);
select set_config('test.access_outside',gen_random_uuid()::text,true);
insert into auth.users(id,raw_user_meta_data) values
  (current_setting('test.access_self')::uuid,'{"display_name":"Access QA"}'),
  (current_setting('test.access_peer')::uuid,'{"display_name":"Peer QA"}'),
  (current_setting('test.access_outside')::uuid,'{"display_name":"Outside QA"}');
insert into public.feedback_reports(actor_id,report_id,message,platform,app_version,mail_from) values
  (current_setting('test.access_self')::uuid,gen_random_uuid(),'Disposable self feedback','ios','1.2.0','fixture@example.invalid'),
  (current_setting('test.access_peer')::uuid,gen_random_uuid(),'Disposable peer feedback','android','1.2.0','fixture@example.invalid');
select set_config('test.access_code',friend_code,true) from public.profiles where id=current_setting('test.access_self')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('test.access_self'),true);
select set_config('test.access_group',public.get_circle_shop_v3('UTC')->>'id',true);
select public.purchase_circle_item_v3(current_setting('test.access_group')::uuid,'hat:crown',10);
select set_config('request.jwt.claim.sub',current_setting('test.access_peer'),true);
select public.join_shared_circle(current_setting('test.access_code'));
select set_config('test.access_request',public.create_time_request(15::smallint,'QA','Selected apps')::text,true);
select set_config('request.jwt.claim.sub',current_setting('test.access_self'),true);
select public.decide_time_request(current_setting('test.access_request')::uuid,'approved'::public.recipient_decision);

do $test$
declare name text; bad jsonb; result jsonb;
begin
  foreach name in array array['account_recovery_keys','account_recovery_transfers','account_access_attempts'] loop
    begin execute format('select * from public.%I',name); raise exception 'Private account table exposed';
    exception when insufficient_privilege then null; end;
  end loop;
  if has_function_privilege('authenticated','public.account_lookup_key(text)','execute')
    or has_function_privilege('anon','public.account_store_key(uuid,text,text)','execute')
    or has_function_privilege('authenticated','public.account_finish_transfer(uuid,text)','execute')
    then raise exception 'Private recovery helper executable by client'; end if;
  if public.get_circle_app_limits() <> '[]'::jsonb then raise exception 'Sharing enabled without consent'; end if;
  result := public.set_shared_app_limits('[{"label":"  Instagram  ","minutes":20},{"label":"Game","minutes":10}]',30);
  if result->>'totalDailyMinutes' <> '30' or result#>>'{apps,0,label}' <> 'Instagram' then raise exception 'Allocation not canonical'; end if;
  foreach bad in array array[
    '{}'::jsonb,'[{"label":"","minutes":10}]','[{"label":"Game","minutes":0}]',
    '[{"label":"Game","minutes":1441}]','[{"label":"Game","minutes":1.5}]',
    '[{"label":"Game","minutes":"20"}]','[{"label":"Game","minutes":10,"packageId":"private"}]',
    '[{"label":"012345678901234567890123456789012","minutes":10}]'
  ] loop
    begin perform public.set_shared_app_limits(bad); raise exception 'Invalid allocation accepted';
    exception when raise_exception then if sqlerrm = 'Invalid allocation accepted' then raise; end if; end;
  end loop;
  begin perform public.set_shared_app_limits('[{"label":"Game","minutes":20}]',10); raise exception 'Total below disclosed sum accepted';
  exception when raise_exception then if sqlerrm = 'Total below disclosed sum accepted' then raise; end if; end;
  begin update public.shared_app_limits set total_daily_minutes=72000; raise exception 'Direct sharing write accepted';
  exception when insufficient_privilege then null; end;
  begin perform public.set_shared_app_limits(null,70,current_setting('test.access_peer')::uuid); raise exception 'Stale native owner accepted';
  exception when raise_exception then if sqlerrm = 'Stale native owner accepted' then raise; end if; end;
  if public.get_circle_app_limits()->0->>'totalDailyMinutes' <> '30' then raise exception 'Owner mismatch changed allocation'; end if;
  result := public.set_shared_daily_total(40,current_setting('test.access_self')::uuid);
  if result#>>'{apps,0,label}' <> 'Instagram' or result->>'totalDailyMinutes' <> '40' then raise exception 'Native total erased current labels'; end if;
  result := public.set_shared_daily_total(10,current_setting('test.access_self')::uuid);
  if result->'apps' <> 'null'::jsonb or result->>'totalDailyMinutes' <> '10' then raise exception 'Native total retained inconsistent labels'; end if;
  begin perform public.set_shared_daily_total(50,current_setting('test.access_peer')::uuid); raise exception 'Stale total-only owner accepted';
  exception when raise_exception then if sqlerrm = 'Stale total-only owner accepted' then raise; end if; end;
  perform set_config('request.jwt.claim.sub',current_setting('test.access_peer'),true);
  if jsonb_array_length(public.get_circle_app_limits()) <> 1 or (select count(*) from public.shared_app_limits) <> 1 then raise exception 'Circle peer cannot read consented allocation'; end if;
  perform set_config('request.jwt.claim.sub',current_setting('test.access_outside'),true);
  if public.get_circle_app_limits() <> '[]'::jsonb or (select count(*) from public.shared_app_limits) <> 0 then raise exception 'Outsider can read allocation'; end if;
  perform set_config('request.jwt.claim.sub',current_setting('test.access_self'),true);
  result := public.set_shared_app_limits(null,45);
  if result->'apps' <> 'null'::jsonb or result->>'totalDailyMinutes' <> '45' then raise exception 'Total-only sharing disclosed app labels'; end if;
  perform public.set_shared_app_limits(null);
  if public.get_circle_app_limits() <> '[]'::jsonb then raise exception 'Stop sharing retained allocation'; end if;
end $test$;

reset role;
set local role service_role;
select public.account_store_key(current_setting('test.access_self')::uuid,repeat('a',64),'qa-self@accounts.sumore.invalid');
select public.account_store_key(current_setting('test.access_peer')::uuid,repeat('b',64),'qa-peer@accounts.sumore.invalid');
do $test$
declare n integer; owner uuid:=current_setting('test.access_self')::uuid; peer uuid:=current_setting('test.access_peer')::uuid;
begin
  if public.account_key_status(owner,repeat('a',64))->>'matches' <> 'true' then raise exception 'Owner key cannot be verified'; end if;
  if public.account_lookup_key(repeat('c',64)) is not null then raise exception 'Invalid key looked up an account'; end if;
  for n in 1..5 loop
    if not public.account_access_allow(owner,repeat('d',64),'create') then raise exception 'Premature rate limit'; end if;
  end loop;
  if public.account_access_allow(owner,repeat('d',64),'create') then raise exception 'Rate limit bypassed'; end if;
  if not public.account_prepare_transfer(owner,peer,repeat('e',64)) then raise exception 'Transfer not prepared'; end if;
  if public.account_finish_transfer(owner,repeat('e',64)) then raise exception 'Old account consumed target-only transfer'; end if;
  perform public.account_store_key(owner,repeat('f',64),'qa-self@accounts.sumore.invalid');
  if public.account_finish_transfer(peer,repeat('e',64)) then raise exception 'Late recovery revoked a newly rotated key'; end if;
  if public.account_key_status(owner,repeat('f',64))->>'matches' <> 'true' then raise exception 'Rotation did not survive late cleanup'; end if;
  perform public.account_prepare_transfer(owner,peer,repeat('1',64));
  if not public.account_finish_transfer(peer,repeat('1',64)) then raise exception 'Post-login cleanup failed'; end if;
  if public.account_key_status(owner,null)->>'hasKey' <> 'false' then raise exception 'Abandoned key still valid'; end if;
  if public.account_key_status(peer,repeat('b',64))->>'matches' <> 'true' then raise exception 'Cleanup deleted restored key'; end if;
  if public.account_finish_transfer(peer,repeat('1',64)) then raise exception 'Cleanup ticket replay accepted'; end if;
end $test$;

reset role;
-- Recreate a key to verify actual account deletion cascades private data.
select public.account_store_key(current_setting('test.access_self')::uuid,repeat('2',64),'qa-self@accounts.sumore.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('test.access_self'),true);
select public.set_shared_app_limits(null,30);
select public.delete_my_account();
reset role;
do $test$
declare owner uuid:=current_setting('test.access_self')::uuid; peer uuid:=current_setting('test.access_peer')::uuid; group_key uuid:=current_setting('test.access_group')::uuid;
begin
  if exists(select 1 from auth.users where id=owner) or exists(select 1 from public.profiles where id=owner)
    or exists(select 1 from public.account_recovery_keys where user_id=owner)
    or exists(select 1 from public.shared_app_limits where user_id=owner)
    or exists(select 1 from public.feedback_reports where actor_id=owner)
    or exists(select 1 from public.account_access_attempts where bucket like 'actor:' || owner::text || ':%')
    then raise exception 'Account deletion left personal data'; end if;
  if not exists(select 1 from auth.users where id=peer) or not exists(select 1 from public.camp_group_members where user_id=peer and group_id=group_key)
    then raise exception 'Account deletion removed peer or membership'; end if;
  if not exists(select 1 from public.feedback_reports where actor_id=peer) then raise exception 'Account deletion removed peer feedback'; end if;
  if (select balance from public.camp_groups where id=group_key) <> 89
    or not exists(select 1 from public.camp_group_unlocks where group_id=group_key and item_id='hat:crown')
    then raise exception 'Deletion erased shared wallet/unlock'; end if;
  if not exists(select 1 from public.time_requests where id=current_setting('test.access_request')::uuid and status='approved' and decided_by is null)
    then raise exception 'Deleting approver destroyed peer decision'; end if;
  if not exists(select 1 from public.camp_group_days where group_id=group_key and requested)
    then raise exception 'Deletion erased durable no-reward day'; end if;
end $test$;
rollback;
