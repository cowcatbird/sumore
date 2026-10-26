-- One explicitly joined camp per person. Legacy reciprocal friend lists remain
-- intact, but are not merged into groups or used to infer shared ownership.
-- Wallet money is server-owned and never imported from personal streak totals.
create table public.camp_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our circle' check (char_length(name) between 1 and 40),
  time_zone text not null,
  balance integer not null default 99 check (balance >= 0),
  background text not null default 'forest' check (background in ('forest', 'beach')),
  initialized_at timestamptz not null default clock_timestamp(),
  last_settled_day date not null,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.camp_group_members (
  -- The primary key is the database-level one-current-group constraint.
  user_id uuid primary key references public.profiles(id) on delete cascade,
  group_id uuid not null references public.camp_groups(id),
  joined_at timestamptz not null default clock_timestamp()
);
create index camp_group_members_group_idx on public.camp_group_members(group_id);

create table public.camp_group_unlocks (
  group_id uuid not null references public.camp_groups(id),
  item_id text not null check (item_id in ('hat:crown','color:blue','color:orange','color:pink','background:beach')),
  cost integer not null check (cost = case item_id when 'background:beach' then 30 else 1 end),
  purchased_at timestamptz not null default clock_timestamp(),
  primary key (group_id, item_id)
);

-- Anonymous group/day facts, deliberately without request/profile foreign keys.
-- Cancelling a request, leaving, or deleting an account cannot erase a burnt day.
-- Settling BEFORE every roster change means no past membership reconstruction
-- is necessary; the partial change-day is ineligible, and empty camps earn zero.
create table public.camp_group_days (
  group_id uuid not null references public.camp_groups(id),
  day date not null,
  requested boolean not null default false,
  roster_changed boolean not null default false,
  earned boolean not null default false,
  settled_at timestamptz,
  primary key (group_id, day),
  check (not earned or (settled_at is not null and not requested and not roster_changed))
);

alter table public.camp_groups enable row level security;
alter table public.camp_group_members enable row level security;
alter table public.camp_group_unlocks enable row level security;
alter table public.camp_group_days enable row level security;
revoke all on public.camp_groups, public.camp_group_members, public.camp_group_unlocks,
  public.camp_group_days from public, anon, authenticated;

alter table public.profiles add column character_color text not null default 'cream'
  check (character_color in ('cream','blue','orange','pink'));
-- Existing profile writes are RPC-only. Do not accidentally expose paid fields
-- if this database has more permissive default grants than the original project.
revoke insert, update, delete on public.profiles from anon, authenticated;

create function public.camp_is_member(target_group_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.camp_group_members
  where group_id = target_group_id and user_id = auth.uid()) $$;

create policy "current camp members view group" on public.camp_groups
for select to authenticated using (public.camp_is_member(id));
create policy "current camp members view roster" on public.camp_group_members
for select to authenticated using (public.camp_is_member(group_id));
create policy "current camp members view unlocks" on public.camp_group_unlocks
for select to authenticated using (public.camp_is_member(group_id));
grant select on public.camp_groups, public.camp_group_members, public.camp_group_unlocks to authenticated;

create function public.camp_share_group(target_user_id uuid) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.camp_group_members mine
  join public.camp_group_members peer on peer.group_id = mine.group_id
  where mine.user_id = auth.uid() and peer.user_id = target_user_id) $$;
create policy "current camp peers view profiles" on public.profiles
for select to authenticated using (public.camp_share_group(id));

-- Private helper. Callers must already own the appropriate user lock when a
-- membership can change. The group lock serializes settlement, purchases,
-- request creation and roster changes, and time is sampled after the lock.
create function public.camp_now() returns timestamptz
language sql volatile set search_path = '' as $$ select clock_timestamp() $$;

