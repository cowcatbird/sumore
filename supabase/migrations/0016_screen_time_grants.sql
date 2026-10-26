-- Activation establishes the approval cutoff for the signed Screen Time beta.
-- Device enforcement must still be verified separately. Old approvals cannot
-- become fresh unlocks. The native engine must persist these fixed deadlines,
-- register its re-block monitor before lifting shields, and reconcile on launch.
-- No app selections, usage reports, or device secrets are sent to this server.

create table public.screen_time_grant_config (
  singleton boolean primary key default true check (singleton),
  activated_at timestamptz not null default clock_timestamp()
);
insert into public.screen_time_grant_config (singleton) values (true);

create table public.screen_time_grants (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.time_requests(id) on delete cascade,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  -- One occupied slot per account. An expired grant releases its slot only
  -- when a new claim arrives; the historical grant/deadline are never deleted.
  -- The unique constraint is a second guard beyond the account row lock.
  active_requester_id uuid unique,
  minutes smallint not null check (minutes in (15, 30)),
  started_at timestamptz not null,
  expires_at timestamptz not null,
  constraint screen_time_grant_fixed_duration check (
    expires_at = started_at + make_interval(mins => minutes::integer)
  ),
  constraint screen_time_grant_slot_owner check (
    active_requester_id is null or active_requester_id = requester_id
  )
);
create index screen_time_grants_owner_expiry_idx
  on public.screen_time_grants (requester_id, expires_at desc);

-- RPC-only access. Even an authenticated circle member cannot inspect another
-- person's grant, mint one, change its owner, or extend its deadline.
alter table public.screen_time_grant_config enable row level security;
alter table public.screen_time_grants enable row level security;
revoke all on table public.screen_time_grant_config, public.screen_time_grants
  from public, anon, authenticated;

create or replace function public.claim_screen_time_grant(target_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := auth.uid();
  approved_request public.time_requests;
  claimed public.screen_time_grants;
  activation_time timestamptz;
  server_now timestamptz;
begin
  if viewer_id is null then raise exception 'Authentication required'; end if;

  -- Serialize ALL claims for this account, including claims for different
  -- requests. A request-only lock cannot prevent two overlapping unlocks.
  perform 1 from public.profiles where id = viewer_id for update;
  if not found then raise exception 'Your account is not available'; end if;

  select * into approved_request
  from public.time_requests
  where id = target_request_id and requester_id = viewer_id
  for share;
  if approved_request.id is null or approved_request.status <> 'approved'
    or approved_request.decided_at is null then
    raise exception 'An approved request for your account is required';
  end if;

  -- Read the clock after waiting for locks. A delayed transaction must not use
  -- its stale transaction-start timestamp to bypass expiry or overlap checks.
  server_now := clock_timestamp();
  select * into claimed
  from public.screen_time_grants
  where request_id = approved_request.id and requester_id = viewer_id;

  if claimed.id is null then
    select activated_at into activation_time
    from public.screen_time_grant_config where singleton;
    if activation_time is null then raise exception 'Screen Time grants are not activated'; end if;
    if approved_request.decided_at < activation_time then
      raise exception 'Send a new request to use Screen Time blocking';
    end if;
    if approved_request.minutes not in (15, 30) then
      raise exception 'Screen Time grants currently support 15 or 30 minutes';
    end if;
    if approved_request.decided_at > server_now
      or approved_request.decided_at + interval '10 minutes' <= server_now then
      raise exception 'This approval is too old to start. Send a new request';
    end if;
    if exists (
      select 1 from public.screen_time_grants
      where requester_id = viewer_id and expires_at > server_now
    ) then
      raise exception 'Extra time is already active. Wait for it to finish';
    end if;

    update public.screen_time_grants set active_requester_id = null
    where active_requester_id = viewer_id and expires_at <= server_now;
    insert into public.screen_time_grants
      (request_id, requester_id, active_requester_id, minutes, started_at, expires_at)
    values (approved_request.id, viewer_id, viewer_id, approved_request.minutes, server_now,
      server_now + make_interval(mins => approved_request.minutes::integer))
    returning * into claimed;
  end if;

  -- A lost response, app restart, or duplicate delivery returns the same grant
  -- even after expiry. Neither retries nor another phone restart the clock.
  return jsonb_build_object(
    'grantId', claimed.id,
    'requesterId', claimed.requester_id,
    'requestId', claimed.request_id,
    'startedAt', claimed.started_at,
    'expiresAt', claimed.expires_at,
    'serverNow', server_now
  );
end;
$$;

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
    'startedAt', claimed.started_at,
    'expiresAt', claimed.expires_at,
    'serverNow', server_now
  );
end;
$$;

revoke all on function public.claim_screen_time_grant(uuid), public.get_active_screen_time_grant()
  from public, anon, authenticated;
grant execute on function public.claim_screen_time_grant(uuid), public.get_active_screen_time_grant()
  to authenticated;
