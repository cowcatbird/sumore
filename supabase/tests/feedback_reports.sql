begin;
insert into auth.users(id) values ('a1111111-1111-4111-8111-111111111111'),('b1111111-1111-4111-8111-111111111111');
do $$
begin
  if has_function_privilege('authenticated','public.feedback_reserve(uuid,uuid,text,text,text,text)','execute')
    or has_function_privilege('anon','public.feedback_finish(uuid,uuid,uuid,uuid)','execute')
    or has_function_privilege('authenticated','public.feedback_release(uuid,uuid,uuid)','execute') then
    raise exception 'Feedback RPC exposed to clients';
  end if;
  if has_table_privilege('authenticated','public.feedback_reports','select')
    or has_table_privilege('service_role','public.feedback_reports','insert') then raise exception 'Feedback table exposed'; end if;
  if not (select relrowsecurity from pg_class where oid='public.feedback_reports'::regclass) then raise exception 'RLS not enabled'; end if;
end;
$$;
set local role service_role;
do $$
declare
  actor uuid := 'a1111111-1111-4111-8111-111111111111';
  other_actor uuid := 'b1111111-1111-4111-8111-111111111111';
  report uuid := '11111111-1111-4111-8111-111111111111';
  receipt uuid := '22222222-2222-4222-8222-222222222222';
  first jsonb;
  retry jsonb;
  token uuid;
begin
  first := public.feedback_reserve(actor,report,'A test problem report','ios','1.2.0','sumore <reports@example.invalid>');
  if first->>'state' <> 'ready' then raise exception 'Cannot reserve report: %',first; end if;
  token := (first->>'leaseId')::uuid;
  retry := public.feedback_reserve(actor,report,'A test problem report','ios','1.2.0','new@example.invalid');
  if retry->>'state' <> 'busy' then raise exception 'Concurrent duplicate not blocked'; end if;
  retry := public.feedback_reserve(actor,report,'A changed problem report','ios','1.2.0','sumore <reports@example.invalid>');
  if retry->>'state' <> 'conflict' then raise exception 'Payload mutation accepted'; end if;
  if public.feedback_finish(actor,report,gen_random_uuid(),receipt) then raise exception 'Foreign lease marked sent'; end if;
  perform public.feedback_release(actor,report,gen_random_uuid());
  if (public.feedback_reserve(actor,report,'A test problem report','ios','1.2.0','new@example.invalid')->>'state') <> 'busy' then raise exception 'Foreign lease released'; end if;
  perform public.feedback_release(actor,report,token);
  retry := public.feedback_reserve(actor,report,'A test problem report','ios','1.2.0','new@example.invalid');
  if retry->>'state' <> 'ready' or retry->>'sender' <> 'sumore <reports@example.invalid>' then raise exception 'Retry payload sender changed'; end if;
  if not public.feedback_finish(actor,report,(retry->>'leaseId')::uuid,receipt) then raise exception 'Provider receipt not saved'; end if;
  if (public.feedback_reserve(actor,report,'A test problem report','ios','1.2.0','new@example.invalid')->>'state') <> 'sent' then raise exception 'Sent report retried'; end if;
  -- Same UUID for another authenticated account is a separate report/key.
  if (public.feedback_reserve(other_actor,report,'A test problem report','ios','1.2.0','reports@example.invalid')->>'state') <> 'ready' then raise exception 'Users share idempotency state'; end if;
  for n in 1..2 loop
    if (public.feedback_reserve(actor,gen_random_uuid(),'Another test report','android','1.2.0','reports@example.invalid')->>'state') <> 'ready' then raise exception 'Quota too small'; end if;
  end loop;
  if (public.feedback_reserve(actor,gen_random_uuid(),'Another test report','web','1.2.0','reports@example.invalid')->>'state') <> 'rateLimited' then raise exception 'Fourth hourly report admitted'; end if;
  if (public.feedback_reserve(actor,report,'A test problem report','ios','1.2.0','new@example.invalid')->>'state') <> 'sent' then raise exception 'Retry consumed quota'; end if;
end;
$$;
reset role;
do $$
declare actor uuid := 'a1111111-1111-4111-8111-111111111111'; old_id uuid; response jsonb;
begin
  if (select count(*) from public.feedback_reports r where r.actor_id=actor) <> 3 then raise exception 'Rejected calls consumed submissions'; end if;
  if (select count(*) from public.feedback_reports r where r.actor_id=actor and status='sent') <> 1 then raise exception 'Pending reported sent'; end if;
  update public.feedback_reports r set created_at=clock_timestamp()-interval '2 hours' where r.actor_id=actor;
  for n in 1..7 loop
    insert into public.feedback_reports(actor_id,report_id,message,platform,app_version,mail_from,created_at)
      values(actor,gen_random_uuid(),'Prior problem report','ios','1.2.0','reports@example.invalid',clock_timestamp()-interval '2 hours');
  end loop;
  response:=public.feedback_reserve(actor,gen_random_uuid(),'Another test report','ios','1.2.0','reports@example.invalid');
  if response->>'state'<>'rateLimited' then raise exception 'Eleventh daily report admitted'; end if;
  select report_id into old_id from public.feedback_reports r where r.actor_id=actor and status='pending' limit 1;
  update public.feedback_reports r set created_at=clock_timestamp()-interval '23 hours',lease_until=null where r.actor_id=actor and r.report_id=old_id;
  select public.feedback_reserve(actor,old_id,r.message,r.platform,r.app_version,r.mail_from) into response
    from public.feedback_reports r where r.actor_id=actor and r.report_id=old_id;
  if response->>'state'<>'expired' then raise exception 'Ambiguous report retried past provider idempotency window'; end if;
  delete from auth.users where id=actor;
  if exists(select 1 from public.feedback_reports r where r.actor_id=actor) then raise exception 'Account deletion retained feedback content'; end if;
end;
$$;
rollback;
