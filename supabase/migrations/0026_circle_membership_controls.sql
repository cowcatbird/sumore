-- Local release candidate: leave/block only. No reporting, backfill, wallet
-- reset, grant revocation, or dependency on the provisional 0025 balance.
-- Safety mutations acquire one transaction mutex BEFORE other row locks.
-- This modest serialization deliberately favors correctness over throughput.
create table public.circle_blocks (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  target_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key (owner_id, target_id),
  check (owner_id <> target_id)
);
create index circle_blocks_target_idx on public.circle_blocks(target_id, owner_id);
alter table public.circle_blocks enable row level security;
revoke all on public.circle_blocks from public, anon, authenticated, service_role;
grant select on public.circle_blocks to authenticated;
create policy "only the blocker reads their list" on public.circle_blocks
  for select to authenticated using (owner_id = auth.uid());

create function public.circle_safety_lock() returns void
language sql volatile security definer set search_path = ''
as $$ select pg_advisory_xact_lock(1937075567, 26) $$;
create function public.circle_pair_blocked(first_id uuid, second_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.circle_blocks
  where (owner_id = first_id and target_id = second_id)
     or (owner_id = second_id and target_id = first_id)) $$;
create function public.circle_pair_current(first_id uuid, second_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select first_id <> second_id and not public.circle_pair_blocked(first_id,second_id)
  and exists(select 1 from public.camp_group_members a join public.camp_group_members b
    on a.group_id = b.group_id where a.user_id = first_id and b.user_id = second_id) $$;
-- RLS exposes only a caller-relative predicate, never another person's list.
create function public.circle_can_view_person(target_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select auth.uid() is not null and (target_id = auth.uid()
  or not public.circle_pair_blocked(auth.uid(),target_id)) $$;
create policy "blocked profiles stay private" on public.profiles as restrictive
  for select to authenticated using (public.circle_can_view_person(id));
create policy "blocked legacy memberships stay private" on public.circle_members as restrictive
  for select to authenticated using (public.circle_can_view_person(user_id)
    and public.circle_can_view_person(invited_by));
create policy "blocked legacy circles stay private" on public.circles as restrictive
  for select to authenticated using (public.circle_can_view_person(owner_id));
create or replace function public.is_request_recipient(target_request_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists(select 1 from public.request_recipients r join public.time_requests t
  on t.id = r.request_id where r.request_id = target_request_id and r.recipient_id = auth.uid()
    and public.circle_pair_current(t.requester_id, auth.uid())) $$;
create policy "recipient boundary remains current" on public.request_recipients as restrictive
  for select to authenticated using (public.is_request_owner(request_id)
    or public.is_request_recipient(request_id));

-- RPC-only writes prevent bypassing the mutex using PostgREST table endpoints.
revoke insert, update, delete, truncate, references, trigger on
  public.camp_group_members, public.circle_members, public.time_requests,
  public.request_recipients from public, anon, authenticated;

create function public.circle_guard_camp_membership() returns trigger
language plpgsql security definer set search_path = ''
as $$ begin
  if exists(select 1 from public.camp_group_members m where m.group_id = new.group_id
    and m.user_id <> new.user_id and public.circle_pair_blocked(m.user_id,new.user_id)) then
    raise exception 'That circle is unavailable';
  end if;
  return new;
end $$;
create trigger circle_block_guard before insert or update of group_id, user_id
  on public.camp_group_members for each row execute function public.circle_guard_camp_membership();
create function public.circle_guard_legacy_membership() returns trigger
language plpgsql security definer set search_path = ''
as $$ begin
  if new.status in ('active','invited') and (
    exists(select 1 from public.circles c where c.id = new.circle_id
      and public.circle_pair_blocked(new.user_id,c.owner_id))
    or exists(select 1 from public.circle_members m where m.circle_id = new.circle_id
      and m.user_id <> new.user_id and m.status in ('active','invited')
      and public.circle_pair_blocked(new.user_id,m.user_id))
  ) then raise exception 'That circle is unavailable'; end if;
  return new;
end $$;
create trigger circle_block_guard before insert or update of circle_id,user_id,status
  on public.circle_members for each row execute function public.circle_guard_legacy_membership();

-- Remove the caller's old legacy connections, not third parties' memberships.
-- An owner's conceptual seat is not a circle_members row, hence the second delete.
create function public.circle_disconnect_legacy(actor_id uuid, peer_ids uuid[]) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  delete from public.circle_members m where m.user_id = actor_id and (
    exists(select 1 from public.circles c where c.id = m.circle_id and c.owner_id = any(peer_ids))
    or exists(select 1 from public.circle_members p where p.circle_id = m.circle_id
      and p.user_id = any(peer_ids) and p.status in ('active','invited')));
  delete from public.circle_members m using public.circles c
    where m.circle_id = c.id and c.owner_id = actor_id and m.user_id = any(peer_ids);
end $$;
create function public.circle_prune_pending(actor_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$ declare affected uuid[];
begin
  select coalesce(array_agg(distinct t.id),'{}'::uuid[]) into affected
  from public.time_requests t left join public.request_recipients r on r.request_id = t.id
  where t.status = 'pending' and (t.requester_id = actor_id or r.recipient_id = actor_id);
  delete from public.request_recipients r using public.time_requests t
    where t.id = r.request_id and t.id = any(affected) and t.status = 'pending'
      and not public.circle_pair_current(t.requester_id,r.recipient_id);
  update public.time_requests t set status = 'cancelled'
    where t.id = any(affected) and t.status = 'pending'
      and not exists(select 1 from public.request_recipients r where r.request_id = t.id);
end $$;

create function public.circle_check_owner(expected_user_id uuid) returns uuid
language plpgsql security definer set search_path = ''
as $$ begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if expected_user_id is null or expected_user_id <> auth.uid() then
    raise exception 'Your account changed. Refresh and try again';
  end if;
  perform 1 from public.profiles where id = auth.uid() for no key update;
  if not found then raise exception 'Account unavailable'; end if;
  return auth.uid();
end $$;

create function public.get_blocked_people(expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor_id uuid;
begin
  actor_id := public.circle_check_owner(expected_user_id);
  return (select coalesce(jsonb_agg(jsonb_build_object('id',p.id,
    'displayName',p.display_name,'blockedAt',b.created_at) order by b.created_at desc,p.id),'[]'::jsonb)
    from public.circle_blocks b join public.profiles p on p.id = b.target_id where b.owner_id = actor_id);
end $$;

-- Caller already holds safety mutex and their profile lock. No ensure_group:
-- leaving must never run the legacy starter-wallet/default-balance path.
create function public.circle_leave_locked(actor_id uuid, expected_group_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare old_group uuid; new_group uuid; peers uuid[]; zone text; sampled_at timestamptz;
begin
  select group_id into old_group from public.camp_group_members where user_id = actor_id;
  if expected_group_id is null or old_group is null or expected_group_id <> old_group then
    raise exception 'Your circle changed. Refresh and try again';
  end if;
  select time_zone into zone from public.camp_groups where id = old_group for update;
  select coalesce(array_agg(user_id),'{}'::uuid[]) into peers from public.camp_group_members
    where group_id = old_group and user_id <> actor_id;
  if cardinality(peers) = 0 then
    return jsonb_build_object('circleShop',public.camp_shop_payload(old_group),'leftCircle',false);
  end if;
  sampled_at := public.camp_now();
  insert into public.camp_groups(time_zone,balance,initialized_at,last_settled_day)
    values(zone,0,sampled_at,(sampled_at at time zone zone)::date - 1) returning id into new_group;
  -- Existing roster trigger settles old history and makes BOTH partial days
  -- ineligible. New group is private/uncontended; no lock-order inversion.
  update public.camp_group_members set group_id = new_group where user_id = actor_id;
  perform public.circle_disconnect_legacy(actor_id,peers);
  perform public.circle_prune_pending(actor_id);
  return jsonb_build_object('circleShop',public.camp_shop_payload(new_group),'leftCircle',true);
end $$;
create function public.leave_shared_circle(expected_group_id uuid, expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor_id uuid;
begin
  perform public.circle_safety_lock();
  actor_id := public.circle_check_owner(expected_user_id);
  return public.circle_leave_locked(actor_id,expected_group_id);
end $$;

create function public.block_circle_person(target_user_id uuid, expected_group_id uuid, expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor_id uuid := auth.uid(); group_key uuid; result jsonb;
begin
  perform public.circle_safety_lock();
  if actor_id is null then raise exception 'Authentication required'; end if;
  if expected_user_id is null or expected_user_id <> actor_id then
    raise exception 'Your account changed. Refresh and try again'; end if;
  if target_user_id is null or target_user_id = actor_id then raise exception 'Choose another camper'; end if;
  -- Sorted two-profile lock order matches join and prevents cross-block cycles.
  perform 1 from public.profiles where id in (actor_id,target_user_id) order by id for no key update;
  if not exists(select 1 from public.profiles where id = actor_id)
    or not exists(select 1 from public.profiles where id = target_user_id) then raise exception 'Camper unavailable'; end if;
  select group_id into group_key from public.camp_group_members where user_id = actor_id;
  if expected_group_id is null or group_key is null or group_key <> expected_group_id then
    raise exception 'Your circle changed. Refresh and try again'; end if;
  if not exists(select 1 from public.camp_group_members where group_id = group_key and user_id = target_user_id)
    and not exists(select 1 from public.circle_blocks where owner_id = actor_id and target_id = target_user_id)
    and not exists(select 1 from public.circle_members m join public.circles c on c.id = m.circle_id
      where m.status = 'active' and ((m.user_id = actor_id and c.owner_id = target_user_id)
        or (m.user_id = target_user_id and c.owner_id = actor_id))) then
    raise exception 'Camper unavailable';
  end if;
  insert into public.circle_blocks(owner_id,target_id) values(actor_id,target_user_id) on conflict do nothing;
  if exists(select 1 from public.camp_group_members where group_id = group_key and user_id = target_user_id) then
    result := public.circle_leave_locked(actor_id,expected_group_id);
  else result := jsonb_build_object('circleShop',public.camp_shop_payload(group_key),'leftCircle',false); end if;
  perform public.circle_disconnect_legacy(actor_id,array[target_user_id]);
  perform public.circle_prune_pending(actor_id);
  return result || jsonb_build_object('blockedUserId',target_user_id);
end $$;
create function public.unblock_circle_person(target_user_id uuid, expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor_id uuid;
begin
  perform public.circle_safety_lock();
  actor_id := public.circle_check_owner(expected_user_id);
  if target_user_id is null or target_user_id = actor_id then raise exception 'Choose another camper'; end if;
  delete from public.circle_blocks where owner_id = actor_id and target_id = target_user_id;
  return jsonb_build_object('unblockedUserId',target_user_id);
end $$;

-- All supported/legacy join versions ultimately call v5. Guard the ENTIRE
-- destination roster, not only the friend whose public code was entered.
create or replace function public.join_shared_circle_v5(friend_code_input text) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor_id uuid := auth.uid(); friend_id uuid; old_group uuid; new_group uuid; old_peers uuid[];
begin
  perform public.circle_safety_lock();
  if actor_id is null then raise exception 'Authentication required'; end if;
  select id into friend_id from public.profiles where friend_code = upper(trim(friend_code_input));
  if friend_id is null then raise exception 'Friend code not found'; end if;
  if friend_id = actor_id then raise exception 'You are already in your circle'; end if;
  perform 1 from public.profiles where id in (actor_id,friend_id) order by id for no key update;
  old_group := public.camp_ensure_group(actor_id);
  new_group := public.camp_ensure_group(friend_id);
  perform 1 from public.camp_groups where id in (old_group,new_group) order by id for update;
  if exists(select 1 from public.camp_group_members m where m.group_id = new_group
    and public.circle_pair_blocked(actor_id,m.user_id)) then raise exception 'That circle is unavailable'; end if;
  if old_group = new_group then return public.camp_shop_payload(new_group); end if;
  if (select count(*) from public.camp_group_members where group_id = new_group) >= 6 then
    raise exception 'That circle already has six campers'; end if;
  select coalesce(array_agg(user_id),'{}'::uuid[]) into old_peers from public.camp_group_members
    where group_id = old_group and user_id <> actor_id;
  update public.camp_group_members set group_id = new_group where user_id = actor_id;
  perform public.camp_reconcile_character(actor_id,new_group);
  perform public.circle_disconnect_legacy(actor_id,old_peers);
  perform public.circle_prune_pending(actor_id);
  return public.camp_shop_payload(new_group);
end $$;

-- Preserve old request/rate-limit/legacy API implementations behind private
-- names. Every public path takes the same first lock; no retired bypass remains.
alter function public.add_friend_by_code(text) rename to circle_add_friend_legacy;
create function public.add_friend_by_code(friend_code_input text) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  perform public.circle_safety_lock();
  perform public.circle_add_friend_legacy(friend_code_input);
end $$;
alter function public.redeem_circle_invite(text) rename to circle_redeem_invite_legacy;
create function public.redeem_circle_invite(invite_code text) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  perform public.circle_safety_lock();
  perform public.circle_redeem_invite_legacy(invite_code);
end $$;
alter function public.respond_to_circle_invite(uuid,boolean) rename to circle_respond_invite_legacy;
create function public.respond_to_circle_invite(membership_id uuid, accept_invite boolean) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  perform public.circle_safety_lock();
  perform public.circle_respond_invite_legacy(membership_id,accept_invite);
end $$;
alter function public.create_time_request(smallint,text,text) rename to circle_create_request_legacy;
create function public.create_time_request(requested_minutes smallint, request_reason text default null,
  request_category_label text default 'Selected apps') returns uuid
language plpgsql security definer set search_path = ''
as $$ begin
  perform public.circle_safety_lock();
  return public.circle_create_request_legacy(requested_minutes,request_reason,request_category_label);
end $$;
alter function public.decide_time_request(uuid,public.recipient_decision) rename to circle_decide_request_legacy;
create function public.decide_time_request(target_request_id uuid, requested_decision public.recipient_decision)
returns public.time_requests language plpgsql security definer set search_path = ''
as $$ begin
  perform public.circle_safety_lock();
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if not exists(select 1 from public.time_requests t join public.request_recipients r on r.request_id = t.id
    where t.id = target_request_id and r.recipient_id = auth.uid()
      and t.status = 'pending' and t.expires_at > clock_timestamp()
      and public.circle_pair_current(t.requester_id,auth.uid())) then
    raise exception 'Request is no longer available'; end if;
  return public.circle_decide_request_legacy(target_request_id,requested_decision);
end $$;

-- Called ONLY by the push edge service immediately before sending. The webhook
-- is merely a hint: never trust its old status/names/recipients. Already handed
-- off/in-flight push deliveries cannot be recalled after this check returns.
create function public.circle_notification_context(target_request_id uuid, expected_status text) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare requested public.time_requests; recipients uuid[]; push_tokens jsonb; sampled_at timestamptz := clock_timestamp();
begin
  select * into requested from public.time_requests where id = target_request_id;
  if requested.id is null or expected_status is null or requested.status::text <> expected_status
    or expected_status not in ('pending','approved','denied') then return null; end if;
  if requested.status = 'pending' then
    if requested.expires_at <= sampled_at then return null; end if;
    select array_agg(r.recipient_id) into recipients from public.request_recipients r
      where r.request_id = requested.id and r.decision is null
        and public.circle_pair_current(requested.requester_id,r.recipient_id);
  else
    if requested.decided_at is null or requested.decided_at <= sampled_at - interval '10 minutes'
      or not public.circle_pair_current(requested.requester_id,requested.decided_by)
      or not exists(select 1 from public.request_recipients where request_id = requested.id
        and recipient_id = requested.decided_by and decision::text = requested.status::text)
      or exists(select 1 from public.screen_time_grants where request_id = requested.id and expires_at <= sampled_at)
      or (requested.status = 'approved' and requested.decided_at + requested.minutes * interval '1 minute' <= sampled_at)
      then return null; end if;
    recipients := array[requested.requester_id];
  end if;
  select coalesce(jsonb_agg(distinct token),'[]'::jsonb) into push_tokens from public.device_push_tokens
    where user_id = any(recipients) and disabled_at is null;
  if push_tokens = '[]'::jsonb then return null; end if;
  return jsonb_build_object('requestId',requested.id,'status',requested.status,'minutes',requested.minutes,
    'requesterName',(select display_name from public.profiles where id = requested.requester_id),
    'deciderName',(select display_name from public.profiles where id = requested.decided_by),'tokens',push_tokens);
end $$;

revoke all on function public.circle_safety_lock(), public.circle_pair_blocked(uuid,uuid),
  public.circle_pair_current(uuid,uuid), public.circle_guard_camp_membership(),
  public.circle_guard_legacy_membership(), public.circle_disconnect_legacy(uuid,uuid[]),
  public.circle_prune_pending(uuid), public.circle_check_owner(uuid), public.circle_leave_locked(uuid,uuid),
  public.circle_add_friend_legacy(text), public.circle_redeem_invite_legacy(text),
  public.circle_respond_invite_legacy(uuid,boolean), public.circle_create_request_legacy(smallint,text,text),
  public.circle_decide_request_legacy(uuid,public.recipient_decision)
  from public, anon, authenticated, service_role;
revoke all on function public.circle_can_view_person(uuid), public.get_blocked_people(uuid),
  public.leave_shared_circle(uuid,uuid), public.block_circle_person(uuid,uuid,uuid),
  public.unblock_circle_person(uuid,uuid), public.join_shared_circle_v5(text),
  public.add_friend_by_code(text), public.redeem_circle_invite(text), public.respond_to_circle_invite(uuid,boolean),
  public.create_time_request(smallint,text,text), public.decide_time_request(uuid,public.recipient_decision),
  public.circle_notification_context(uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.circle_can_view_person(uuid), public.get_blocked_people(uuid),
  public.leave_shared_circle(uuid,uuid), public.block_circle_person(uuid,uuid,uuid),
  public.unblock_circle_person(uuid,uuid), public.join_shared_circle_v5(text),
  public.add_friend_by_code(text), public.redeem_circle_invite(text), public.respond_to_circle_invite(uuid,boolean),
  public.create_time_request(smallint,text,text), public.decide_time_request(uuid,public.recipient_decision) to authenticated;
grant execute on function public.circle_notification_context(uuid,text) to service_role;