create function public.camp_settle(target_group_id uuid, effective_now timestamptz default null) returns void
language plpgsql security definer set search_path = ''
as $$
declare g public.camp_groups; today date; present boolean; earned_count integer;
begin
  select * into g from public.camp_groups where id = target_group_id for update;
  if g.id is null then raise exception 'Circle is unavailable'; end if;
  today := (coalesce(effective_now, public.camp_now()) at time zone g.time_zone)::date;
  if g.last_settled_day >= today - 1 then return; end if;
  select exists (select 1 from public.camp_group_members where group_id = g.id) into present;
  with settled as (
    insert into public.camp_group_days (group_id, day, earned, settled_at)
    select g.id, d::date, present, clock_timestamp()
    from generate_series((g.last_settled_day + 1)::timestamp,
      (today - 1)::timestamp, interval '1 day') d
    on conflict (group_id, day) do update
      set earned = present and not camp_group_days.requested and not camp_group_days.roster_changed,
          settled_at = excluded.settled_at
      where camp_group_days.settled_at is null
    returning earned
  ) select count(*)::integer into earned_count from settled where earned;
  update public.camp_groups set balance = balance + earned_count,
    last_settled_day = today - 1, updated_at = clock_timestamp() where id = g.id;
end;
$$;

create function public.camp_roster_day() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid; today date; group_keys uuid[]; changed_at timestamptz;
begin
  -- Public RPCs lock both groups in UUID order first. This trigger also covers
  -- profile/account cascades, so deletion cannot retroactively manufacture days.
  group_keys := case tg_op
    when 'INSERT' then array[new.group_id]
    when 'DELETE' then array[old.group_id]
    else array[old.group_id, new.group_id] end;
  perform 1 from public.camp_groups where id = any(group_keys) order by id for update;
  changed_at := public.camp_now();
  for group_key in select distinct key from unnest(group_keys) key order by key
  loop
    perform public.camp_settle(group_key, changed_at);
    select (changed_at at time zone time_zone)::date into today
      from public.camp_groups where id = group_key;
    insert into public.camp_group_days (group_id, day, roster_changed)
      values (group_key, today, true)
      on conflict (group_id, day) do update set roster_changed = true;
    update public.camp_groups set updated_at = clock_timestamp() where id = group_key;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  new.joined_at := changed_at;
  return new;
end;
$$;
create trigger camp_membership_days before insert or update or delete on public.camp_group_members
for each row execute function public.camp_roster_day();

