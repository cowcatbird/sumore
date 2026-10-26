-- Add the supplied free hats without changing existing cosmetics or shop rules.
-- No wallet grants, purchases, memberships or character revisions are modified.
alter table public.profiles
  drop constraint profiles_character_shape,
  add constraint profiles_character_shape check (
    (character_hat is null and character_body is null)
    or (character_hat is not null and character_body is not null
      and character_hat in (
        'none','cowboy','cow','cat','sunglasses','duck','top-hat','halo','crown',
        'beanie','bucket','headband','propeller','wizard','pirate','clown','viking'
      )
      and character_body in ('short','tall'))
  );

-- Keep the single five-argument RPC with its optional color argument: legacy
-- four-argument calls continue to preserve an already selected body color.
create or replace function public.update_my_character(target_profile_id uuid, new_hat text, new_body text,
  expected_revision integer, new_color text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare saved public.profiles; group_key uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if target_profile_id is distinct from auth.uid() then raise exception 'This camper belongs to a different account'; end if;
  if new_hat is null or new_hat not in (
      'none','cowboy','cow','cat','sunglasses','duck','top-hat','halo','crown',
      'beanie','bucket','headband','propeller','wizard','pirate','clown','viking'
    )
    or new_body is null or new_body not in ('short','tall') or expected_revision is null or expected_revision < 0
    or (new_color is not null and new_color not in ('cream','blue','orange','pink'))
    then raise exception 'Choose a supported hat, body and color'; end if;
  group_key := public.camp_ensure_group(auth.uid());
  perform 1 from public.camp_groups where id = group_key for update;
  update public.profiles set character_hat = new_hat, character_body = new_body,
    character_color = coalesce(new_color, character_color), character_revision = character_revision + 1
    where id = auth.uid() and character_revision = expected_revision returning * into saved;
  if saved.id is null then raise exception 'Your camper changed on another device. Refresh and retry your choice.' using errcode = '40001'; end if;
  return jsonb_build_object('appearance', jsonb_build_object('hat', saved.character_hat, 'body', saved.character_body,
    'color', saved.character_color), 'revision', saved.character_revision);
end;
$$;

-- The existing paid-cosmetic trigger still requires the crown/color unlocks.
-- Do not add the free hats to camp_group_unlocks or purchase_circle_item.
revoke all on function public.update_my_character(uuid,text,text,integer,text) from public, anon, authenticated;
grant execute on function public.update_my_character(uuid,text,text,integer,text) to authenticated;
notify pgrst, 'reload schema';
