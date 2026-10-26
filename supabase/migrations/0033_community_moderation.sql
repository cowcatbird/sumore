-- HOLD FOR COORDINATED CLIENT RELEASE. Old clients cannot accept the rules and
-- will receive a clear refusal for social writes after this migration. No live
-- deployment, moderator enrollment, existing-content backfill, or wallet reset.
-- Moderators are explicitly enrolled by a trusted database owner using a known
-- auth UUID, NEVER email/metadata/first-signup heuristics. All public clients,
-- including moderators, use authenticated RPCs; no service key belongs in UI.

create table if not exists public.community_rule_acceptances (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  version text not null check (version = '2026-10-12'),
  accepted_at timestamptz not null default clock_timestamp()
);
create table if not exists public.community_moderators (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
create table if not exists public.community_restrictions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 500),
  until_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create table if not exists public.community_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  target_user_id uuid not null references public.profiles(id) on delete cascade,
  target_request_id uuid references public.time_requests(id) on delete cascade,
  client_report_id uuid not null,
  kind text not null check (kind in ('person','request')),
  reason text not null check (reason in ('offensive_content','harassment','spam','other')),
  details text not null check (char_length(details) <= 500),
  snapshot jsonb not null,
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  version integer not null default 1 check (version > 0),
  action text check (action in ('dismiss','remove_content','warn','restrict','restore')),
  created_at timestamptz not null default clock_timestamp(),
  unique (reporter_id, client_report_id),
  check (reporter_id <> target_user_id),
  check ((kind = 'request') = (target_request_id is not null))
);
create index if not exists community_reports_queue_idx on public.community_reports(status,created_at,id);
create index if not exists community_reports_rate_idx on public.community_reports(reporter_id,created_at);
-- Keep receipt aliases when identical content is deduplicated. A retry with
-- the same client ID must not turn into a second report if text changes later.
create table if not exists public.community_report_receipts (
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  client_report_id uuid not null,
  report_id uuid not null references public.community_reports(id) on delete cascade,
  submission jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(reporter_id,client_report_id)
);
alter table public.community_restrictions add column if not exists source_report_id uuid;
-- A restriction must always retain its review/appeal source. If that report is
-- deleted (including reporter account deletion), lift the restriction rather
-- than leaving an unexplained orphan that moderators cannot restore in-app.
alter table public.community_restrictions drop constraint if exists community_restrictions_source_report_id_fkey;
alter table public.community_restrictions add constraint community_restrictions_source_report_id_fkey
  foreign key(source_report_id) references public.community_reports(id) on delete cascade;
alter table public.community_restrictions alter column source_report_id set not null;
create table if not exists public.community_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  report_id uuid not null references public.community_reports(id) on delete cascade,
  message text not null check (char_length(message) between 1 and 500),
  created_at timestamptz not null default clock_timestamp()
);
create table if not exists public.community_moderation_audit (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.community_reports(id) on delete cascade,
  moderator_id uuid references public.profiles(id) on delete set null,
  action text not null,
  note text not null check (char_length(note) <= 500),
  restriction_days integer,
  report_version integer not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (report_id,report_version)
);
-- RLS plus zero table grants: neither reporters nor targets can enumerate
-- reports, reporter identities, restrictions, moderators, or audit history.
do $$ declare t text; begin
  foreach t in array array['community_rule_acceptances','community_moderators',
    'community_restrictions','community_reports','community_report_receipts','community_notices','community_moderation_audit'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  end loop;
end $$;

create or replace function public.community_is_moderator(actor uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select actor is not null and exists(select 1 from public.community_moderators where user_id=actor) $$;
create or replace function public.community_is_restricted(actor uuid) returns boolean
language sql volatile security definer set search_path = ''
as $$ select exists(select 1 from public.community_restrictions where user_id=actor
  and (until_at is null or until_at > clock_timestamp())) $$;
create or replace function public.community_assert_social(actor uuid) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  if actor is null or not exists(select 1 from public.profiles where id=actor) then
    raise exception 'Authentication required'; end if;
  if public.community_is_restricted(actor) then
    raise exception 'Social features are restricted. View the notice in Setup for details and appeal options.'; end if;
  if not exists(select 1 from public.community_rule_acceptances where user_id=actor and version='2026-10-12') then
    raise exception 'Please accept the community rules before sharing with your circle.'; end if;
end $$;
-- Match whole English words rather than substrings or names.
-- Reports and human review handle context and evasion.
create or replace function public.community_check_text(value text) returns void
language plpgsql immutable security definer set search_path = ''
as $$ begin
  if lower(coalesce(value,'')) ~ '(^|[^[:alnum:]_])(fuck|fucking|motherfucker|cunt|nigger|niggers|faggot|faggots)([^[:alnum:]_]|$)'
    or lower(coalesce(value,'')) ~ '(^|[^[:alnum:]_])(kill yourself|go kill yourself)([^[:alnum:]_]|$)' then
    raise exception 'Please change this wording before sharing it with your circle.';
  end if;
end $$;

create or replace function public.get_my_moderation_status(expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor uuid; begin
  actor := public.circle_check_owner(expected_user_id);
  return jsonb_build_object('rulesVersion','2026-10-12',
    'acceptedRulesVersion',(select version from public.community_rule_acceptances where user_id=actor),
    'isModerator',public.community_is_moderator(actor),
    'restriction',(select jsonb_build_object('reason',reason,'until',until_at,'createdAt',created_at)
      from public.community_restrictions where user_id=actor and (until_at is null or until_at>clock_timestamp())),
    'notices',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'message',message,'createdAt',created_at)
      order by created_at desc,id),'[]'::jsonb) from (select * from public.community_notices
        where user_id=actor order by created_at desc,id limit 20) n));
