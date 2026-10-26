-- Screen Time with Friends: first production-minded schema.
-- Apply this to a new Supabase project with the CLI or SQL editor.

create extension if not exists pgcrypto;

create type public.circle_member_status as enum ('invited', 'active', 'removed');
create type public.request_status as enum ('pending', 'approved', 'denied', 'expired', 'cancelled');
create type public.recipient_decision as enum ('approved', 'denied');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  handle text unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Every owner has one small trusted circle in the MVP.
create table public.circles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references public.profiles(id) on delete cascade,
  name text not null default 'My circle' check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now()
);

create table public.circle_members (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  invited_by uuid not null references public.profiles(id) on delete cascade,
  status public.circle_member_status not null default 'invited',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (circle_id, user_id)
);

create table public.device_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  token text not null unique,
  platform text not null check (platform in ('ios', 'android')),
  device_label text,
  last_seen_at timestamptz not null default now(),
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.time_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  circle_id uuid not null references public.circles(id) on delete cascade,
  minutes smallint not null check (minutes in (5, 10, 15, 30)),
  category_label text not null default 'Selected apps' check (char_length(category_label) between 1 and 40),
  reason text check (reason is null or char_length(reason) <= 240),
  status public.request_status not null default 'pending',
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  created_at timestamptz not null default now(),
  constraint decision_fields_match_status check (
    (status in ('approved', 'denied') and decided_by is not null and decided_at is not null)
    or
    (status not in ('approved', 'denied'))
  )
);