create function public.camp_reconcile_character(member_id uuid, target_group_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.profiles p set
    character_hat = case when p.character_hat = 'crown' and not exists (
      select 1 from public.camp_group_unlocks where group_id = target_group_id and item_id = 'hat:crown'
    ) then 'none' else p.character_hat end,
    character_color = case when p.character_color <> 'cream' and not exists (
      select 1 from public.camp_group_unlocks where group_id = target_group_id and item_id = 'color:' || p.character_color
    ) then 'cream' else p.character_color end,
    character_revision = character_revision + 1
  where p.id = member_id and (
    (p.character_hat = 'crown' and not exists (select 1 from public.camp_group_unlocks
      where group_id = target_group_id and item_id = 'hat:crown'))
    or (p.character_color <> 'cream' and not exists (select 1 from public.camp_group_unlocks
      where group_id = target_group_id and item_id = 'color:' || p.character_color))
  );
end;
$$;

create function public.camp_ensure_group(member_id uuid, requested_tz text default 'UTC') returns uuid
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid; safe_tz text; created timestamptz;
begin
  -- One account lock prevents duplicate solo groups, including simultaneous
  -- first launch, request submission, and joining another person's camp.
  -- NO KEY UPDATE serializes account operations but permits recipient foreign
  -- key checks. FOR UPDATE here deadlocks a peer poll against request insertion.
  perform 1 from public.profiles where id = member_id for no key update;
  if not found then raise exception 'Your account is unavailable'; end if;
  select group_id into group_key from public.camp_group_members where user_id = member_id;
  if group_key is not null then return group_key; end if;
  select name into safe_tz from pg_catalog.pg_timezone_names where name = requested_tz limit 1;
  safe_tz := coalesce(safe_tz, 'UTC');
  created := public.camp_now();
  insert into public.camp_groups (time_zone, initialized_at, last_settled_day)
    values (safe_tz, created, (created at time zone safe_tz)::date - 1)
    returning id into group_key;
  insert into public.camp_group_members (user_id, group_id, joined_at) values (member_id, group_key, created);
  perform public.camp_reconcile_character(member_id, group_key);
  return group_key;
end;
$$;

create function public.camp_shop_payload(target_group_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare g public.camp_groups; today date; asked boolean; eligible boolean; days public.camp_group_days; snapshot_time timestamptz;
begin
  perform 1 from public.camp_groups where id = target_group_id for update;
  snapshot_time := public.camp_now();
  perform public.camp_settle(target_group_id, snapshot_time);
  select * into g from public.camp_groups where id = target_group_id;
  today := (snapshot_time at time zone g.time_zone)::date;
  select * into days from public.camp_group_days where group_id = g.id and day = today;
  asked := coalesce(days.requested, false);
  eligible := not coalesce(days.roster_changed, false)
    and exists (select 1 from public.camp_group_members where group_id = g.id);
  return jsonb_build_object(
    'id', g.id, 'name', g.name, 'balance', g.balance, 'background', g.background,
    'unlocked', (select coalesce(jsonb_agg(item_id order by item_id), '[]'::jsonb)
      from public.camp_group_unlocks where group_id = g.id),
    'localDate', today, 'timeZone', g.time_zone, 'askedToday', asked, 'eligibleToday', eligible,
    'dayStartedAt', today::timestamp at time zone g.time_zone,
    'nextAwardAt', (today + case when eligible and not asked then 1 else 2 end)::timestamp at time zone g.time_zone,
    'initializedAt', g.initialized_at
  );
end;
$$;

create function public.get_circle_shop(tz text default 'UTC') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  group_key := public.camp_ensure_group(auth.uid(), tz);
  return public.camp_shop_payload(group_key);
end;
$$;

create function public.purchase_circle_item(target_group_id uuid, item_id text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid; price integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  group_key := public.camp_ensure_group(auth.uid());
  if group_key is distinct from target_group_id then raise exception 'Your circle changed. Refresh and try again'; end if;
  price := case item_id when 'hat:crown' then 1 when 'color:blue' then 1 when 'color:orange' then 1
    when 'color:pink' then 1 when 'background:beach' then 30 else null end;
  if price is null then raise exception 'Choose an available shop item'; end if;
  perform public.camp_settle(group_key);
  -- The group lock and unique unlock key make duplicate taps and lost-response
  -- retries free, and serialize simultaneous purchases by different members.
  if not exists (select 1 from public.camp_group_unlocks u
    where u.group_id = group_key and u.item_id = purchase_circle_item.item_id) then
    update public.camp_groups set balance = balance - price, updated_at = clock_timestamp()
      where id = group_key and balance >= price;
    if not found then raise exception 'Your circle needs more s’mores'; end if;
    insert into public.camp_group_unlocks (group_id, item_id, cost)
      values (group_key, purchase_circle_item.item_id, price);
  end if;
  return public.camp_shop_payload(group_key);
end;
$$;

create function public.set_circle_background(target_group_id uuid, new_background text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  group_key := public.camp_ensure_group(auth.uid());
  if group_key is distinct from target_group_id then raise exception 'Your circle changed. Refresh and try again'; end if;
  if new_background is null or new_background not in ('forest','beach') then raise exception 'Choose an available campsite'; end if;
  perform public.camp_settle(group_key);
  if new_background = 'beach' and not exists (select 1 from public.camp_group_unlocks
    where group_id = group_key and item_id = 'background:beach') then raise exception 'Unlock the beach in your circle’s shop first'; end if;
  update public.camp_groups set background = new_background, updated_at = clock_timestamp() where id = group_key;
  return public.camp_shop_payload(group_key);
end;
$$;

create function public.join_shared_circle(friend_code_input text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare member_id uuid := auth.uid(); friend_id uuid; old_group uuid; new_group uuid;
begin
  if member_id is null then raise exception 'Authentication required'; end if;
  select id into friend_id from public.profiles where friend_code = upper(trim(friend_code_input));
  if friend_id is null then raise exception 'Friend code not found'; end if;
  if friend_id = member_id then raise exception 'You are already in your circle'; end if;
  -- Fixed lock order for A joins B / B joins A and cross-group purchases.
  perform 1 from public.profiles where id in (member_id, friend_id) order by id for no key update;
  old_group := public.camp_ensure_group(member_id);
  new_group := public.camp_ensure_group(friend_id);
  perform 1 from public.camp_groups where id in (old_group, new_group) order by id for update;
  if old_group = new_group then return public.camp_shop_payload(new_group); end if;
  if (select count(*) from public.camp_group_members where group_id = new_group) >= 6 then
    raise exception 'That circle already has six campers';
  end if;
  -- The membership trigger settles both completed histories and marks today
  -- partial before the move. No balances or unlocks transfer, combine or reset.
  update public.camp_group_members set group_id = new_group, joined_at = clock_timestamp() where user_id = member_id;
  perform public.camp_reconcile_character(member_id, new_group);
  return public.camp_shop_payload(new_group);
end;
$$;

-- All request inserts, including old clients and nonstandard trusted writers,
-- burn the current group's day before the transaction commits. Status changes
-- never unburn it. Use acceptance time after waiting for the group lock.
create function public.camp_accept_request() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid; accepted_at timestamptz;
begin
  group_key := public.camp_ensure_group(new.requester_id);
  perform 1 from public.camp_groups where id = group_key for update;
  -- One server instant owns created_at, expiry, settlement and the burnt day.
  -- The row lock remains held through the AFTER trigger and transaction commit.
  accepted_at := public.camp_now();
  new.created_at := accepted_at;
  new.expires_at := accepted_at + interval '20 minutes';
  return new;
end;
$$;
create trigger time_request_server_acceptance before insert on public.time_requests
for each row execute function public.camp_accept_request();

create function public.camp_request_day() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid; today date;
begin
  group_key := public.camp_ensure_group(new.requester_id);
  perform public.camp_settle(group_key, new.created_at);
  select (new.created_at at time zone time_zone)::date into today from public.camp_groups where id = group_key;
  insert into public.camp_group_days (group_id, day, requested) values (group_key, today, true)
    on conflict (group_id, day) do update set requested = true;
  update public.camp_groups set updated_at = clock_timestamp() where id = group_key;
  return new;
end;
$$;
create trigger time_request_burns_shared_day after insert on public.time_requests
for each row execute function public.camp_request_day();

create or replace function public.create_time_request(
  requested_minutes smallint, request_reason text default null, request_category_label text default 'Selected apps'
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare group_key uuid; owner_circle_id uuid; new_request_id uuid; accepted_time timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if requested_minutes is null or requested_minutes not in (5,10,15,30) then raise exception 'Invalid number of minutes'; end if;
  if request_reason is not null and char_length(request_reason) > 240 then raise exception 'Reason is too long'; end if;
  if request_category_label is null or char_length(trim(request_category_label)) not between 1 and 40 then raise exception 'Invalid category label'; end if;
  group_key := public.camp_ensure_group(auth.uid());
  perform public.camp_settle(group_key);
  accepted_time := public.camp_now();
  select id into owner_circle_id from public.circles where owner_id = auth.uid();
  if owner_circle_id is null then raise exception 'Create a circle first'; end if;
  if not exists (select 1 from public.camp_group_members where group_id = group_key and user_id <> auth.uid()) then
    raise exception 'Join a friend’s circle before asking for time';
  end if;
  update public.time_requests set status = 'expired'
    where requester_id = auth.uid() and status = 'pending' and expires_at <= accepted_time;
  if exists (select 1 from public.time_requests where requester_id = auth.uid() and status = 'pending' and expires_at > accepted_time)
    then raise exception 'A request is already pending'; end if;
  if (select count(*) from public.time_requests where requester_id = auth.uid() and created_at > accepted_time - interval '1 hour') >= 5
    then raise exception 'Please wait before sending another request'; end if;
  insert into public.time_requests (requester_id, circle_id, minutes, reason, category_label, created_at, expires_at)
    values (auth.uid(), owner_circle_id, requested_minutes, nullif(trim(request_reason), ''), trim(request_category_label),
      accepted_time, accepted_time + interval '20 minutes') returning id into new_request_id;
  insert into public.request_recipients (request_id, recipient_id)
    select new_request_id, user_id from public.camp_group_members where group_id = group_key and user_id <> auth.uid();
  return new_request_id;
end;
$$;

-- Preserve self-service account deletion, but take the group lock before the
-- cascade upgrades profile row locks. This avoids a cycle with a peer request's
-- recipient foreign-key check while retaining anonymous durable day history.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  perform 1 from public.profiles where id = auth.uid() for no key update;
  select group_id into group_key from public.camp_group_members where user_id = auth.uid();
  if group_key is not null then perform public.camp_settle(group_key); end if;
  delete from auth.users where id = auth.uid();
end;
$$;

-- Belt-and-suspenders protection: even a future accidental profile UPDATE grant
-- cannot equip paid items without the caller's actual shared-group entitlement.
create function public.camp_check_character_unlock() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid;
begin
  select group_id into group_key from public.camp_group_members where user_id = new.id;
  if new.character_hat = 'crown' and not exists (select 1 from public.camp_group_unlocks
    where group_id = group_key and item_id = 'hat:crown') then raise exception 'Unlock the crown in your circle’s shop first'; end if;
  if new.character_color <> 'cream' and not exists (select 1 from public.camp_group_unlocks
    where group_id = group_key and item_id = 'color:' || new.character_color) then raise exception 'Unlock this color in your circle’s shop first'; end if;
  return new;
end;
$$;
create trigger profiles_paid_character_guard before insert or update of character_hat, character_color on public.profiles
for each row execute function public.camp_check_character_unlock();

-- Removing the old overload avoids ambiguous PostgREST dispatch. The new
-- optional color argument still accepts every previous four-argument call.
drop function public.update_my_character(uuid,text,text,integer);
create function public.update_my_character(target_profile_id uuid, new_hat text, new_body text,
  expected_revision integer, new_color text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare saved public.profiles; group_key uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if target_profile_id is distinct from auth.uid() then raise exception 'This camper belongs to a different account'; end if;
  if new_hat is null or new_hat not in ('none','cowboy','cow','cat','sunglasses','duck','top-hat','halo','crown')
    or new_body is null or new_body not in ('short','tall') or expected_revision is null or expected_revision < 0
    or (new_color is not null and new_color not in ('cream','blue','orange','pink'))
    then raise exception 'Choose a supported hat, body and color'; end if;
  group_key := public.camp_ensure_group(auth.uid());
  perform 1 from public.camp_groups where id = group_key for update;
  update public.profiles set character_hat = new_hat, character_body = new_body,
    character_color = coalesce(new_color, character_color), character_revision = character_revision + 1
    where id = auth.uid() and character_revision = expected_revision returning * into saved;
  if saved.id is null then raise exception 'Your camper changed on another device. Refresh and retry your choice.' using errcode = '40001'; end if;
  return jsonb_build_object('appearance', jsonb_build_object('hat', saved.character_hat, 'body', saved.character_body,
    'color', saved.character_color), 'revision', saved.character_revision);
end;
$$;

-- Preserve the old RPC's stable envelope and request/grant compatibility, but
-- never return its private-friend-list scene as the new shared camp's roster.
alter function public.get_app_snapshot(text) rename to camp_legacy_snapshot;
revoke all on function public.camp_legacy_snapshot(text) from public, anon, authenticated;
create function public.camp_character(member public.profiles) returns jsonb
language sql stable security definer set search_path = ''
as $$ select jsonb_build_object('appearance', case when member.character_hat is null then null else
  jsonb_build_object('hat', member.character_hat, 'body', member.character_body, 'color', member.character_color) end,
  'revision', member.character_revision) $$;

create function public.get_app_snapshot(tz text default 'UTC') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare result jsonb; shop jsonb; group_key uuid; member_rows jsonb; seat_rows jsonb; profile_row public.profiles;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  shop := public.get_circle_shop(tz);
  group_key := (shop ->> 'id')::uuid;
  result := public.camp_legacy_snapshot(shop ->> 'timeZone');
  select * into profile_row from public.profiles where id = auth.uid();
  result := jsonb_set(result, '{profile,character}', public.camp_character(profile_row));
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'displayName', p.display_name, 'friendCode', p.friend_code, 'initials', public.profile_initials(p.display_name),
    'color', '#FFD2BF', 'online', false, 'character', public.camp_character(p)
  ) order by p.display_name, p.id), '[]'::jsonb) into member_rows
    from public.camp_group_members m join public.profiles p on p.id = m.user_id
    where m.group_id = group_key and p.id <> auth.uid();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'displayName', p.display_name, 'initials', public.profile_initials(p.display_name), 'isYou', p.id = auth.uid(),
    'askedToday', (standing.value ->> 'askedToday')::boolean, 'streak', (standing.value ->> 'streak')::integer,
    'golden', 0, 'character', public.camp_character(p)
  ) order by p.id <> auth.uid(), p.display_name, p.id), '[]'::jsonb) into seat_rows
    from public.camp_group_members m join public.profiles p on p.id = m.user_id
    cross join lateral (select public.campfire_standing(p.id, shop ->> 'timeZone') value) standing
    where m.group_id = group_key;
  result := jsonb_set(result, '{friends}', member_rows);
  result := jsonb_set(result, '{campfire}', jsonb_build_object('localDate', shop ->> 'localDate',
    'seats', seat_rows, 'groupGolden', (shop ->> 'balance')::integer));
  result := result || jsonb_build_object('circleShop', shop);
  -- Existing pending requests remain answerable by their original recipients.
  -- Refresh their character color too, without widening recipient visibility.
  select coalesce(jsonb_agg(jsonb_set(r, '{friend,character}', public.camp_character(p))), '[]'::jsonb)
    into member_rows from jsonb_array_elements(result -> 'incomingRequests') r
    join public.profiles p on p.id = (r #>> '{friend,id}')::uuid;
  return jsonb_set(result, '{incomingRequests}', member_rows);
end;
$$;

-- Explicitly revoke even permissive project defaults. Only authenticated RPCs
-- and the two RLS membership predicates are remotely executable.
revoke all on function public.camp_is_member(uuid), public.camp_share_group(uuid),
  public.camp_now(), public.camp_settle(uuid,timestamptz), public.camp_roster_day(), public.camp_reconcile_character(uuid,uuid),
  public.camp_ensure_group(uuid,text), public.camp_shop_payload(uuid), public.camp_accept_request(), public.camp_request_day(),
  public.camp_check_character_unlock(), public.camp_character(public.profiles),
  public.get_circle_shop(text), public.purchase_circle_item(uuid,text), public.set_circle_background(uuid,text),
  public.join_shared_circle(text), public.get_app_snapshot(text), public.update_my_character(uuid,text,text,integer,text),
  public.create_time_request(smallint,text,text), public.delete_my_account() from public, anon, authenticated;
grant execute on function public.camp_is_member(uuid), public.camp_share_group(uuid),
  public.get_circle_shop(text), public.purchase_circle_item(uuid,text), public.set_circle_background(uuid,text),
  public.join_shared_circle(text), public.get_app_snapshot(text), public.update_my_character(uuid,text,text,integer,text),
  public.create_time_request(smallint,text,text), public.delete_my_account() to authenticated;

-- Changes to balance, purchases, request-day flags or membership update the
-- group row. Its member-only SELECT policy also authorizes Realtime updates.
alter publication supabase_realtime add table public.camp_groups;
notify pgrst, 'reload schema';