end $$;
create or replace function public.accept_community_rules(rules_version text,expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor uuid; begin
  perform public.circle_safety_lock();
  actor := public.circle_check_owner(expected_user_id);
  if rules_version is distinct from '2026-10-12' then raise exception 'Refresh to see the latest community rules.'; end if;
  insert into public.community_rule_acceptances(user_id,version) values(actor,rules_version)
    on conflict(user_id) do update set version=excluded.version,accepted_at=clock_timestamp()
      where community_rule_acceptances.version is distinct from excluded.version;
  return public.get_my_moderation_status(actor);
end $$;

-- Retain existing function bodies/compatibility paths under private names.
-- The first global safety lock precedes social-row locks and admin review.
-- Reapplying 0033 never renames wrappers onto themselves.
do $$ declare item text[]; begin
  foreach item slice 1 in array array[
    ['update_my_profile_name','text'], ['update_group_policy','text,text'], ['set_shared_app_limits','jsonb,integer,uuid'],
    ['join_shared_circle_v5','text'], ['create_circle_invite',''], ['add_friend_by_code','text'],
    ['redeem_circle_invite','text'], ['respond_to_circle_invite','uuid,boolean'],
    ['create_time_request','smallint,text,text'], ['decide_time_request','uuid,public.recipient_decision']
  ] loop
    if to_regprocedure('public.community_base_'||item[1]||'('||item[2]||')') is null then
      execute format('alter function public.%I(%s) rename to %I',item[1],item[2],'community_base_'||item[1]);
    end if;
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated,service_role',
      'community_base_'||item[1],item[2]);
  end loop;
end $$;
create or replace function public.update_my_profile_name(new_display_name text) returns void
language plpgsql security definer set search_path = '' as $$ begin
  perform public.circle_safety_lock(); perform public.community_assert_social(auth.uid());
  perform public.community_base_update_my_profile_name(new_display_name);
end $$;
create or replace function public.update_group_policy(new_title text,new_body text) returns void
language plpgsql security definer set search_path = '' as $$ begin
  perform public.circle_safety_lock(); perform public.community_assert_social(auth.uid());
  perform public.community_base_update_group_policy(new_title,new_body);
