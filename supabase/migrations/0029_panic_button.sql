-- The panic button: fifteen minutes of unrestricted access, paid for socially.
--
-- Pressing it does four things at once, and either all of them happen or none
-- of them do:
--   1. burns one s'more from the circle's shared balance, permanently;
--   2. burns the shared day, so nobody earns a s'more today;
--   3. starts a fifteen-minute grant that lifts this person's shields;
--   4. records an event the push service turns into an alert for the circle.
--
-- The cost is deliberate and public. There is no per-person rate limit: the
-- limit is the circle's balance, so a circle at zero cannot panic at all, and
-- every press is visible to everyone who pays for it.

-- A panic grant has no request behind it, because nobody approved it. Rather
-- than invent an approved request that never happened -- which would surface
-- in request history and read as a friend's decision -- grants now say where
-- they came from, and only request-grants carry a request.
-- Written to be re-runnable: this migration reached one database before its
-- history row did, so applying it twice must be a no-op rather than an error.
alter table public.screen_time_grants
  add column if not exists source text not null default 'request';
alter table public.screen_time_grants drop constraint if exists screen_time_grants_source_check;
alter table public.screen_time_grants add constraint screen_time_grants_source_check
  check (source in ('request', 'panic'));
alter table public.screen_time_grants alter column request_id drop not null;
alter table public.screen_time_grants drop constraint if exists screen_time_grant_source_shape;
alter table public.screen_time_grants add constraint screen_time_grant_source_shape check (
  (source = 'request' and request_id is not null) or (source = 'panic' and request_id is null)
);

create table if not exists public.panic_events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.camp_groups(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete cascade,
  -- Denormalised so the alert still names the person if they later rename or
  -- leave. The push service must not have to join back to a live profile.
  actor_name text not null,
  day date not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null
);
create index if not exists panic_events_group_recent_idx on public.panic_events (group_id, created_at desc);

alter table public.panic_events enable row level security;
revoke all on table public.panic_events from public, anon, authenticated;

-- Members may read their own circle's panic history; nobody writes directly.
drop policy if exists panic_events_member_read on public.panic_events;
create policy panic_events_member_read on public.panic_events for select
  to authenticated using (public.camp_is_member(group_id));
grant select on table public.panic_events to authenticated;

create or replace function public.get_active_screen_time_grant()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := auth.uid();
  server_now timestamptz := clock_timestamp();
  claimed public.screen_time_grants;
begin
  if viewer_id is null then raise exception 'Authentication required'; end if;
  select * into claimed
  from public.screen_time_grants
  where requester_id = viewer_id and expires_at > server_now
  order by expires_at desc limit 1;
  if claimed.id is null then return null; end if;
  return jsonb_build_object(
    'grantId', claimed.id,
    'requesterId', claimed.requester_id,
    'requestId', claimed.request_id,
    'source', claimed.source,
    'startedAt', claimed.started_at,
    'expiresAt', claimed.expires_at,
    'serverNow', server_now
  );
end;
$$;

create or replace function public.use_panic_button()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := auth.uid();
  group_key uuid;
  server_now timestamptz;
  today date;
  actor text;
  spent integer;
  claimed public.screen_time_grants;
begin
  if viewer_id is null then raise exception 'Authentication required'; end if;

  -- Same account lock the request path takes, so two phones signed into one
  -- account cannot mint overlapping grants or spend the same s'more twice.
  perform 1 from public.profiles where id = viewer_id for update;
  if not found then raise exception 'Your account is not available'; end if;

  group_key := public.camp_ensure_group(viewer_id);
  perform public.camp_settle(group_key);
  -- Lock the circle before reading the balance: two members pressing at the
  -- same moment must not both see the last s'more.
  perform 1 from public.camp_groups where id = group_key for update;

  server_now := clock_timestamp();

  if exists (
    select 1 from public.screen_time_grants
    where requester_id = viewer_id and expires_at > server_now
  ) then
    raise exception 'Your extra time is already running';
  end if;

  select display_name into actor from public.profiles where id = viewer_id;
  select (server_now at time zone time_zone)::date into today
  from public.camp_groups where id = group_key;

  -- Spend first. If the circle cannot pay, nothing else below happens.
  update public.camp_groups
  set balance = balance - 1, updated_at = clock_timestamp()
  where id = group_key and balance >= 1
  returning balance into spent;
  if spent is null then raise exception 'Your circle has no s’mores left to burn'; end if;

  -- Burn the shared day exactly the way a request does, so every camper's
  -- marshmallow goes out and no s'more is awarded tonight.
  insert into public.camp_group_days (group_id, day, requested)
  values (group_key, today, true)
  on conflict (group_id, day) do update set requested = true;

  update public.screen_time_grants set active_requester_id = null
  where active_requester_id = viewer_id and expires_at <= server_now;

  insert into public.screen_time_grants
    (request_id, requester_id, active_requester_id, minutes, started_at, expires_at, source)
  values (null, viewer_id, viewer_id, 15, server_now, server_now + interval '15 minutes', 'panic')
  returning * into claimed;

  insert into public.panic_events (group_id, actor_id, actor_name, day, expires_at)
  values (group_key, viewer_id, coalesce(actor, 'Someone'), today, claimed.expires_at);

  return jsonb_build_object(
    'grant', jsonb_build_object(
      'grantId', claimed.id,
      'requesterId', claimed.requester_id,
      'requestId', claimed.request_id,
      'source', claimed.source,
      'startedAt', claimed.started_at,
      'expiresAt', claimed.expires_at,
      'serverNow', server_now
    ),
    'shop', public.camp_shop_payload(group_key)
  );
end;
$$;

revoke all on function public.use_panic_button() from public, anon, authenticated;
grant execute on function public.use_panic_button() to authenticated;

-- Called ONLY by the push edge service, immediately before sending. The webhook
-- payload is a hint; this re-reads the event and the circle's current roster so
-- a removed or blocked member is never alerted by a stale delivery.
create or replace function public.panic_notification_context(target_panic_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  event public.panic_events;
  sampled_at timestamptz := clock_timestamp();
  recipients uuid[];
  push_tokens jsonb;
begin
  select * into event from public.panic_events where id = target_panic_id;
  if event.id is null then return null; end if;
  -- An alert that missed its moment is not resent hours later.
  if event.created_at <= sampled_at - interval '10 minutes' then return null; end if;

  -- Everyone currently in the circle except the person who pressed it.
  select array_agg(m.user_id) into recipients
  from public.camp_group_members m
  where m.group_id = event.group_id and m.user_id <> event.actor_id;
  if recipients is null then return null; end if;

  select coalesce(jsonb_agg(distinct token), '[]'::jsonb) into push_tokens
  from public.device_push_tokens
  where user_id = any(recipients) and disabled_at is null;
  if push_tokens = '[]'::jsonb then return null; end if;

  return jsonb_build_object('panicId', event.id, 'actorName', event.actor_name, 'tokens', push_tokens);
end $$;

revoke all on function public.panic_notification_context(uuid)
  from public, anon, authenticated, service_role;

do $$
begin
  alter publication supabase_realtime add table public.panic_events;
exception when duplicate_object then null;
end $$;
notify pgrst, 'reload schema';
