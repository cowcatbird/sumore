-- Private SQL-editor moderation for the existing trusted postgres owner.
-- No app moderator is enrolled, no JWT is impersonated, no cleanup is run,
-- and no API role receives access to this schema. Apply after 0033.
create schema if not exists community_moderation_private authorization postgres;
revoke all on schema community_moderation_private from public,anon,authenticated,service_role;

alter table public.community_moderation_audit add column if not exists database_operator text;
comment on column public.community_moderation_audit.database_operator is
  'Real database session role for owner reviews; NULL for app moderator reviews, including historical rows. Not an email or claimed human identity.';

-- SECURITY DEFINER changes current_user, so it is NOT proof of an owner
-- session. PostgreSQL controls session_user and SET ROLE permissions. In
-- particular a postgres connection SET ROLE authenticated is NOT an owner
-- review. No request.jwt.*, application_name, or custom GUC confers access.
create or replace function community_moderation_private.is_database_owner() returns boolean
language sql stable security invoker set search_path = ''
as $$ select session_user='postgres' and current_setting('role') in ('none','postgres') $$;

create or replace function community_moderation_private.assert_database_owner() returns void
language plpgsql security invoker set search_path = ''
as $$ begin
  if not community_moderation_private.is_database_owner() then
    raise exception 'Trusted postgres database session required'; end if;
end $$;

-- Only the existing normalized-text exemptions gain an owner path. No
-- general bypass exists for social writes, memberships, consent or blocking.
create or replace function public.community_guard_content() returns trigger
language plpgsql security definer set search_path = ''
as $$ declare entry jsonb; begin
  if tg_table_name='profiles' then
    if tg_op='INSERT' or new.display_name is distinct from old.display_name then
      perform public.community_check_text(new.display_name);
      if tg_op<>'INSERT' and not ((public.community_is_moderator(auth.uid())
        or community_moderation_private.is_database_owner()) and new.display_name='Camper') then
        perform public.community_assert_social(new.id); end if;
    end if;
  elsif tg_table_name='shared_app_limits' then
    if new.apps is not null and new.apps<>'[]'::jsonb and (tg_op='INSERT' or new.apps is distinct from old.apps) then
      perform public.community_assert_social(new.user_id);
      for entry in select value from jsonb_array_elements(new.apps) loop
        perform public.community_check_text(entry->>'label'); end loop;
    end if;
  elsif tg_table_name='time_requests' then
    if tg_op='INSERT' then perform public.community_assert_social(new.requester_id); end if;
    if tg_op='INSERT' or new.reason is distinct from old.reason or new.category_label is distinct from old.category_label then
      perform public.community_check_text(new.reason); perform public.community_check_text(new.category_label);
      if not ((public.community_is_moderator(auth.uid()) or community_moderation_private.is_database_owner())
        and new.reason is null and new.category_label='Selected apps') then
        perform public.community_assert_social(new.requester_id); end if;
    end if;
    if tg_op='UPDATE' and old.status='pending' and new.status in ('approved','denied') then
      perform public.community_assert_social(new.requester_id);
      perform public.community_assert_social(new.decided_by);
    end if;
  elsif tg_table_name in ('camp_groups','circles') then
    if tg_op='INSERT' or new.name is distinct from old.name then
      perform public.community_check_text(new.name);
      if tg_op<>'INSERT' then perform public.community_assert_social(auth.uid()); end if;
    end if;
    if tg_table_name='circles' then
      if tg_op='INSERT' or new.policy_title is distinct from old.policy_title or new.policy_body is distinct from old.policy_body then
        perform public.community_check_text(new.policy_title); perform public.community_check_text(new.policy_body);
        if tg_op<>'INSERT' then perform public.community_assert_social(new.owner_id); end if;
      end if;
    end if;
  end if;
  return new;
end $$;

-- Single action implementation shared by the unchanged app RPC contract and
-- private SQL-editor entry point. Callers cannot supply an operator identity.
create or replace function community_moderation_private.review_core(actor uuid,as_database_owner boolean,
  report_id uuid,expected_version integer,action text,moderator_note text,restriction_days integer) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare report public.community_reports; clean_note text := btrim(coalesce(moderator_note,''));
  current_name text; current_labels jsonb; req public.time_requests; new_status text; operator_role text;
