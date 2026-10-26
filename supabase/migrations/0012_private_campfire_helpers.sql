-- Keep request-history derivation private. These SECURITY DEFINER helpers
-- accept an arbitrary member ID; exposing them as RPCs bypasses request RLS.
-- The authenticated get_app_snapshot(text) entry point already limits seats
-- to the viewer and their active circle. Its owner can still call the helpers.
revoke execute on function public.campfire_days(uuid, text) from public, anon, authenticated;
revoke execute on function public.campfire_asked_days(uuid, text) from public, anon, authenticated;
revoke execute on function public.campfire_standing(uuid, text) from public, anon, authenticated;