end $$;
create or replace function public.set_shared_app_limits(entries jsonb default null, allocation_minutes integer default null,
  expected_user_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
  perform public.circle_safety_lock();
  if entries is not null and entries <> 'null'::jsonb and entries <> '[]'::jsonb then
    perform public.community_assert_social(auth.uid()); end if;
  return public.community_base_set_shared_app_limits(entries,allocation_minutes,expected_user_id);
end $$;
create or replace function public.join_shared_circle_v5(friend_code_input text) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
  perform public.circle_safety_lock(); perform public.community_assert_social(auth.uid());
  return public.community_base_join_shared_circle_v5(friend_code_input);
end $$;
create or replace function public.create_circle_invite() returns text
language plpgsql security definer set search_path = '' as $$ begin
  perform public.circle_safety_lock(); perform public.community_assert_social(auth.uid());
  return public.community_base_create_circle_invite();
end $$;
create or replace function public.add_friend_by_code(friend_code_input text) returns void
language plpgsql security definer set search_path = '' as $$ begin
  perform public.circle_safety_lock(); perform public.community_assert_social(auth.uid());
  perform public.community_base_add_friend_by_code(friend_code_input);
end $$;
create or replace function public.redeem_circle_invite(invite_code text) returns void
language plpgsql security definer set search_path = '' as $$ begin
  perform public.circle_safety_lock(); perform public.community_assert_social(auth.uid());
  perform public.community_base_redeem_circle_invite(invite_code);
end $$;
create or replace function public.respond_to_circle_invite(membership_id uuid,accept_invite boolean) returns void
language plpgsql security definer set search_path = '' as $$ begin
  perform public.circle_safety_lock();
  if accept_invite then perform public.community_assert_social(auth.uid()); end if;
  perform public.community_base_respond_to_circle_invite(membership_id,accept_invite);
end $$;
create or replace function public.create_time_request(requested_minutes smallint,request_reason text default null,
  request_category_label text default 'Selected apps') returns uuid
language plpgsql security definer set search_path = '' as $$ begin
  perform public.circle_safety_lock(); perform public.community_assert_social(auth.uid());
  return public.community_base_create_time_request(requested_minutes,request_reason,request_category_label);
end $$;
create or replace function public.decide_time_request(target_request_id uuid,requested_decision public.recipient_decision)
returns public.time_requests language plpgsql security definer set search_path = '' as $$ begin
  perform public.circle_safety_lock(); perform public.community_assert_social(auth.uid());
  return public.community_base_decide_time_request(target_request_id,requested_decision);
end $$;

-- Guards also cover legacy private writers and future accidental write grants.
-- No gate applies to avatar-only edits, clearing labels, numeric totals,
-- cancelling/expiring requests, leaving/blocking, account cascades or panic.
create or replace function public.community_guard_content() returns trigger
language plpgsql security definer set search_path = ''
as $$ declare entry jsonb; begin
  if tg_table_name='profiles' then
    if tg_op='INSERT' or new.display_name is distinct from old.display_name then
      perform public.community_check_text(new.display_name);
      if tg_op<>'INSERT' and not (public.community_is_moderator(auth.uid()) and new.display_name='Camper') then
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
      if not (public.community_is_moderator(auth.uid()) and new.reason is null and new.category_label='Selected apps') then
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
create or replace function public.community_guard_membership() returns trigger
language plpgsql security definer set search_path = ''
as $$ declare peer uuid; begin
  if tg_table_name='camp_group_members' then
    -- A fresh solo group (including panic/leave) is always allowed.
    if exists(select 1 from public.camp_group_members where group_id=new.group_id and user_id<>new.user_id) then
      perform public.community_assert_social(new.user_id);
      for peer in select user_id from public.camp_group_members where group_id=new.group_id and user_id<>new.user_id loop
        if public.community_is_restricted(peer) then raise exception 'That circle is unavailable'; end if;
        perform public.community_assert_social(peer);
      end loop;
    end if;
  elsif tg_table_name='circle_members' and new.status in ('invited','active') then
    perform public.community_assert_social(new.user_id);
    perform public.community_assert_social(new.invited_by);
    select owner_id into peer from public.circles where id=new.circle_id;
    if public.community_is_restricted(peer) then raise exception 'That circle is unavailable'; end if;
  elsif tg_table_name='circle_invites' then
    perform public.community_assert_social(new.created_by);
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['profiles','shared_app_limits','time_requests','camp_groups','circles'] loop
    execute format('drop trigger if exists community_content_guard on public.%I',t);
    execute format('create trigger community_content_guard before insert or update on public.%I for each row execute function public.community_guard_content()',t);
  end loop;
  foreach t in array array['camp_group_members','circle_members','circle_invites'] loop
    execute format('drop trigger if exists community_membership_guard on public.%I',t);
    execute format('create trigger community_membership_guard before insert or update on public.%I for each row execute function public.community_guard_membership()',t);
  end loop;
  -- Include separately tracked column grants, not only table-level ACLs.
  foreach t in array array['profiles','shared_app_limits','time_requests','request_recipients','camp_groups',
    'camp_group_members','circles','circle_members','circle_invites'] loop
    execute format('revoke insert,update,delete,truncate,references,trigger on public.%I from public,anon,authenticated',t);
    execute (select format('revoke insert (%s),update (%s),references (%s) on public.%I from public,anon,authenticated',
      string_agg(quote_ident(column_name),','),string_agg(quote_ident(column_name),','),string_agg(quote_ident(column_name),','),t)
      from information_schema.columns where table_schema='public' and table_name=t);
  end loop;
end $$;

create or replace function public.submit_circle_report(expected_user_id uuid,expected_group_id uuid,target_user_id uuid,
  target_request_id uuid,reason text,details text,client_report_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor uuid; snap jsonb; existing public.community_reports; report_key uuid; req public.time_requests;
  clean_details text := btrim(coalesce(details,'')); saved_receipt public.community_report_receipts; submission jsonb;
begin
  perform public.circle_safety_lock(); actor := public.circle_check_owner(expected_user_id);
  if client_report_id is null or reason is null or reason not in ('offensive_content','harassment','spam','other')
    or char_length(clean_details)>500 or regexp_replace(clean_details,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' then
    raise exception 'Choose a report reason and use at most 500 characters.'; end if;
  -- Exact retry succeeds even after a block/leave. It discloses only the
  -- caller's opaque receipt and cannot alter an already-submitted report.
  submission := jsonb_build_object('targetUserId',target_user_id,'targetRequestId',target_request_id,'reason',reason,'details',clean_details);
  select * into saved_receipt from public.community_report_receipts r
    where r.reporter_id=actor and r.client_report_id=submit_circle_report.client_report_id;
  if saved_receipt.report_id is not null then
    if saved_receipt.submission is distinct from submission then
      raise exception 'That report reference was already used. Please try again.'; end if;
    return jsonb_build_object('reportId',saved_receipt.report_id,'status','received');
  end if;
  if target_user_id is null or target_user_id=actor or expected_group_id is null
    or not exists(select 1 from public.camp_group_members where user_id=actor and group_id=expected_group_id)
    or not public.circle_pair_current(actor,target_user_id) then raise exception 'That camper is no longer in your circle.'; end if;
  -- Server snapshots only the exact fields the reporter can already see.
  select jsonb_build_object('displayName',p.display_name,
    'sharedLabels',coalesce((select apps from public.shared_app_limits where user_id=p.id),'[]'::jsonb))
    into snap from public.profiles p where p.id=submit_circle_report.target_user_id;
  if target_request_id is not null then
    select * into req from public.time_requests t where t.id=submit_circle_report.target_request_id and t.requester_id=submit_circle_report.target_user_id
      and exists(select 1 from public.request_recipients where request_id=t.id and recipient_id=actor);
    if req.id is null then raise exception 'That request is not available to report.'; end if;
    snap := snap || jsonb_build_object('requestReason',req.reason,'requestCategoryLabel',req.category_label);
  end if;
  -- Duplicate content does not spend another rate-limit slot or make another
  -- moderator item. Multiple reports NEVER trigger automatic punishment.
  select * into existing from public.community_reports r where r.reporter_id=actor
    and r.target_user_id=submit_circle_report.target_user_id
    and r.target_request_id is not distinct from submit_circle_report.target_request_id
    and r.status='open' and r.reason=submit_circle_report.reason and r.details=clean_details
    and r.snapshot=snap and r.created_at>clock_timestamp()-interval '24 hours'
    order by r.created_at desc limit 1;
  -- Bounded aliases prevent repeatedly submitting identical content from
  -- growing storage forever. Exact retries above never consume this limit.
  if (select count(*) from public.community_report_receipts where reporter_id=actor and created_at>clock_timestamp()-interval '24 hours')>=20 then
    raise exception 'Please wait before submitting another report. You can still block someone.'; end if;
  if existing.id is not null then
    insert into public.community_report_receipts(reporter_id,client_report_id,report_id,submission)
      values(actor,client_report_id,existing.id,submission);
    return jsonb_build_object('reportId',existing.id,'status','received'); end if;
  if (select count(*) from public.community_reports where reporter_id=actor and created_at>clock_timestamp()-interval '24 hours')>=5 then
    raise exception 'You have sent several reports today. Please wait before sending another. You can still block someone.'; end if;
  insert into public.community_reports(reporter_id,target_user_id,target_request_id,client_report_id,kind,reason,details,snapshot)
    values(actor,target_user_id,target_request_id,client_report_id,case when target_request_id is null then 'person' else 'request' end,
      reason,clean_details,snap) returning id into report_key;
  insert into public.community_report_receipts(reporter_id,client_report_id,report_id,submission)
    values(actor,client_report_id,report_key,submission);
  return jsonb_build_object('reportId',report_key,'status','received');
end $$;

-- Remove the pre-pagination signature, not an additional ambiguous PostgREST
-- overload. This remains safe on replay and one/two-argument callers use the
-- defaults of the new four-argument function.
drop function if exists public.get_moderation_queue(uuid,text);
create or replace function public.get_moderation_queue(expected_user_id uuid,status_filter text default 'open',
  after_created_at timestamptz default null,after_id uuid default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor uuid; begin
  actor := public.circle_check_owner(expected_user_id);
  if not public.community_is_moderator(actor) then raise exception 'Moderator access required'; end if;
  if status_filter is null or status_filter not in ('open','resolved','dismissed') then raise exception 'Invalid report status'; end if;
  if (after_created_at is null)<>(after_id is null) or (after_created_at is not null and not isfinite(after_created_at)) then
    raise exception 'Provide both fields of a valid report cursor.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'targetUserId',target_user_id,
    'targetDisplayName',snapshot->>'displayName','kind',kind,'reason',reason,'details',details,
    'snapshot',snapshot,'status',status,'createdAt',created_at,'version',version,'action',action)
    order by created_at,id),'[]'::jsonb) from (select * from public.community_reports where status=status_filter
      and (after_created_at is null or (created_at,id)>(after_created_at,after_id))
      order by created_at,id limit 100) r);
