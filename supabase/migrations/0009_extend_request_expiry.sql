-- Give friends longer to answer: requests now expire after 20 minutes, not 5.
--
-- Only the default lifetime changes. The expiry guards in create_time_request,
-- decide_time_request, and get_app_snapshot already read expires_at, so they
-- pick this up without being redefined. The hourly rate limit is unchanged.

alter table public.time_requests
alter column expires_at set default (now() + interval '20 minutes');

-- Extend requests that are still waiting so nobody loses their window mid-flight.
update public.time_requests
set expires_at = created_at + interval '20 minutes'
where status = 'pending';
