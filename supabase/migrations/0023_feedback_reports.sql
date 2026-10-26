-- Automatic feedback is server-only. No mobile role may read reports, reserve
-- another user's allowance, or claim an email was delivered.
begin;

create table public.feedback_reports (
  actor_id uuid not null references auth.users(id) on delete cascade,
  report_id uuid not null,
  message text not null check (char_length(message) between 10 and 4000),
  platform text not null check (platform in ('ios', 'android', 'web')),
  app_version text not null check (char_length(app_version) between 1 and 64),
  mail_from text not null check (char_length(mail_from) between 3 and 200),
  created_at timestamptz not null default clock_timestamp(),
  status text not null default 'pending' check (status in ('pending', 'sent')),
  lease_id uuid,
  lease_until timestamptz,
  provider_id uuid,
  sent_at timestamptz,
  primary key (actor_id, report_id),
  check ((status = 'sent') = (provider_id is not null and sent_at is not null))
);
create index feedback_reports_actor_created on public.feedback_reports(actor_id, created_at);
alter table public.feedback_reports enable row level security;
revoke all on public.feedback_reports from public, anon, authenticated, service_role;

create or replace function public.feedback_reserve(
  actor_id uuid, report_id uuid, report_message text, report_platform text,
  report_version text, sender text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  row public.feedback_reports%rowtype;
  moment timestamptz;
  token uuid;
begin
  if actor_id is null or report_id is null or report_message is null
    or char_length(report_message) not between 10 and 4000
    or report_platform is null or report_platform not in ('ios', 'android', 'web')
    or report_version is null or char_length(report_version) not between 1 and 64
    or sender is null or char_length(sender) not between 3 and 200
    or sender ~ '[\r\n]' then
    return jsonb_build_object('state', 'invalid');
  end if;
  -- Serialize both different report IDs and retries for this verified user.
  -- No lock on any circle/account recovery state and no client-selectable clock.
  perform pg_advisory_xact_lock(hashtextextended('sumore-feedback:' || actor_id::text, 0));
  moment := clock_timestamp();
  select r.* into row from public.feedback_reports r
    where r.actor_id = feedback_reserve.actor_id and r.report_id = feedback_reserve.report_id for update;
  if found then
    if row.message <> report_message or row.platform <> report_platform or row.app_version <> report_version then
      return jsonb_build_object('state', 'conflict');
    end if;
    if row.status = 'sent' then return jsonb_build_object('state', 'sent'); end if;
    -- Resend caches idempotency keys for 24h. Never retry an uncertain send
    -- outside that window; this deliberately leaves a pending audit record.
    if row.created_at <= moment - interval '23 hours' then return jsonb_build_object('state', 'expired'); end if;
    if row.lease_until > moment then return jsonb_build_object('state', 'busy'); end if;
  else
    if (select count(*) from public.feedback_reports r where r.actor_id = feedback_reserve.actor_id
      and r.created_at > moment - interval '1 hour') >= 3
      or (select count(*) from public.feedback_reports r where r.actor_id = feedback_reserve.actor_id
      and r.created_at > moment - interval '24 hours') >= 10 then
      return jsonb_build_object('state', 'rateLimited');
    end if;
    insert into public.feedback_reports(actor_id, report_id, message, platform, app_version, mail_from, created_at)
      values (actor_id, report_id, report_message, report_platform, report_version, sender, moment)
      returning * into row;
  end if;
  token := gen_random_uuid();
  update public.feedback_reports r set lease_id = token, lease_until = moment + interval '90 seconds'
    where r.actor_id = feedback_reserve.actor_id and r.report_id = feedback_reserve.report_id;
  -- The original sender is preserved so provider retries have identical bodies
  -- even if FEEDBACK_FROM changes between two Edge Function invocations.
  return jsonb_build_object('state', 'ready', 'leaseId', token, 'sender', row.mail_from);
end;
$$;

create or replace function public.feedback_finish(actor_id uuid, report_id uuid, lease_id uuid, provider_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if provider_id is null then return false; end if;
  update public.feedback_reports r set status = 'sent', provider_id = feedback_finish.provider_id,
    sent_at = clock_timestamp(), lease_id = null, lease_until = null
    where r.actor_id = feedback_finish.actor_id and r.report_id = feedback_finish.report_id
      and r.status = 'pending' and r.lease_id = feedback_finish.lease_id;
  return found;
end;
$$;

create or replace function public.feedback_release(actor_id uuid, report_id uuid, lease_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.feedback_reports r set lease_id = null, lease_until = null
    where r.actor_id = feedback_release.actor_id and r.report_id = feedback_release.report_id
      and r.status = 'pending' and r.lease_id = feedback_release.lease_id;
$$;

revoke all on function public.feedback_reserve(uuid,uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.feedback_finish(uuid,uuid,uuid,uuid) from public, anon, authenticated;
revoke all on function public.feedback_release(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.feedback_reserve(uuid,uuid,text,text,text,text) to service_role;
grant execute on function public.feedback_finish(uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.feedback_release(uuid,uuid,uuid) to service_role;

commit;
