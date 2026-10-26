-- Run this once in the Supabase SQL Editor after replacing both placeholders.
-- Never commit the real webhook secret.

create extension if not exists pg_net with schema extensions;

create or replace function public.notify_time_request_webhook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform net.http_post(
    url := 'YOUR_FUNCTION_URL',
    headers := '{"Content-Type":"application/json","x-webhook-secret":"YOUR_WEBHOOK_SECRET"}'::jsonb,
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(NEW),
      'old_record', case when TG_OP = 'UPDATE' then to_jsonb(OLD) else null end
    ),
    timeout_milliseconds := 5000
  );
  return NEW;
end;
$$;

revoke all on function public.notify_time_request_webhook() from public, anon, authenticated;

drop trigger if exists time_requests_push_notifications on public.time_requests;
create trigger time_requests_push_notifications
after insert or update on public.time_requests
for each row execute function public.notify_time_request_webhook();

-- The same sender also announces panic-button presses. Migration 0028 attaches
-- this trigger automatically once the function above exists.
drop trigger if exists panic_events_push_notifications on public.panic_events;
create trigger panic_events_push_notifications
after insert on public.panic_events
for each row execute function public.notify_time_request_webhook();