end $$;

create or replace function public.review_moderation_report(expected_user_id uuid,report_id uuid,expected_version integer,
  action text,moderator_note text,restriction_days integer default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor uuid; report public.community_reports; clean_note text := btrim(coalesce(moderator_note,''));
  current_name text; current_labels jsonb; req public.time_requests; new_status text;
begin
  perform public.circle_safety_lock(); actor := public.circle_check_owner(expected_user_id);
  if not public.community_is_moderator(actor) then raise exception 'Moderator access required'; end if;
  if action is null or action not in ('dismiss','remove_content','warn','restrict','restore') or char_length(clean_note)>500
    or regexp_replace(clean_note,E'[\n\r\t]','','g') ~ '[[:cntrl:]]' then raise exception 'Choose a moderation action and a note of at most 500 characters.'; end if;
  if action in ('warn','restrict','restore') and clean_note='' then raise exception 'Explain this decision to the camper.'; end if;
  if action='restrict' and (restriction_days is null or restriction_days not between 1 and 365) then
    raise exception 'Choose a restriction from 1 to 365 days.'; end if;
  if action<>'restrict' and restriction_days is not null then raise exception 'Only restrictions have a duration.'; end if;
  -- Lock the target BEFORE the report. Account deletion locks its profile
  -- before cascading report rows; reversing this order would deadlock review
  -- against deletion. Never add a consent/restriction gate to deletion.
  select * into report from public.community_reports where id=report_id;
  if report.id is null then raise exception 'Report unavailable'; end if;
  perform 1 from public.profiles where id=report.target_user_id for no key update;
  select * into report from public.community_reports where id=report_id for update;
  if report.id is null then raise exception 'Report unavailable'; end if;
  -- Retrying the same last action is harmless, including no duplicate notice
  -- and no renewed restriction timer. A conflicting/stale review is rejected.
  if report.version=expected_version+1 and report.action=action and exists(select 1 from public.community_moderation_audit a
    where a.report_id=report.id and a.report_version=report.version and a.moderator_id=actor and a.note=clean_note
      and a.restriction_days is not distinct from review_moderation_report.restriction_days) then
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
  update public.community_reports set status=new_status,version=version+1,action=review_moderation_report.action
    where id=report.id returning * into report;
  insert into public.community_moderation_audit(report_id,moderator_id,action,note,report_version,restriction_days)
    values(report.id,actor,action,clean_note,report.version,restriction_days);
  if action in ('warn','restrict','restore','remove_content') then
    insert into public.community_notices(user_id,report_id,message) values(report.target_user_id,report.id,
      case when clean_note<>'' then clean_note else 'Reported shared text was removed because it broke the community rules.' end);
  end if;
  return jsonb_build_object('reportId',report.id,'status',report.status,'version',report.version);
end $$;

-- Trusted scheduled maintenance only; no public endpoint. The release owner
-- must schedule this (for example daily via pg_cron) before claiming timed
-- deletion is automatic. Open reports remain for manual review. Closed items
-- and their notices/audit are removed after 90 days, unless still the source
-- of an active restriction. Limit each run to 1000 rows to bound work.
create or replace function public.purge_expired_community_reports() returns integer
language plpgsql security definer set search_path = ''
as $$ declare removed integer; begin
  perform public.circle_safety_lock();
  with expired as (
    select r.id from public.community_reports r
    where r.status in ('resolved','dismissed')
      and coalesce((select max(created_at) from public.community_moderation_audit where report_id=r.id),r.created_at)
        < clock_timestamp()-interval '90 days'
      and not exists(select 1 from public.community_restrictions s where s.source_report_id=r.id
        and (s.until_at is null or s.until_at>clock_timestamp()))
    order by r.created_at,r.id limit 1000
  ) delete from public.community_reports where id in (select id from expired);
  get diagnostics removed = row_count;
  return removed;
end $$;
revoke all on function public.purge_expired_community_reports() from public,anon,authenticated,service_role;
grant execute on function public.purge_expired_community_reports() to service_role;

revoke all on function public.community_is_moderator(uuid),public.community_is_restricted(uuid),
  public.community_assert_social(uuid),public.community_check_text(text),public.community_guard_content(),
  public.community_guard_membership() from public,anon,authenticated,service_role;
revoke all on function public.get_my_moderation_status(uuid),public.accept_community_rules(text,uuid),
  public.submit_circle_report(uuid,uuid,uuid,uuid,text,text,uuid),public.get_moderation_queue(uuid,text,timestamptz,uuid),
  public.review_moderation_report(uuid,uuid,integer,text,text,integer),public.update_my_profile_name(text),public.update_group_policy(text,text),
  public.set_shared_app_limits(jsonb,integer,uuid),public.join_shared_circle_v5(text),public.create_circle_invite(),
  public.add_friend_by_code(text),public.redeem_circle_invite(text),public.respond_to_circle_invite(uuid,boolean),
  public.create_time_request(smallint,text,text),public.decide_time_request(uuid,public.recipient_decision)
  from public,anon,authenticated,service_role;
grant execute on function public.get_my_moderation_status(uuid),public.accept_community_rules(text,uuid),
  public.submit_circle_report(uuid,uuid,uuid,uuid,text,text,uuid),public.get_moderation_queue(uuid,text,timestamptz,uuid),
  public.review_moderation_report(uuid,uuid,integer,text,text,integer),public.update_my_profile_name(text),public.update_group_policy(text,text),
  public.set_shared_app_limits(jsonb,integer,uuid),public.join_shared_circle_v5(text),public.create_circle_invite(),
  public.add_friend_by_code(text),public.redeem_circle_invite(text),public.respond_to_circle_invite(uuid,boolean),
  public.create_time_request(smallint,text,text),public.decide_time_request(uuid,public.recipient_decision) to authenticated;

comment on table public.community_moderators is 'Trusted owner enrollment by verified auth UUID only. Do not expose table grants or an enrollment RPC.';
comment on table public.community_reports is 'Private user reports. No automatic punishments. Deleted with reporter or target account; never stores login keys, app tokens, usage history or push tokens.';
