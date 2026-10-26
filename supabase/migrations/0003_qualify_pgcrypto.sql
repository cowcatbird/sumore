-- Supabase installs pgcrypto in the extensions schema. Security-definer functions
-- use a deliberately narrow search path, so crypto functions are schema-qualified.

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

revoke all on function public.create_circle_invite() from public;
revoke all on function public.redeem_circle_invite(text) from public;
grant execute on function public.create_circle_invite() to authenticated;
grant execute on function public.redeem_circle_invite(text) to authenticated;
