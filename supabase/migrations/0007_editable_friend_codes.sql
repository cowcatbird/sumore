-- Replace one-time invite codes in the app with an editable profile friend code.
-- Existing circle relationships stay intact when either person changes their code.

alter table public.profiles
add column friend_code text;

create or replace function public.generate_friend_code() returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  candidate text;
begin
  loop
    candidate := upper(substr(encode(extensions.gen_random_bytes(5), 'hex'), 1, 8));
    exit when not exists (
      select 1 from public.profiles where friend_code = candidate
    );
  end loop;
  return candidate;
end;
$$;

do $$
declare
  profile_row record;
begin
  for profile_row in select id from public.profiles loop
    update public.profiles
    set friend_code = public.generate_friend_code()
    where id = profile_row.id;
  end loop;
end $$;

alter table public.profiles
alter column friend_code set not null;

alter table public.profiles
add constraint profiles_friend_code_format
check (friend_code ~ '^[A-Z0-9]{4,16}$');

alter table public.profiles
add constraint profiles_friend_code_unique unique (friend_code);

create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_name text;
  requested_handle text;
begin
  requested_name := trim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  requested_handle := lower(trim(coalesce(new.raw_user_meta_data ->> 'handle', '')));

  if char_length(requested_name) not between 1 and 60 then
    raise exception 'A display name is required';
  end if;
  if requested_handle <> '' and requested_handle !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'Handle must be 3-24 letters, numbers, or underscores';
  end if;

  insert into public.profiles (id, display_name, handle, friend_code)
  values (new.id, requested_name, nullif(requested_handle, ''), public.generate_friend_code());
  insert into public.circles (owner_id) values (new.id);
  return new;
exception
  when unique_violation then
    raise exception 'That handle or friend code is already taken';
end;
$$;

create or replace function public.update_my_friend_code(new_friend_code text) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_code text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  normalized_code := upper(trim(new_friend_code));
  if normalized_code !~ '^[A-Z0-9]{4,16}$' then
    raise exception 'Friend code must be 4-16 letters or numbers';
  end if;

  update public.profiles
  set friend_code = normalized_code
  where id = auth.uid();
exception
  when unique_violation then
    raise exception 'That friend code is already taken';
end;
$$;

create or replace function public.add_friend_by_code(friend_code_input text) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_code text;
  friend_id uuid;
  my_circle_id uuid;
  friend_circle_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  normalized_code := upper(trim(friend_code_input));

  select id into friend_id
  from public.profiles
  where friend_code = normalized_code;

  if friend_id is null then raise exception 'Friend code not found'; end if;
  if friend_id = auth.uid() then raise exception 'You cannot add yourself'; end if;

  select id into my_circle_id from public.circles where owner_id = auth.uid();
  select id into friend_circle_id from public.circles where owner_id = friend_id;
  if my_circle_id is null or friend_circle_id is null then
    raise exception 'A circle is still being prepared';
  end if;

  if exists (
    select 1 from public.circle_members
    where circle_id = my_circle_id and user_id = friend_id and status = 'active'
  ) then raise exception 'You are already friends'; end if;

  if (
    select count(*) from public.circle_members
    where circle_id = my_circle_id and status = 'active' and user_id <> auth.uid()
  ) >= 5 then raise exception 'Your circle already has five friends'; end if;

  if (
    select count(*) from public.circle_members
    where circle_id = friend_circle_id and status = 'active' and user_id <> friend_id
  ) >= 5 then raise exception 'That friend already has a full circle'; end if;

  insert into public.circle_members (circle_id, user_id, invited_by, status, accepted_at)
  values (my_circle_id, friend_id, auth.uid(), 'active', now())
  on conflict (circle_id, user_id)
  do update set status = 'active', accepted_at = now(), invited_by = excluded.invited_by;

  insert into public.circle_members (circle_id, user_id, invited_by, status, accepted_at)
  values (friend_circle_id, auth.uid(), friend_id, 'active', now())
  on conflict (circle_id, user_id)
  do update set status = 'active', accepted_at = now(), invited_by = excluded.invited_by;
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
    'friendCode', p.friend_code,
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
      'friendCode', p.friend_code,
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
        'friendCode', requester.friend_code,
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

revoke all on function public.generate_friend_code() from public;
revoke all on function public.update_my_friend_code(text) from public;
revoke all on function public.add_friend_by_code(text) from public;
grant execute on function public.update_my_friend_code(text) to authenticated;
grant execute on function public.add_friend_by_code(text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles'
  ) then alter publication supabase_realtime add table public.profiles; end if;
end $$;
