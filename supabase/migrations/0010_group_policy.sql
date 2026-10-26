-- Let each circle write its own reminder for the Requests screen.
--
-- The card at the bottom of Requests used to be hardcoded copy labelled
-- "FRIEND CODE", which collided with the friend code people swap to add each
-- other. It is now "Group policy", and the wording lives on the circle.
--
-- circles.owner_id is unique, so a circle belongs to exactly one person. This
-- policy is therefore the owner's, shown to the owner while they decide. There
-- is no shared group row to hang a single mutual policy on yet.

alter table public.circles
add column policy_title text not null default 'Be kind, not automatic.',
add column policy_body text not null default 'Ask yourself: does this sound intentional, or is it just the habit talking? There is no punishment either way.';

alter table public.circles
add constraint circles_policy_title_length check (char_length(policy_title) between 1 and 60);

alter table public.circles
add constraint circles_policy_body_length check (char_length(policy_body) between 1 and 280);

create or replace function public.update_group_policy(new_title text, new_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_title text;
  clean_body text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  clean_title := trim(coalesce(new_title, ''));
  clean_body := trim(coalesce(new_body, ''));

  if char_length(clean_title) not between 1 and 60 then
    raise exception 'Give the policy a heading between 1 and 60 characters';
  end if;
  if char_length(clean_body) not between 1 and 280 then
    raise exception 'The policy needs between 1 and 280 characters';
  end if;

  update public.circles
  set policy_title = clean_title, policy_body = clean_body
  where owner_id = auth.uid();

  if not found then raise exception 'Create a circle first'; end if;
end;
$$;

revoke all on function public.update_group_policy(text, text) from public;
grant execute on function public.update_group_policy(text, text) to authenticated;

-- get_app_snapshot: carry the owner's policy alongside everything else.
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
  group_policy_row jsonb;
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

  select jsonb_build_object(
    'title', c.policy_title,
    'body', c.policy_body
  ) into group_policy_row
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

  return jsonb_build_object(
    'profile', current_profile,
    'friends', friend_rows,
    'incomingRequests', incoming_rows,
    'outgoingRequest', outgoing_row,
    'recentDecision', recent_decision_row,
    'groupPolicy', group_policy_row
  );
end;
$$;
