-- Shared cosmetics only. Existing names, IDs, friend codes, circle membership,
-- request rules, and marshmallow standing are unchanged.
alter table public.profiles
  add column character_hat text,
  add column character_body text,
  add column character_revision integer not null default 0,
  add constraint profiles_character_shape check (
    (character_hat is null and character_body is null)
    or (character_hat is not null and character_body is not null
      and character_hat in ('none','cowboy','cow','cat','sunglasses','duck','top-hat','halo','crown')
      and character_body in ('short','tall'))
  ),
  add constraint profiles_character_revision_nonnegative check (character_revision >= 0);

create or replace function public.update_my_character(
  target_profile_id uuid,
  new_hat text,
  new_body text,
  expected_revision integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved public.profiles;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if target_profile_id is distinct from auth.uid() then
    raise exception 'This camper belongs to a different account';
  end if;
  if new_hat is null or new_hat not in ('none','cowboy','cow','cat','sunglasses','duck','top-hat','halo','crown')
    or new_body is null or new_body not in ('short','tall')
    or expected_revision is null or expected_revision < 0
  then raise exception 'Choose a supported hat and body'; end if;

  -- A queued request cannot overwrite a later save or another user's profile.
  -- Importing an old local look uses revision zero, only while unset.
  update public.profiles
  set character_hat = new_hat,
      character_body = new_body,
      character_revision = character_revision + 1
  where id = auth.uid() and character_revision = expected_revision
  returning * into saved;
  if saved.id is null then
    raise exception 'Your camper changed on another device. Refresh and retry your choice.' using errcode = '40001';
  end if;
  return jsonb_build_object(
    'appearance', jsonb_build_object('hat', saved.character_hat, 'body', saved.character_body),
    'revision', saved.character_revision
  );
end;
$$;
revoke all on function public.update_my_character(uuid,text,text,integer) from public, anon, authenticated;
grant execute on function public.update_my_character(uuid,text,text,integer) to authenticated;

-- Keep the existing owner/member/request-recipient visibility from 0011.
-- Only additive character fields differ in the snapshot implementation below.

create or replace function public.get_app_snapshot(tz text default 'UTC')
returns jsonb
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
  group_policy_row jsonb;
  campfire_row jsonb;
  safe_tz text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  -- An unknown zone name would abort the whole snapshot, so fall back rather
  -- than fail: a wrong day boundary beats a blank screen.
  begin
    perform now() at time zone tz;
    safe_tz := tz;
  exception when others then
    safe_tz := 'UTC';
  end;

  update public.time_requests
  set status = 'expired'
  where status = 'pending' and expires_at <= now();

  select jsonb_build_object(
    'id', p.id,
    'displayName', p.display_name,
      'character', jsonb_build_object(
        'appearance', case when p.character_hat is null then null else
          jsonb_build_object('hat', p.character_hat, 'body', p.character_body) end,
        'revision', p.character_revision
      ),
    'handle', p.handle,
    'friendCode', p.friend_code,
    'initials', public.profile_initials(p.display_name)
  ) into current_profile
  from public.profiles p
  where p.id = auth.uid();

  select jsonb_build_object('title', c.policy_title, 'body', c.policy_body)
  into group_policy_row
  from public.circles c
  where c.owner_id = auth.uid();

  select coalesce(jsonb_agg(friend order by friend ->> 'displayName'), '[]'::jsonb)
  into friend_rows
  from (
    select jsonb_build_object(
      'id', p.id,
      'displayName', p.display_name,
      'character', jsonb_build_object(
        'appearance', case when p.character_hat is null then null else
          jsonb_build_object('hat', p.character_hat, 'body', p.character_body) end,
        'revision', p.character_revision
      ),
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
      'character', jsonb_build_object(
        'appearance', case when requester.character_hat is null then null else
          jsonb_build_object('hat', requester.character_hat, 'body', requester.character_body) end,
        'revision', requester.character_revision
      ),
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

  -- Every seat at the fire: the viewer first, then the circle. The viewer is
  -- included so the scene is never empty and so people see their own streak
  -- beside everyone else's, which is the whole point of the accountability.
  select jsonb_build_object(
    'localDate', (now() at time zone safe_tz)::date,
    'seats', coalesce(jsonb_agg((seat - 'sortKey') order by seat ->> 'sortKey'), '[]'::jsonb),
    'groupGolden', coalesce(sum((seat ->> 'golden')::integer), 0)
  ) into campfire_row
  from (
    select jsonb_build_object(
      'id', member.id,
      'displayName', member.display_name,
      'character', jsonb_build_object(
        'appearance', case when member.character_hat is null then null else
          jsonb_build_object('hat', member.character_hat, 'body', member.character_body) end,
        'revision', member.character_revision
      ),
      'initials', public.profile_initials(member.display_name),
      'isYou', member.id = auth.uid(),
      'sortKey', case when member.id = auth.uid() then '0' else '1' end
        || public.profile_initials(member.display_name),
      'askedToday', (standing.value ->> 'askedToday')::boolean,
      'streak', (standing.value ->> 'streak')::integer,
      'golden', (standing.value ->> 'golden')::integer
    ) as seat
    from public.profiles member
    cross join lateral (select public.campfire_standing(member.id, safe_tz) as value) standing
    where member.id = auth.uid()
       or member.id in (
         select cm.user_id
         from public.circles c
         join public.circle_members cm on cm.circle_id = c.id and cm.status = 'active'
         where c.owner_id = auth.uid() and cm.user_id <> auth.uid()
       )
  ) seats;

  return jsonb_build_object(
    'profile', current_profile,
    'friends', friend_rows,
    'incomingRequests', incoming_rows,
    'outgoingRequest', outgoing_row,
    'recentDecision', recent_decision_row,
    'groupPolicy', group_policy_row,
    'campfire', campfire_row
  );
end;
$$;

revoke all on function public.get_app_snapshot(text) from public;
grant execute on function public.get_app_snapshot(text) to authenticated;

-- Make the new RPC visible immediately after this migration commits.
notify pgrst, 'reload schema';
