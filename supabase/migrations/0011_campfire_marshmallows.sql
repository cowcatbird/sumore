-- The campfire: seats, marshmallows, and streaks.
--
-- Product rule, stated once so the SQL below can be read against it:
--
--   A person who sends no time request during a local day cooks one golden
--   brown marshmallow for that day. Sending a request removes them from the
--   fire for that day: no marshmallow, and the streak returns to zero.
--
-- Days are LOCAL days. A student who asks for more time at 11pm PT must not
-- have it counted against the following day, so every function here takes an
-- IANA timezone from the client and does its date arithmetic in it. UTC would
-- roll the day over at 4pm Pacific, which is the middle of the usage the
-- product exists to interrupt.
--
-- Nothing here writes a row. Marshmallows and streaks are derived from
-- time_requests, which is already the append-only record of who asked and
-- when. A separate tally table could disagree with that history; a derivation
-- cannot.

-- Days a person has been eligible to cook: from their account's local creation
-- day up to and including today. Capped at a year so the series stays small.
create or replace function public.campfire_days(member_id uuid, tz text)
returns table (day date)
language sql
stable
security definer
set search_path = public
as $$
  select generate_series(
    greatest(
      (p.created_at at time zone tz)::date,
      ((now() at time zone tz)::date - 365)
    ),
    (now() at time zone tz)::date,
    interval '1 day'
  )::date
  from public.profiles p
  where p.id = member_id;
$$;

-- Local days on which this person sent at least one request.
create or replace function public.campfire_asked_days(member_id uuid, tz text)
returns table (day date)
language sql
stable
security definer
set search_path = public
as $$
  select distinct (tr.created_at at time zone tz)::date as day
  from public.time_requests tr
  where tr.requester_id = member_id
    and tr.created_at >= now() - interval '400 days';
$$;

-- One person's campfire standing.
--
-- `streak` counts backwards from today while the days stay clean, so a person
-- who has not asked today sees today included. That is the number they expect
-- to see on their own seat, and it drops to zero the moment they ask.
--
-- `golden` counts only COMPLETED clean days. Today is still cooking and is
-- deliberately excluded: a marshmallow that could still be lost is not yet
-- golden.
create or replace function public.campfire_standing(member_id uuid, tz text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone tz)::date;
  asked_today boolean;
  streak integer := 0;
  golden integer := 0;
  cursor_day date;
  first_day date;
begin
  select exists (
    select 1 from public.campfire_asked_days(member_id, tz) d where d.day = today
  ) into asked_today;

  select count(*)
  into golden
  from public.campfire_days(member_id, tz) d
  where d.day < today
    and not exists (
      select 1 from public.campfire_asked_days(member_id, tz) a where a.day = d.day
    );

  -- Walk back from today until a day with a request breaks the run.
  --
  -- Both guards matter. `first_day` is coalesced because an empty day series
  -- (a profile whose created_at sits in the future, via clock skew) would make
  -- the comparison NULL, which is not true, and the loop would never exit. The
  -- hard counter is a second floor under that: this runs inside a snapshot the
  -- client polls, and a runaway loop here would hang the whole app.
  if not asked_today then
    select coalesce(min(d.day), today) into first_day
    from public.campfire_days(member_id, tz) d;

    cursor_day := today;
    while cursor_day >= first_day and streak < 3650 loop
      exit when exists (
        select 1 from public.campfire_asked_days(member_id, tz) a where a.day = cursor_day
      );
      streak := streak + 1;
      cursor_day := cursor_day - 1;
    end loop;
  end if;

  return jsonb_build_object(
    'askedToday', asked_today,
    'streak', streak,
    'golden', golden
  );
end;
$$;

revoke all on function public.campfire_days(uuid, text) from public;
revoke all on function public.campfire_asked_days(uuid, text) from public;
revoke all on function public.campfire_standing(uuid, text) from public;
grant execute on function public.campfire_days(uuid, text) to authenticated;
grant execute on function public.campfire_asked_days(uuid, text) to authenticated;
grant execute on function public.campfire_standing(uuid, text) to authenticated;

-- get_app_snapshot gains a campfire, and a timezone to compute it in.
--
-- The old zero-argument function has to go first. Leaving it in place beside a
-- one-argument version with a default makes `get_app_snapshot()` ambiguous, and
-- Postgres refuses the call outright.
drop function if exists public.get_app_snapshot();
--
-- The tz argument carries a default so an older client that has not been
-- updated keeps working instead of failing to find the function.
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
