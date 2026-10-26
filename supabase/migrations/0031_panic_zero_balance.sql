-- New circles earn their first s'more through completed clean days. Changing
-- the default does not rewrite existing balances, history, or purchases.
alter table public.camp_groups alter column balance set default 0;

-- Panic always grants fifteen minutes. Burn one s'more when available, keep a
-- zero wallet at zero, and burn the shared day / record the alert in either case.
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
  claimed public.screen_time_grants;
begin
  if viewer_id is null then raise exception 'Authentication required'; end if;

  -- Share the request-grant account lock: concurrent devices cannot create
  -- overlapping grants or charge twice for an already-active break.
  perform 1 from public.profiles where id = viewer_id for update;
  if not found then raise exception 'Your account is not available'; end if;

  group_key := public.camp_ensure_group(viewer_id);
  perform public.camp_settle(group_key);
  -- Serialize shared-wallet debits before sampling time or changing the day.
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

  update public.camp_groups
  set balance = greatest(balance - 1, 0), updated_at = clock_timestamp()
  where id = group_key;

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
notify pgrst, 'reload schema';