-- This snapshots who was allowed to answer when the request was made.
create table public.request_recipients (
  request_id uuid not null references public.time_requests(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz,
  decision public.recipient_decision,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (request_id, recipient_id),
  constraint recipient_decision_timestamp check (
    (decision is null and decided_at is null) or (decision is not null and decided_at is not null)
  )
);

create index time_requests_requester_created_idx on public.time_requests (requester_id, created_at desc);
create index time_requests_circle_status_idx on public.time_requests (circle_id, status, created_at desc);
create index request_recipients_user_idx on public.request_recipients (recipient_id, created_at desc);
create index circle_members_user_status_idx on public.circle_members (user_id, status);
create index device_push_tokens_user_idx on public.device_push_tokens (user_id) where disabled_at is null;

alter table public.profiles enable row level security;
alter table public.circles enable row level security;
alter table public.circle_members enable row level security;
alter table public.device_push_tokens enable row level security;
alter table public.time_requests enable row level security;
alter table public.request_recipients enable row level security;

-- Small security-definer helpers keep RLS policies readable and avoid policy recursion.
create or replace function public.is_circle_owner(target_circle_id uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.circles where id = target_circle_id and owner_id = auth.uid()) $$;

create or replace function public.is_active_circle_member(target_circle_id uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.circle_members where circle_id = target_circle_id and user_id = auth.uid() and status = 'active') $$;

create or replace function public.is_request_recipient(target_request_id uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.request_recipients where request_id = target_request_id and recipient_id = auth.uid()) $$;

create or replace function public.is_request_owner(target_request_id uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.time_requests where id = target_request_id and requester_id = auth.uid()) $$;

create policy "profiles visible to authenticated users"
on public.profiles for select to authenticated
using (true);

create policy "users update their profile"
on public.profiles for update to authenticated
using (id = auth.uid()) with check (id = auth.uid());

create policy "owners and active members view circles"
on public.circles for select to authenticated
using (
  owner_id = auth.uid()
  or public.is_active_circle_member(id)
);

create policy "owners manage their circle"
on public.circles for all to authenticated
using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "circle participants view membership"
on public.circle_members for select to authenticated
using (
  user_id = auth.uid()
  or invited_by = auth.uid()
  or public.is_circle_owner(circle_id)
);

create policy "circle owners invite members"
on public.circle_members for insert to authenticated
with check (invited_by = auth.uid() and public.is_circle_owner(circle_id));

create policy "circle owners remove members"
on public.circle_members for delete to authenticated
using (public.is_circle_owner(circle_id));

create policy "users manage their push tokens"
on public.device_push_tokens for all to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "requesters and recipients view requests"
on public.time_requests for select to authenticated
using (
  requester_id = auth.uid()
  or public.is_request_recipient(id)
);

create policy "request participants view recipients"
on public.request_recipients for select to authenticated
using (
  recipient_id = auth.uid()
  or public.is_request_owner(request_id)
);

-- Clients call RPCs below instead of writing request/decision rows directly.

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

  select id into owner_circle_id from public.circles where owner_id = auth.uid();
  if owner_circle_id is null then raise exception 'Create a circle first'; end if;

  select count(*) into active_recipient_count
  from public.circle_members
  where circle_id = owner_circle_id and status = 'active' and user_id <> auth.uid();
  if active_recipient_count = 0 then raise exception 'Add an active friend first'; end if;

  if exists (
    select 1 from public.time_requests
    where requester_id = auth.uid() and status = 'pending' and expires_at > now()
  ) then raise exception 'A request is already pending'; end if;

  insert into public.time_requests (requester_id, circle_id, minutes, reason, category_label)
  values (auth.uid(), owner_circle_id, requested_minutes, nullif(trim(request_reason), ''), request_category_label)
  returning id into new_request_id;

  insert into public.request_recipients (request_id, recipient_id)
  select new_request_id, user_id
  from public.circle_members
  where circle_id = owner_circle_id and status = 'active' and user_id <> auth.uid();

  return new_request_id;
end;
$$;

create or replace function public.decide_time_request(
  target_request_id uuid,
  requested_decision public.recipient_decision
) returns public.time_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  decided_request public.time_requests;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  perform pg_advisory_xact_lock(hashtextextended(target_request_id::text, 0));

  if not exists (
    select 1 from public.request_recipients
    where request_id = target_request_id and recipient_id = auth.uid()
  ) then raise exception 'You are not a recipient of this request'; end if;

  update public.time_requests
  set status = case requested_decision when 'approved' then 'approved'::public.request_status else 'denied'::public.request_status end,
      decided_by = auth.uid(),
      decided_at = now()
  where id = target_request_id and status = 'pending' and expires_at > now()
  returning * into decided_request;

  if decided_request.id is null then raise exception 'Request is no longer pending'; end if;

  update public.request_recipients
  set decision = requested_decision, decided_at = now()
  where request_id = target_request_id and recipient_id = auth.uid();

  return decided_request;
end;
$$;

create or replace function public.cancel_time_request(target_request_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.time_requests
  set status = 'cancelled'
  where id = target_request_id and requester_id = auth.uid() and status = 'pending';
end;
$$;

create or replace function public.respond_to_circle_invite(
  membership_id uuid,
  accept_invite boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  update public.circle_members
  set status = case when accept_invite then 'active'::public.circle_member_status else 'removed'::public.circle_member_status end,
      accepted_at = case when accept_invite then now() else null end
  where id = membership_id and user_id = auth.uid() and status = 'invited';

  if not found then raise exception 'Invitation is not available'; end if;
end;
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), 'New friend'), 60));
  insert into public.circles (owner_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

grant execute on function public.create_time_request(smallint, text, text) to authenticated;
grant execute on function public.decide_time_request(uuid, public.recipient_decision) to authenticated;
grant execute on function public.cancel_time_request(uuid) to authenticated;
grant execute on function public.respond_to_circle_invite(uuid, boolean) to authenticated;

revoke all on function public.create_time_request(smallint, text, text) from public;
revoke all on function public.decide_time_request(uuid, public.recipient_decision) from public;
revoke all on function public.cancel_time_request(uuid) from public;
revoke all on function public.respond_to_circle_invite(uuid, boolean) from public;

revoke all on function public.is_circle_owner(uuid) from public;
revoke all on function public.is_active_circle_member(uuid) from public;
revoke all on function public.is_request_recipient(uuid) from public;
revoke all on function public.is_request_owner(uuid) from public;
grant execute on function public.is_circle_owner(uuid) to authenticated;
grant execute on function public.is_active_circle_member(uuid) to authenticated;
grant execute on function public.is_request_recipient(uuid) to authenticated;
grant execute on function public.is_request_owner(uuid) to authenticated;

-- This project disables automatic table exposure, so only these client operations are granted.
grant usage on schema public to authenticated;
grant select on public.profiles, public.circles, public.circle_members,
  public.time_requests, public.request_recipients to authenticated;
grant select, insert, update, delete on public.device_push_tokens to authenticated;

-- Add time_requests and request_recipients to Realtime after applying this migration.
-- Use private channels and authorization policies before production.
