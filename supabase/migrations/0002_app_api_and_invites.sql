-- App-facing API, expiring invite codes, and realtime publication.

create table public.circle_invites (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  code_hash bytea not null unique,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  redeemed_by uuid references public.profiles(id) on delete set null,
  redeemed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint redemption_fields_match check (
    (redeemed_by is null and redeemed_at is null)
    or (redeemed_by is not null and redeemed_at is not null)
  )
);

create index circle_invites_circle_active_idx
on public.circle_invites (circle_id, expires_at desc)
where redeemed_at is null;

alter table public.circle_invites enable row level security;

create policy "owners view their circle invites"
on public.circle_invites for select to authenticated
using (public.is_circle_owner(circle_id));

create or replace function public.touch_updated_at() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop policy "profiles visible to authenticated users" on public.profiles;
create policy "profiles visible to self and circle peers"
on public.profiles for select to authenticated
using (
  id = auth.uid()
  or exists (
    select 1
    from public.circles c
    join public.circle_members cm on cm.circle_id = c.id and cm.status = 'active'
    where c.owner_id = auth.uid() and cm.user_id = profiles.id
  )
  or exists (
    select 1
    from public.circles c
    join public.circle_members cm on cm.circle_id = c.id and cm.status = 'active'
    where c.owner_id = profiles.id and cm.user_id = auth.uid()
  )
);

create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute procedure public.touch_updated_at();

create or replace function public.profile_initials(display_name text) returns text
language sql immutable
set search_path = public
as $$
  select upper(
    left(trim(display_name), 1)
    || case
      when split_part(trim(display_name), ' ', 2) = '' then ''
      else left(split_part(trim(display_name), ' ', 2), 1)
    end
  )
$$;

