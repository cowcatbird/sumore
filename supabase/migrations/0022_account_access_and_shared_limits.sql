-- Recovery keys are private bearer credentials, never friend codes. Only their
-- SHA-256 hashes enter PostgreSQL; the edge function verifies the caller's JWT.
create table public.account_recovery_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  recovery_email text not null check (char_length(recovery_email) between 3 and 320),
  updated_at timestamptz not null default clock_timestamp()
);
create table public.account_recovery_transfers (
  ticket_hash text primary key check (ticket_hash ~ '^[0-9a-f]{64}$'),
  from_user_id uuid not null references auth.users(id) on delete cascade,
  to_user_id uuid not null references auth.users(id) on delete cascade,
  from_key_hash text not null,
  expires_at timestamptz not null default (clock_timestamp() + interval '5 minutes'),
  check (from_user_id <> to_user_id)
);
create table public.account_access_attempts (
  bucket text primary key,
  attempts integer not null check (attempts > 0),
  resets_at timestamptz not null
);
create index account_access_attempts_expiration on public.account_access_attempts(resets_at);
create index account_recovery_transfers_expiration on public.account_recovery_transfers(expires_at);
-- User-scoped rate metadata is personal data too. Retain only the anonymous
-- IP bucket when an account is deleted; it cannot be linked back to a user.
create function public.clear_account_access_metadata() returns trigger
language plpgsql security definer set search_path = ''
as $$ begin
  delete from public.account_access_attempts where bucket like 'actor:' || old.id::text || ':%';
  return old;
end $$;
revoke all on function public.clear_account_access_metadata() from public, anon, authenticated, service_role;
create trigger clear_account_access_metadata before delete on auth.users
  for each row execute function public.clear_account_access_metadata();
alter table public.account_recovery_keys enable row level security;
alter table public.account_recovery_transfers enable row level security;
alter table public.account_access_attempts enable row level security;
revoke all on public.account_recovery_keys, public.account_recovery_transfers,
  public.account_access_attempts from public, anon, authenticated, service_role;

