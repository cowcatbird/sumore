-- New clients bind the confirmation to the account they displayed. Keep the
-- zero-argument endpoint for installed builds; it owns the transactional grant
-- and wallet logic from 0031, including the account/group locks.
create or replace function public.use_panic_button(expected_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  viewer_id uuid := auth.uid();
begin
  if viewer_id is null then raise exception 'Authentication required'; end if;
  if expected_user_id is null or expected_user_id <> viewer_id then
    raise exception 'Your account changed. Refresh and try again';
  end if;
  -- Validate before the legacy function can create/settle a group or spend.
  return public.use_panic_button();
end;
$$;

revoke all on function public.use_panic_button(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.use_panic_button(uuid) to authenticated;

-- The edge push sender calls this read-only helper with its service role.
-- Migration 0029 revoked that role along with client roles without granting it
-- back, so valid panic events could not resolve their current recipients.
revoke all on function public.panic_notification_context(uuid)
  from public, anon, authenticated;
grant execute on function public.panic_notification_context(uuid) to service_role;

notify pgrst, 'reload schema';