create or replace function public.update_my_profile(
  new_display_name text,
  new_handle text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(trim(new_display_name)) not between 1 and 60 then
    raise exception 'Display name must be between 1 and 60 characters';
  end if;
  if lower(trim(new_handle)) !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'Handle must be 3–24 letters, numbers, or underscores';
  end if;

  update public.profiles
  set display_name = trim(new_display_name), handle = lower(trim(new_handle))
  where id = auth.uid();
end;
$$;

create or replace function public.create_circle_invite() returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_circle_id uuid;
  invite_code text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select id into owner_circle_id from public.circles where owner_id = auth.uid();
  if owner_circle_id is null then raise exception 'Create a circle first'; end if;

  -- Keep one live code per circle so old screenshots and messages stop working.
  update public.circle_invites
  set expires_at = now()
  where circle_id = owner_circle_id and redeemed_at is null and expires_at > now();

  invite_code := 'CIRCLE-' || upper(substr(encode(extensions.gen_random_bytes(4), 'hex'), 1, 8));

  insert into public.circle_invites (circle_id, created_by, code_hash)
  values (owner_circle_id, auth.uid(), extensions.digest(invite_code, 'sha256'));

  return invite_code;
end;
$$;

create or replace function public.redeem_circle_invite(invite_code text) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_invite public.circle_invites;
  circle_owner_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into selected_invite
  from public.circle_invites
  where code_hash = extensions.digest(upper(trim(invite_code)), 'sha256')
    and redeemed_at is null
    and expires_at > now()
  for update;

  if selected_invite.id is null then raise exception 'Invite is invalid or expired'; end if;

  select owner_id into circle_owner_id from public.circles where id = selected_invite.circle_id;
  if circle_owner_id = auth.uid() then raise exception 'You cannot join your own circle'; end if;

  insert into public.circle_members (circle_id, user_id, invited_by, status, accepted_at)
  values (selected_invite.circle_id, auth.uid(), circle_owner_id, 'active', now())
  on conflict (circle_id, user_id)
  do update set status = 'active', accepted_at = now(), invited_by = excluded.invited_by;

  -- Friendship is reciprocal: the inviter can also answer requests from the person joining.
  insert into public.circle_members (circle_id, user_id, invited_by, status, accepted_at)
  select c.id, circle_owner_id, auth.uid(), 'active', now()
  from public.circles c
  where c.owner_id = auth.uid()
  on conflict (circle_id, user_id)
  do update set status = 'active', accepted_at = now(), invited_by = excluded.invited_by;

  update public.circle_invites
  set redeemed_by = auth.uid(), redeemed_at = now()
  where id = selected_invite.id;
end;
$$;

create or replace function public.get_app_snapshot() returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_profile jsonb;
  friend_rows jsonb;
  incoming_rows jsonb;
  outgoing_row jsonb;
  recent_decision_row jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  update public.time_requests
  set status = 'expired'
  where status = 'pending' and expires_at <= now();

  select jsonb_build_object(
    'id', p.id,
    'displayName', p.display_name,
    'handle', p.handle,
    'initials', public.profile_initials(p.display_name)
  ) into current_profile
  from public.profiles p
  where p.id = auth.uid();

  select coalesce(jsonb_agg(friend order by friend ->> 'displayName'), '[]'::jsonb)
  into friend_rows
  from (
    select jsonb_build_object(
      'id', p.id,
      'displayName', p.display_name,
      'handle', p.handle,
      'initials', public.profile_initials(p.display_name),
      'color', (array['#FFD2BF', '#CDEBD8', '#D9D0FF', '#FFE5A7'])[
        (1 + mod(abs(hashtextextended(p.id::text, 0)), 4))::integer
      ],
      'online', false,
      'membershipId', cm.id
    ) as friend
    from public.circles c
    join public.circle_members cm on cm.circle_id = c.id and cm.status = 'active'
    join public.profiles p on p.id = cm.user_id
    where c.owner_id = auth.uid() and cm.user_id <> auth.uid()
  ) friends;

  select coalesce(jsonb_agg(incoming order by incoming ->> 'createdAt' desc), '[]'::jsonb)
  into incoming_rows
  from (
    select jsonb_build_object(
      'id', tr.id,
      'friend', jsonb_build_object(
        'id', requester.id,
        'displayName', requester.display_name,
        'handle', requester.handle,
        'initials', public.profile_initials(requester.display_name),
        'color', '#FFD2BF',
        'online', false
      ),
      'minutes', tr.minutes,
      'categoryLabel', tr.category_label,
      'reason', coalesce(tr.reason, ''),
      'status', tr.status,
      'createdAt', tr.created_at,
      'expiresAt', tr.expires_at
    ) as incoming
    from public.request_recipients rr
    join public.time_requests tr on tr.id = rr.request_id
    join public.profiles requester on requester.id = tr.requester_id
    where rr.recipient_id = auth.uid()
      and rr.decision is null
      and tr.status = 'pending'
      and tr.expires_at > now()
  ) requests;

  select jsonb_build_object(
    'id', tr.id,
    'minutes', tr.minutes,
    'categoryLabel', tr.category_label,
    'status', tr.status,
    'createdAt', tr.created_at,
    'expiresAt', tr.expires_at
  ) into outgoing_row
  from public.time_requests tr
  where tr.requester_id = auth.uid()
    and tr.status = 'pending'
    and tr.expires_at > now()
  order by tr.created_at desc
  limit 1;

  select jsonb_build_object(
    'id', tr.id,
    'minutes', tr.minutes,
    'status', tr.status,
    'decidedAt', tr.decided_at
  ) into recent_decision_row
  from public.time_requests tr
  where tr.requester_id = auth.uid()
    and tr.status in ('approved', 'denied')
    and tr.decided_at > now() - interval '10 minutes'
  order by tr.decided_at desc
  limit 1;

  return jsonb_build_object(
    'profile', current_profile,
    'friends', friend_rows,
    'incomingRequests', incoming_rows,
    'outgoingRequest', outgoing_row,
    'recentDecision', recent_decision_row
  );
end;
$$;

-- Five requests per rolling hour is generous for normal use and limits spam.
create or replace function public.create_time_request(
  requested_minutes smallint,
  request_reason text default null,
  request_category_label text default 'Selected apps'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_circle_id uuid;
  new_request_id uuid;
  active_recipient_count integer;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if requested_minutes not in (5, 10, 15, 30) then raise exception 'Invalid number of minutes'; end if;
  if request_reason is not null and char_length(request_reason) > 240 then raise exception 'Reason is too long'; end if;
  if char_length(request_category_label) not between 1 and 40 then raise exception 'Invalid category label'; end if;

  select id into owner_circle_id from public.circles where owner_id = auth.uid();
  if owner_circle_id is null then raise exception 'Create a circle first'; end if;

  select count(*) into active_recipient_count
  from public.circle_members
  where circle_id = owner_circle_id and status = 'active' and user_id <> auth.uid();
  if active_recipient_count = 0 then raise exception 'Add an active friend first'; end if;

  update public.time_requests
  set status = 'expired'
  where requester_id = auth.uid() and status = 'pending' and expires_at <= now();

  if exists (
    select 1 from public.time_requests
    where requester_id = auth.uid() and status = 'pending' and expires_at > now()
  ) then raise exception 'A request is already pending'; end if;

  if (
    select count(*) from public.time_requests
    where requester_id = auth.uid() and created_at > now() - interval '1 hour'
  ) >= 5 then raise exception 'Please wait before sending another request'; end if;

  insert into public.time_requests (requester_id, circle_id, minutes, reason, category_label)
  values (auth.uid(), owner_circle_id, requested_minutes, nullif(trim(request_reason), ''), trim(request_category_label))
  returning id into new_request_id;

  insert into public.request_recipients (request_id, recipient_id)
  select new_request_id, user_id
  from public.circle_members
  where circle_id = owner_circle_id and status = 'active' and user_id <> auth.uid();

  return new_request_id;
end;
$$;

grant execute on function public.get_app_snapshot() to authenticated;
grant execute on function public.update_my_profile(text, text) to authenticated;
grant execute on function public.create_circle_invite() to authenticated;
grant execute on function public.redeem_circle_invite(text) to authenticated;

revoke all on function public.get_app_snapshot() from public;
revoke all on function public.update_my_profile(text, text) from public;
revoke all on function public.create_circle_invite() from public;
revoke all on function public.redeem_circle_invite(text) from public;

revoke all on function public.profile_initials(text) from public;
grant execute on function public.profile_initials(text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'time_requests'
  ) then alter publication supabase_realtime add table public.time_requests; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'request_recipients'
  ) then alter publication supabase_realtime add table public.request_recipients; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'circle_members'
  ) then alter publication supabase_realtime add table public.circle_members; end if;
end $$;
