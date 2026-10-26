-- Current shared-circle prices. Historical purchases keep both their recorded
-- cost and entitlement. This migration does not grant or re-price any balance.
alter table public.camp_group_unlocks
  drop constraint camp_group_unlocks_item_id_check,
  drop constraint camp_group_unlocks_check,
  add constraint camp_group_unlocks_item_id_check check (item_id in (
    'hat:crown','hat:wizard','hat:pirate','hat:clown','hat:viking',
    'color:blue','color:orange','color:pink','background:beach'
  )),
  add constraint camp_group_unlocks_cost_check check (
    (item_id = 'hat:crown' and cost in (1, 10))
    or (item_id in ('hat:wizard','hat:pirate','hat:clown','hat:viking') and cost = 5)
    or (item_id in ('color:blue','color:orange','color:pink') and cost in (1, 5))
    or (item_id = 'background:beach' and cost = 30)
  );

-- Old installed clients reject unknown unlock IDs. Keep their RPC responses
-- within the original catalog without changing ownership, balances or dates.
create function public.camp_catalog_v1_shop(payload jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_set(payload, '{unlocked}', coalesce((
    select jsonb_agg(item order by position)
    from jsonb_array_elements(payload -> 'unlocked') with ordinality as entries(item, position)
    where item #>> '{}' in ('hat:crown','color:blue','color:orange','color:pink','background:beach')
  ), '[]'::jsonb))
$$;

create function public.camp_catalog_v1_character(payload jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select case when payload #>> '{appearance,hat}' is not null
    and payload #>> '{appearance,hat}' not in ('none','cowboy','cow','cat','sunglasses','duck','top-hat','halo','crown')
    then jsonb_set(payload, '{appearance,hat}', '"none"'::jsonb) else payload end
$$;

-- One signature with a default preserves two-argument callers without ambiguous
-- PostgREST overloads. Never charge an old client's displayed 1-s'more offer at
-- the new price. Historical owned retries remain free; beach is still 30.
drop function public.purchase_circle_item(uuid,text);
create function public.purchase_circle_item(
  target_group_id uuid, item_id text, expected_cost integer default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid; price integer; already_owned boolean; payload jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  group_key := public.camp_ensure_group(auth.uid());
  if group_key is distinct from target_group_id then raise exception 'Your circle changed. Refresh and try again'; end if;
  price := case
    when item_id = 'hat:crown' then 10
    when item_id in ('hat:wizard','hat:pirate','hat:clown','hat:viking','color:blue','color:orange','color:pink') then 5
    when item_id = 'background:beach' then 30
    else null end;
  if price is null then raise exception 'Choose an available shop item'; end if;
  perform 1 from public.camp_groups where id = group_key for update;
  select exists (select 1 from public.camp_group_unlocks u
    where u.group_id = group_key and u.item_id = purchase_circle_item.item_id) into already_owned;
  if not already_owned then
    if expected_cost is null and item_id <> 'background:beach' then
      raise exception 'Update sumore to see the latest shop prices';
    end if;
    if expected_cost is not null and expected_cost <> price then
      raise exception 'The price changed. Refresh the shop and try again';
    end if;
  end if;
  -- Validate the displayed cost before settlement or wallet mutations. Holding
  -- the group lock makes simultaneous confirmations and retries charge once.
  perform public.camp_settle(group_key);
  if not already_owned then
    update public.camp_groups set balance = balance - price, updated_at = clock_timestamp()
      where id = group_key and balance >= price;
    if not found then raise exception 'Your circle needs more s’mores'; end if;
    insert into public.camp_group_unlocks (group_id, item_id, cost)
      values (group_key, purchase_circle_item.item_id, price);
  end if;
  payload := public.camp_shop_payload(group_key);
  return case when expected_cost is null then public.camp_catalog_v1_shop(payload) else payload end;
end;
$$;

-- Preserve the existing trigger on both RPC and any accidental direct profile
-- writes. A free hat never bypasses the separate paid body-color requirement.
create or replace function public.camp_check_character_unlock() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid;
begin
  select group_id into group_key from public.camp_group_members where user_id = new.id;
  if new.character_hat in ('crown','wizard','pirate','clown','viking') and not exists (
    select 1 from public.camp_group_unlocks where group_id = group_key and item_id = 'hat:' || new.character_hat
  ) then
    if new.character_hat = 'crown' then raise exception 'Unlock the crown in your circle’s shop first'; end if;
    raise exception 'Unlock this hat in your circle’s shop first';
  end if;
  if new.character_color <> 'cream' and not exists (select 1 from public.camp_group_unlocks
    where group_id = group_key and item_id = 'color:' || new.character_color)
    then raise exception 'Unlock this color in your circle’s shop first'; end if;
  return new;
end;
$$;

-- Group moves discard only cosmetics that the destination has not unlocked.
-- Already-purchased items remain owned regardless of their historical price.
create or replace function public.camp_reconcile_character(member_id uuid, target_group_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.profiles p set
    character_hat = case when p.character_hat in ('crown','wizard','pirate','clown','viking') and not exists (
      select 1 from public.camp_group_unlocks where group_id = target_group_id and item_id = 'hat:' || p.character_hat
    ) then 'none' else p.character_hat end,
    character_color = case when p.character_color <> 'cream' and not exists (
      select 1 from public.camp_group_unlocks where group_id = target_group_id and item_id = 'color:' || p.character_color
    ) then 'cream' else p.character_color end,
    character_revision = character_revision + 1
  where p.id = member_id and (
    (p.character_hat in ('crown','wizard','pirate','clown','viking') and not exists (
      select 1 from public.camp_group_unlocks where group_id = target_group_id and item_id = 'hat:' || p.character_hat))
    or (p.character_color <> 'cream' and not exists (select 1 from public.camp_group_unlocks
      where group_id = target_group_id and item_id = 'color:' || p.character_color))
  );
end;
$$;

-- If an old client equipped a now-paid free hat before this migration, refresh
-- its own appearance once before returning the snapshot. No auto-purchase or
-- balance change occurs, and owned cosmetics are never reset. Keep this outside
-- camp_ensure_group: join_shared_circle must acquire its two group locks in order.
create function public.get_circle_shop_v2(tz text default 'UTC') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  group_key := public.camp_ensure_group(auth.uid(), tz);
  perform 1 from public.camp_groups where id = group_key for update;
  perform public.camp_reconcile_character(auth.uid(), group_key);
  return public.camp_shop_payload(group_key);
end;
$$;

create or replace function public.get_circle_shop(tz text default 'UTC') returns jsonb
language sql security definer set search_path = ''
as $$ select public.camp_catalog_v1_shop(public.get_circle_shop_v2(tz)) $$;

-- The old background RPC also returns a wallet that shipped clients validate.
alter function public.set_circle_background(uuid,text) rename to set_circle_background_v2;
create function public.set_circle_background(target_group_id uuid, new_background text) returns jsonb
language sql security definer set search_path = ''
as $$ select public.camp_catalog_v1_shop(public.set_circle_background_v2(target_group_id, new_background)) $$;

-- A peer may still have a pre-upgrade free hat stored until their own refresh.
-- Filter only the serialized look using that person's actual group unlocks.
-- Do not update/lock peer profiles or invent a revision: their next own refresh
-- performs the real reconciliation through the existing revision protocol.
create or replace function public.camp_character(member public.profiles) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('appearance', case when member.character_hat is null then null else
    jsonb_build_object(
      'hat', case when member.character_hat in ('crown','wizard','pirate','clown','viking') and not exists (
        select 1 from public.camp_group_members m join public.camp_group_unlocks u on u.group_id = m.group_id
        where m.user_id = member.id and u.item_id = 'hat:' || member.character_hat
      ) then 'none' else member.character_hat end,
      'body', member.character_body,
      'color', case when member.character_color <> 'cream' and not exists (
        select 1 from public.camp_group_members m join public.camp_group_unlocks u on u.group_id = m.group_id
        where m.user_id = member.id and u.item_id = 'color:' || member.character_color
      ) then 'cream' else member.character_color end
    ) end, 'revision', member.character_revision)
$$;

-- Full catalog snapshot. Keep request visibility and the shared roster exactly
-- as before; only the versioned shop call differs from the previous endpoint.
create function public.get_app_snapshot_v2(tz text default 'UTC') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare result jsonb; shop jsonb; group_key uuid; member_rows jsonb; seat_rows jsonb; profile_row public.profiles;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  shop := public.get_circle_shop_v2(tz);
  group_key := (shop ->> 'id')::uuid;
  result := public.camp_legacy_snapshot(shop ->> 'timeZone');
  select * into profile_row from public.profiles where id = auth.uid();
  result := jsonb_set(result, '{profile,character}', public.camp_character(profile_row));
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'displayName', p.display_name, 'friendCode', p.friend_code, 'initials', public.profile_initials(p.display_name),
    'color', '#FFD2BF', 'online', false, 'character', public.camp_character(p)
  ) order by p.display_name, p.id), '[]'::jsonb) into member_rows
    from public.camp_group_members m join public.profiles p on p.id = m.user_id
    where m.group_id = group_key and p.id <> auth.uid();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'displayName', p.display_name, 'initials', public.profile_initials(p.display_name), 'isYou', p.id = auth.uid(),
    'askedToday', (standing.value ->> 'askedToday')::boolean, 'streak', (standing.value ->> 'streak')::integer,
    'golden', 0, 'character', public.camp_character(p)
  ) order by p.id <> auth.uid(), p.display_name, p.id), '[]'::jsonb) into seat_rows
    from public.camp_group_members m join public.profiles p on p.id = m.user_id
    cross join lateral (select public.campfire_standing(p.id, shop ->> 'timeZone') value) standing
    where m.group_id = group_key;
  result := jsonb_set(result, '{friends}', member_rows);
  result := jsonb_set(result, '{campfire}', jsonb_build_object('localDate', shop ->> 'localDate',
    'seats', seat_rows, 'groupGolden', (shop ->> 'balance')::integer));
  result := result || jsonb_build_object('circleShop', shop);
  select coalesce(jsonb_agg(jsonb_set(r, '{friend,character}', public.camp_character(p))), '[]'::jsonb)
    into member_rows from jsonb_array_elements(result -> 'incomingRequests') r
    join public.profiles p on p.id = (r #>> '{friend,id}')::uuid;
  return jsonb_set(result, '{incomingRequests}', member_rows);
end;
$$;

create or replace function public.get_app_snapshot(tz text default 'UTC') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare result jsonb; rows jsonb;
begin
  result := public.get_app_snapshot_v2(tz);
  result := jsonb_set(result, '{circleShop}', public.camp_catalog_v1_shop(result -> 'circleShop'));
  result := jsonb_set(result, '{profile,character}', public.camp_catalog_v1_character(result #> '{profile,character}'));
  select coalesce(jsonb_agg(jsonb_set(item, '{character}', public.camp_catalog_v1_character(item -> 'character'))
    order by position), '[]'::jsonb) into rows
    from jsonb_array_elements(result -> 'friends') with ordinality as entries(item, position);
  result := jsonb_set(result, '{friends}', rows);
  select coalesce(jsonb_agg(jsonb_set(item, '{character}', public.camp_catalog_v1_character(item -> 'character'))
    order by position), '[]'::jsonb) into rows
    from jsonb_array_elements(result #> '{campfire,seats}') with ordinality as entries(item, position);
  result := jsonb_set(result, '{campfire,seats}', rows);
  select coalesce(jsonb_agg(jsonb_set(item, '{friend,character}', public.camp_catalog_v1_character(item #> '{friend,character}'))
    order by position), '[]'::jsonb) into rows
    from jsonb_array_elements(result -> 'incomingRequests') with ordinality as entries(item, position);
  return jsonb_set(result, '{incomingRequests}', rows);
end;
$$;

revoke all on function public.purchase_circle_item(uuid,text,integer), public.get_circle_shop(text),
  public.get_circle_shop_v2(text), public.get_app_snapshot(text), public.get_app_snapshot_v2(text),
  public.set_circle_background(uuid,text), public.set_circle_background_v2(uuid,text),
  public.camp_catalog_v1_shop(jsonb), public.camp_catalog_v1_character(jsonb),
  public.camp_check_character_unlock(), public.camp_reconcile_character(uuid,uuid),
  public.camp_character(public.profiles) from public, anon, authenticated;
grant execute on function public.purchase_circle_item(uuid,text,integer), public.get_circle_shop(text),
  public.get_circle_shop_v2(text), public.get_app_snapshot(text), public.get_app_snapshot_v2(text),
  public.set_circle_background(uuid,text), public.set_circle_background_v2(uuid,text) to authenticated;
notify pgrst, 'reload schema';
