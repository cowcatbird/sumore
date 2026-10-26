-- Owner selected 5 starting s'mores. Prepared locally; not deployed yet.
-- New circles can try one 5-s'more purchase and earn more through clean days.
-- This changes
-- only the default used by camp_ensure_group when it INSERTs a brand-new group.
-- Existing balances (including zero), day history, purchase costs, unlocks,
-- memberships and appearances are deliberately not rewritten or reset.
alter table public.camp_groups alter column balance set default 5;
