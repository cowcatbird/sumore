-- Realtime subscribers need the complete profile row when a friend changes a
-- visible field such as friend_code.

alter table public.profiles replica identity full;