-- No exception on a refused attempt: returning false commits the counters.
-- The edge supplies an HMAC of the proxy IP, never a raw address. Per-account
-- limits remain effective even if no reliable proxy address is available.
create function public.account_access_allow(actor_id uuid, ip_hash text, operation text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare bucket_key text; keys text[]; amount integer; maximum integer; allowed boolean := true; sampled_at timestamptz := clock_timestamp();
begin
  if actor_id is null or not exists (select 1 from auth.users where id = actor_id)
    or operation is null or operation not in ('status','create','revoke','recover','finish','delete')
    or ip_hash is null or ip_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  maximum := case operation when 'status' then 80 when 'create' then 5 else 15 end;
  keys := array['actor:' || actor_id::text || ':' || operation, 'ip:' || ip_hash || ':' || operation];
  for bucket_key in select k from unnest(keys) k order by k loop
    insert into public.account_access_attempts(bucket, attempts, resets_at)
      values (bucket_key, 1, sampled_at + interval '15 minutes')
      on conflict (bucket) do update set
        attempts = case when account_access_attempts.resets_at <= sampled_at then 1 else least(account_access_attempts.attempts + 1, 10000) end,
        resets_at = case when account_access_attempts.resets_at <= sampled_at then sampled_at + interval '15 minutes' else account_access_attempts.resets_at end
      returning attempts into amount;
    if amount > (case when bucket_key like 'ip:%' then maximum * 3 else maximum end) then allowed := false; end if;
  end loop;
  -- Housekeeping must not wait on another request's freshly updated bucket.
  -- A pair of callers reviving old buckets could otherwise deadlock here.
  delete from public.account_access_attempts where bucket in (
    select bucket from public.account_access_attempts where resets_at < sampled_at - interval '1 day'
      order by resets_at limit 500 for update skip locked
  );
  delete from public.account_recovery_transfers where ticket_hash in (
    select ticket_hash from public.account_recovery_transfers where expires_at < sampled_at
      order by expires_at limit 500 for update skip locked
  );
  return allowed;
end;
$$;

create function public.account_key_status(actor_id uuid, candidate_hash text default null) returns jsonb
language sql stable security definer set search_path = ''
as $$ select jsonb_build_object(
  'hasKey', exists(select 1 from public.account_recovery_keys where user_id = actor_id),
  'matches', exists(select 1 from public.account_recovery_keys where user_id = actor_id and key_hash = candidate_hash)
) $$;

create function public.account_store_key(actor_id uuid, new_hash text, identity_email text) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  insert into public.account_recovery_keys(user_id, key_hash, recovery_email)
    values(actor_id, new_hash, identity_email)
    on conflict(user_id) do update set key_hash = excluded.key_hash,
      recovery_email = excluded.recovery_email, updated_at = clock_timestamp();
end $$;

create function public.account_revoke_key(actor_id uuid) returns void
language sql security definer set search_path = ''
as $$ delete from public.account_recovery_keys where user_id = actor_id $$;

create function public.account_lookup_key(candidate_hash text) returns jsonb
language sql stable security definer set search_path = ''
as $$ select jsonb_build_object('userId',user_id,'email',recovery_email)
  from public.account_recovery_keys where key_hash = candidate_hash $$;

-- Capture the CURRENT old key, but never revoke it until the client has
-- successfully installed and authenticated the restored account's session.
create function public.account_prepare_transfer(actor_id uuid, target_id uuid, new_ticket_hash text) returns boolean
language plpgsql security definer set search_path = ''
as $$ declare old_hash text;
begin
  if actor_id = target_id then return false; end if;
  select key_hash into old_hash from public.account_recovery_keys where user_id = actor_id for share;
  if old_hash is null then return false; end if;
  insert into public.account_recovery_transfers(ticket_hash,from_user_id,to_user_id,from_key_hash)
    values(new_ticket_hash,actor_id,target_id,old_hash);
  return true;
end $$;

create function public.account_finish_transfer(actor_id uuid, candidate_ticket_hash text) returns boolean
language plpgsql security definer set search_path = ''
as $$ declare transfer public.account_recovery_transfers; removed integer;
begin
  select * into transfer from public.account_recovery_transfers
    where ticket_hash = candidate_ticket_hash and to_user_id = actor_id and expires_at > clock_timestamp() for update;
  if not found then return false; end if;
  -- A later explicit rotation on the abandoned account must win this race.
  delete from public.account_recovery_keys where user_id = transfer.from_user_id and key_hash = transfer.from_key_hash;
  get diagnostics removed = row_count;
  delete from public.account_recovery_transfers where ticket_hash = transfer.ticket_hash;
  return removed = 1;
end $$;

revoke all on function public.account_access_allow(uuid,text,text),
  public.account_key_status(uuid,text), public.account_store_key(uuid,text,text),
  public.account_revoke_key(uuid), public.account_lookup_key(text),
  public.account_prepare_transfer(uuid,uuid,text), public.account_finish_transfer(uuid,text)
  from public, anon, authenticated;
grant execute on function public.account_access_allow(uuid,text,text),
  public.account_key_status(uuid,text), public.account_store_key(uuid,text,text),
  public.account_revoke_key(uuid), public.account_lookup_key(text),
  public.account_prepare_transfer(uuid,uuid,text), public.account_finish_transfer(uuid,text)
  to service_role;

-- Account deletion previously failed if the user had approved someone else's
-- request: the decider FK uses SET NULL but this check required a decider. Keep
-- the peer's decision/grant while removing the deleted person's identifier.
alter table public.time_requests drop constraint decision_fields_match_status;
alter table public.time_requests add constraint decision_fields_match_status check (
  (status in ('approved','denied') and decided_at is not null)
  or status not in ('approved','denied')
);

-- Sharing is explicitly opt-in and contains ONLY user-entered display labels
-- and planned minutes, never Apple's opaque tokens or Android package IDs.
create table public.shared_app_limits (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  apps jsonb check (apps is null or (jsonb_typeof(apps) = 'array' and jsonb_array_length(apps) <= 50)),
  total_daily_minutes integer not null check (total_daily_minutes between 0 and 72000),
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.shared_app_limits enable row level security;
revoke all on public.shared_app_limits from public, anon, authenticated;
grant select on public.shared_app_limits to authenticated;
create policy "shared app limits visible only to current circle" on public.shared_app_limits
  for select to authenticated using (user_id = auth.uid() or public.camp_share_group(user_id));

create function public.set_shared_app_limits(entries jsonb default null, allocation_minutes integer default null, expected_user_id uuid default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor uuid := auth.uid(); entry jsonb; clean jsonb := '[]'::jsonb; label_text text; minutes_value numeric; total integer := 0; saved public.shared_app_limits;
begin
  if actor is null or not exists(select 1 from public.profiles where id = actor) then raise exception 'Authentication required'; end if;
  if expected_user_id is not null and expected_user_id <> actor then raise exception 'The active account changed'; end if;
  if (entries is null or entries = 'null'::jsonb) and allocation_minutes is null then
    delete from public.shared_app_limits where user_id = actor;
    return null;
  end if;
  if entries is null or entries = 'null'::jsonb then clean := null;
  elsif jsonb_typeof(entries) <> 'array' or jsonb_array_length(entries) > 50 then raise exception 'Choose up to 50 app labels'; end if;
  for entry in select value from jsonb_array_elements(case when clean is null then '[]'::jsonb else entries end) loop
    if jsonb_typeof(entry) <> 'object' or (select count(*) from jsonb_object_keys(entry)) <> 2
      or jsonb_typeof(entry->'label') is distinct from 'string' or jsonb_typeof(entry->'minutes') is distinct from 'number'
      then raise exception 'Use an app label and whole minutes'; end if;
    label_text := btrim(entry->>'label');
    minutes_value := (entry->>'minutes')::numeric;
    if char_length(label_text) not between 1 and 32 or label_text ~ '[[:cntrl:]]'
      or minutes_value not between 1 and 1440 or minutes_value <> trunc(minutes_value)
      then raise exception 'Use labels up to 32 characters and 1 to 1440 whole minutes'; end if;
    clean := clean || jsonb_build_array(jsonb_build_object('label',label_text,'minutes',minutes_value::integer));
    total := total + minutes_value::integer;
  end loop;
  if allocation_minutes is not null then
    if allocation_minutes not between 0 and 72000 or allocation_minutes < total then raise exception 'The daily total must cover the shared allocations'; end if;
    total := allocation_minutes;
  end if;
  insert into public.shared_app_limits(user_id,apps,total_daily_minutes) values(actor,clean,total)
    on conflict(user_id) do update set apps = excluded.apps, total_daily_minutes = excluded.total_daily_minutes, updated_at = clock_timestamp()
    returning * into saved;
  return jsonb_build_object('userId',saved.user_id,'apps',saved.apps,'totalDailyMinutes',saved.total_daily_minutes,'updatedAt',saved.updated_at);
end $$;

create function public.get_circle_app_limits() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$ begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('userId',s.user_id,'apps',s.apps,
    'totalDailyMinutes',s.total_daily_minutes,'updatedAt',s.updated_at) order by s.user_id),'[]'::jsonb)
    from public.shared_app_limits s where s.user_id = auth.uid() or public.camp_share_group(s.user_id));