begin
  perform public.circle_safety_lock();
  if as_database_owner is true then
    perform community_moderation_private.assert_database_owner();
    if actor is not null then raise exception 'Database reviews do not impersonate an app account'; end if;
    operator_role := session_user;
  elsif as_database_owner is false then
    actor := public.circle_check_owner(actor);
    if not public.community_is_moderator(actor) then raise exception 'Moderator access required'; end if;
  else raise exception 'Choose a trusted review path'; end if;
  if action is null or action not in ('dismiss','remove_content','warn','restrict','restore') or char_length(clean_note)>500
    or regexp_replace(clean_note,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' then raise exception 'Choose a moderation action and a note of at most 500 characters.'; end if;
  if action in ('warn','restrict','restore') and clean_note='' then raise exception 'Explain this decision to the camper.'; end if;
  if action='restrict' and (restriction_days is null or restriction_days not between 1 and 365) then
    raise exception 'Choose a restriction from 1 to 365 days.'; end if;
  if action<>'restrict' and restriction_days is not null then raise exception 'Only restrictions have a duration.'; end if;
  -- Keep 0033's deletion-compatible lock order: global safety, target profile,
  -- report, then request/labels. Account deletion must remain ungated.
  select * into report from public.community_reports where id=report_id;
  if report.id is null then raise exception 'Report unavailable'; end if;
  perform 1 from public.profiles where id=report.target_user_id for no key update;
  select * into report from public.community_reports where id=report_id for update;
  if report.id is null then raise exception 'Report unavailable'; end if;
  if report.version=expected_version+1 and report.action=action and exists(select 1 from public.community_moderation_audit a
    where a.report_id=report.id and a.report_version=report.version and a.moderator_id is not distinct from actor
      and a.database_operator is not distinct from operator_role and a.note=clean_note
      and a.restriction_days is not distinct from review_core.restriction_days) then
    return jsonb_build_object('reportId',report.id,'status',report.status,'version',report.version); end if;
  if expected_version is null or report.version<>expected_version then raise exception 'This report changed. Refresh before reviewing it.'; end if;
  if report.status<>'open' and action<>'restore' then raise exception 'This report was already reviewed.'; end if;
  if action='restore' and not exists(select 1 from public.community_restrictions
    where user_id=report.target_user_id and source_report_id=report.id) then
    raise exception 'This report does not match the current social restriction. Refresh the queue.'; end if;
  if action='remove_content' then
    if report.kind='request' then
      select * into req from public.time_requests where id=report.target_request_id for update;
      if req.id is null or to_jsonb(req.reason) is distinct from nullif(report.snapshot->'requestReason','null'::jsonb)
        or req.category_label is distinct from report.snapshot->>'requestCategoryLabel' then
        raise exception 'The reported content has changed. Nothing was removed; refresh and review the current content.'; end if;
      update public.time_requests set reason=null,category_label='Selected apps' where id=req.id;
    else
      select display_name into current_name from public.profiles where id=report.target_user_id for no key update;
      select coalesce(apps,'[]'::jsonb) into current_labels from public.shared_app_limits where user_id=report.target_user_id for update;
      if current_name is distinct from report.snapshot->>'displayName'
        or coalesce(current_labels,'[]'::jsonb) is distinct from report.snapshot->'sharedLabels' then
        raise exception 'The reported content has changed. Nothing was removed; refresh and review the current content.'; end if;
      update public.profiles set display_name='Camper' where id=report.target_user_id;
      update public.shared_app_limits set apps=null,updated_at=clock_timestamp() where user_id=report.target_user_id;
    end if;
  elsif action='restrict' then
    insert into public.community_restrictions(user_id,reason,until_at,source_report_id)
      values(report.target_user_id,clean_note,clock_timestamp()+make_interval(days=>restriction_days),report.id)
      on conflict(user_id) do update set reason=excluded.reason,until_at=excluded.until_at,
        source_report_id=excluded.source_report_id,created_at=clock_timestamp();
  elsif action='restore' then
    delete from public.community_restrictions where user_id=report.target_user_id;
  end if;
  new_status := case when action='dismiss' then 'dismissed' else 'resolved' end;
  update public.community_reports set status=new_status,version=version+1,action=review_core.action
    where id=report.id returning * into report;
  insert into public.community_moderation_audit(report_id,moderator_id,database_operator,action,note,report_version,restriction_days)
    values(report.id,actor,operator_role,action,clean_note,report.version,restriction_days);
  if action in ('warn','restrict','restore','remove_content') then
    insert into public.community_notices(user_id,report_id,message) values(report.target_user_id,report.id,
      case when clean_note<>'' then clean_note else 'Reported shared text was removed because it broke the community rules.' end);
  end if;
  return jsonb_build_object('reportId',report.id,'status',report.status,'version',report.version);
end $$;

create or replace function public.review_moderation_report(expected_user_id uuid,report_id uuid,expected_version integer,
  action text,moderator_note text,restriction_days integer default null) returns jsonb
language sql security definer set search_path = ''
as $$ select community_moderation_private.review_core(expected_user_id,false,report_id,expected_version,action,moderator_note,restriction_days) $$;

create or replace function community_moderation_private.review_report(report_id uuid,expected_version integer,
  action text,moderator_note text,restriction_days integer default null) returns jsonb
language plpgsql security invoker set search_path = ''
as $$ begin
  perform community_moderation_private.assert_database_owner();
  return community_moderation_private.review_core(null,true,report_id,expected_version,action,moderator_note,restriction_days);
end $$;

-- Same minimum evidence projection as the app queue. Intentionally excludes
-- reporter ID, friend/login codes, auth metadata, app tokens and usage data.
create or replace function community_moderation_private.report_summary(report public.community_reports) returns jsonb
language sql stable security invoker set search_path = ''
as $$ select jsonb_build_object('id',report.id,'targetUserId',report.target_user_id,
  'targetDisplayName',report.snapshot->>'displayName','kind',report.kind,'reason',report.reason,'details',report.details,
  'snapshot',report.snapshot,'status',report.status,'createdAt',report.created_at,'version',report.version,'action',report.action) $$;

create or replace function community_moderation_private.queue(status_filter text default 'open',
  after_created_at timestamptz default null,after_id uuid default null) returns jsonb
language plpgsql security invoker set search_path = ''
as $$ begin
  perform community_moderation_private.assert_database_owner();
  if status_filter is null or status_filter not in ('open','resolved','dismissed') then raise exception 'Invalid report status'; end if;
  if (after_created_at is null)<>(after_id is null) or (after_created_at is not null and not isfinite(after_created_at)) then
    raise exception 'Provide both fields of a valid report cursor.'; end if;
  return (select coalesce(jsonb_agg(community_moderation_private.report_summary(r) order by r.created_at,r.id),'[]'::jsonb)
    from (select r.* from public.community_reports r where r.status=status_filter
      and (after_created_at is null or (r.created_at,r.id)>(after_created_at,after_id))
      order by r.created_at,r.id limit 100) r);
end $$;

-- Email is untrusted intake, not authority. Look up the server report UUID
-- from the email, or the target's PUBLIC friend code for an appeal without a
-- receipt. Supplying both filters requires both to match. Never request a
-- private login key. This lookup exposes no reporter identity or login data.
create or replace function community_moderation_private.find_reports(report_reference uuid default null,
  target_friend_code text default null,after_created_at timestamptz default null,after_id uuid default null) returns jsonb
language plpgsql security invoker set search_path = ''
as $$ declare target uuid; clean_code text := upper(btrim(target_friend_code)); begin
  perform community_moderation_private.assert_database_owner();
  if report_reference is null and nullif(clean_code,'') is null then raise exception 'Provide a report reference or public friend code'; end if;
  if target_friend_code is not null then
    if clean_code='' or char_length(clean_code)>64 then raise exception 'Use a public friend code, never a login key'; end if;
    select p.id into target from public.profiles p where upper(p.friend_code)=clean_code;
    if target is null then return '[]'::jsonb; end if;
  end if;
  if (after_created_at is null)<>(after_id is null) or (after_created_at is not null and not isfinite(after_created_at)) then
    raise exception 'Provide both fields of a valid report cursor.'; end if;
  return (select coalesce(jsonb_agg(community_moderation_private.report_summary(r) || jsonb_build_object(
      'currentRestriction',(select jsonb_build_object('sourceReportId',s.source_report_id,'reason',s.reason,'until',s.until_at)
        from public.community_restrictions s where s.user_id=r.target_user_id and (s.until_at is null or s.until_at>clock_timestamp())),
      'reviewHistory',(select coalesce(jsonb_agg(jsonb_build_object('action',a.action,'note',a.note,
        'restrictionDays',a.restriction_days,'version',a.report_version,'reviewedAt',a.created_at,
        'actorType',case when a.database_operator is null then 'app_moderator' else 'database_owner' end,
        'databaseOperator',a.database_operator) order by a.report_version),'[]'::jsonb)
        from public.community_moderation_audit a where a.report_id=r.id)) order by r.created_at,r.id),'[]'::jsonb)
    from (select r.* from public.community_reports r
      where (report_reference is null or r.id=report_reference) and (target is null or r.target_user_id=target)
        and (after_created_at is null or (r.created_at,r.id)>(after_created_at,after_id))
      order by r.created_at,r.id limit 100) r);
end $$;

-- Explicitly defeat permissive default function privileges, including direct
-- function access even if this schema were accidentally added to API schemas.
revoke all on all functions in schema community_moderation_private from public,anon,authenticated,service_role;
revoke all on function public.community_guard_content() from public,anon,authenticated,service_role;
revoke all on function public.review_moderation_report(uuid,uuid,integer,text,text,integer) from public,anon,service_role;
-- Preserve 0033's existing authenticated RPC grant; add no grants here.
comment on schema community_moderation_private is
  'Existing postgres database owner only. Do not expose in PostgREST or grant API-role access. Manual human review; no email-triggered actions.';
