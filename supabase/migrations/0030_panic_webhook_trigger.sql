-- Deliver panic alerts to the push service.
--
-- The webhook sender (public.notify_time_request_webhook) is created by hand in
-- the SQL Editor because it embeds the function URL and webhook secret, which
-- are never committed. It is already generic: it passes TG_TABLE_NAME, so the
-- same sender works for any table. Only the trigger was missing, which meant a
-- panic event was recorded and then silently never announced.
--
-- Guarded rather than assumed: a database that has not had the webhook set up
-- yet should warn and carry on, not fail the whole migration.
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'notify_time_request_webhook'
  ) then
    drop trigger if exists panic_events_push_notifications on public.panic_events;
    create trigger panic_events_push_notifications
      after insert on public.panic_events
      for each row execute function public.notify_time_request_webhook();
  else
    raise warning 'notify_time_request_webhook is missing; panic alerts will not be delivered until the webhook is configured';
  end if;
end $$;