end $$;
revoke all on function public.set_shared_app_limits(jsonb,integer,uuid), public.get_circle_app_limits() from public, anon, authenticated;
grant execute on function public.set_shared_app_limits(jsonb,integer,uuid), public.get_circle_app_limits() to authenticated;

-- Native allowance refreshes must never round-trip a stale copy of app labels.
-- PostgreSQL evaluates this ON CONFLICT update against the latest locked row.
create function public.set_shared_daily_total(allocation_minutes integer, expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare actor uuid := auth.uid(); saved public.shared_app_limits;
begin
  if actor is null or not exists(select 1 from public.profiles where id = actor) then raise exception 'Authentication required'; end if;
  if expected_user_id is null or expected_user_id <> actor then raise exception 'The active account changed'; end if;
  if allocation_minutes is null or allocation_minutes not between 0 and 72000 then raise exception 'Invalid daily total'; end if;
  insert into public.shared_app_limits(user_id,apps,total_daily_minutes) values(actor,null,allocation_minutes)
    on conflict(user_id) do update set
      apps = case when (select coalesce(sum((entry->>'minutes')::integer),0)
        from jsonb_array_elements(coalesce(shared_app_limits.apps,'[]'::jsonb)) entry) <= excluded.total_daily_minutes
        then shared_app_limits.apps else null end,
      total_daily_minutes = excluded.total_daily_minutes, updated_at = clock_timestamp()
    returning * into saved;
  return jsonb_build_object('userId',saved.user_id,'apps',saved.apps,'totalDailyMinutes',saved.total_daily_minutes,'updatedAt',saved.updated_at);
end $$;
revoke all on function public.set_shared_daily_total(integer,uuid) from public, anon, authenticated;
grant execute on function public.set_shared_daily_total(integer,uuid) to authenticated;
