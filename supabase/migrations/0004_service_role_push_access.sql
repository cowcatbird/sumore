-- Edge Functions use the service_role database role for trusted server-side reads.
-- RLS is still enforced for mobile clients using the authenticated role.
grant select on table
  public.profiles,
  public.time_requests,
  public.request_recipients,
  public.device_push_tokens
to service_role;
