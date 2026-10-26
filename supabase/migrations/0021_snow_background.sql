-- A separately purchased snow campsite. Preserve all existing balances,
-- historical purchase costs, unlocks and the selected background.
alter table public.camp_groups
  drop constraint camp_groups_background_check,
  add constraint camp_groups_background_check check (background in ('forest','beach','snow'));
alter table public.camp_group_unlocks
  drop constraint camp_group_unlocks_item_id_check,
  drop constraint camp_group_unlocks_cost_check,
  add constraint camp_group_unlocks_item_id_check check (item_id in (
    'hat:crown','hat:wizard','hat:pirate','hat:clown','hat:viking',
    'color:red','color:orange','color:yellow','color:green','color:blue','color:pink',
    'background:beach','background:snow'
  )),
  add constraint camp_group_unlocks_cost_check check (
    (item_id = 'hat:crown' and cost in (1,10))
    or (item_id in ('hat:wizard','hat:pirate','hat:clown','hat:viking','color:red','color:yellow','color:green') and cost = 5)
    or (item_id in ('color:blue','color:orange','color:pink') and cost in (1,5))
    or (item_id in ('background:beach','background:snow') and cost = 30)
  );

-- A v3 client knows every color but not snow. Only its serialized wallet is
-- changed: the real group still owns snow and retains it as the selected art.
create function public.camp_catalog_v3_shop(payload jsonb) returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_set(jsonb_set(payload, '{unlocked}', coalesce((
    select jsonb_agg(item order by position)
    from jsonb_array_elements(payload -> 'unlocked') with ordinality entries(item, position)
    where item #>> '{}' <> 'background:snow'
  ), '[]'::jsonb)), '{background}',
    case when payload ->> 'background' = 'snow' then '"forest"'::jsonb else payload -> 'background' end)
$$;

alter function public.get_circle_shop_v3(text) rename to get_circle_shop_v4;
create function public.get_circle_shop_v3(tz text default 'UTC') returns jsonb
language sql security definer set search_path = ''
as $$ select public.camp_catalog_v3_shop(public.get_circle_shop_v4(tz)) $$;

create function public.purchase_circle_item_v4(
  target_group_id uuid, item_id text, expected_cost integer default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid; price integer; already_owned boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  group_key := public.camp_ensure_group(auth.uid());
  if group_key is distinct from target_group_id then raise exception 'Your circle changed. Refresh and try again'; end if;
  price := case
    when item_id = 'hat:crown' then 10
    when item_id in ('hat:wizard','hat:pirate','hat:clown','hat:viking',
      'color:red','color:orange','color:yellow','color:green','color:blue','color:pink') then 5
    when item_id in ('background:beach','background:snow') then 30
    else null end;
  if price is null then raise exception 'Choose an available shop item'; end if;
  perform 1 from public.camp_groups where id = group_key for update;
  select exists (select 1 from public.camp_group_unlocks u
    where u.group_id = group_key and u.item_id = purchase_circle_item_v4.item_id) into already_owned;
  if not already_owned then
    -- Only beach has always had the same price in clients without confirmation.
    if expected_cost is null and item_id <> 'background:beach' then
      raise exception 'Update sumore to see the latest shop prices';
    end if;
    if expected_cost is not null and expected_cost <> price then
      raise exception 'The price changed. Refresh the shop and try again';
    end if;
  end if;
  perform public.camp_settle(group_key);
  if not already_owned then
    update public.camp_groups set balance = balance - price, updated_at = clock_timestamp()
      where id = group_key and balance >= price;
    if not found then raise exception 'Your circle needs more s’mores'; end if;
    insert into public.camp_group_unlocks (group_id, item_id, cost)
      values (group_key, purchase_circle_item_v4.item_id, price);
  end if;
  return public.camp_shop_payload(group_key);
end;
$$;

create or replace function public.purchase_circle_item_v3(
  target_group_id uuid, item_id text, expected_cost integer default null
) returns jsonb
language sql security definer set search_path = ''
as $$ select public.camp_catalog_v3_shop(public.purchase_circle_item_v4(target_group_id, item_id, expected_cost)) $$;

create function public.set_circle_background_v4(target_group_id uuid, new_background text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare group_key uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  group_key := public.camp_ensure_group(auth.uid());
  if group_key is distinct from target_group_id then raise exception 'Your circle changed. Refresh and try again'; end if;
  if new_background is null or new_background not in ('forest','beach','snow') then raise exception 'Choose an available campsite'; end if;
  perform public.camp_settle(group_key);
  if new_background <> 'forest' and not exists (select 1 from public.camp_group_unlocks
    where group_id = group_key and item_id = 'background:' || new_background) then
    if new_background = 'beach' then raise exception 'Unlock the beach in your circle’s shop first'; end if;
    raise exception 'Unlock the snow campsite in your circle’s shop first';
  end if;
  update public.camp_groups set background = new_background, updated_at = clock_timestamp() where id = group_key;
  return public.camp_shop_payload(group_key);
end;
$$;

create or replace function public.set_circle_background_v3(target_group_id uuid, new_background text) returns jsonb
language sql security definer set search_path = ''
as $$ select public.camp_catalog_v3_shop(public.set_circle_background_v4(target_group_id, new_background)) $$;

-- The full snapshot retains existing request/roster visibility and character
-- revision handling. Only the wallet reader advances to the snow catalog.
create function public.get_app_snapshot_v4(tz text default 'UTC') returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare result jsonb; shop jsonb; group_key uuid; member_rows jsonb; seat_rows jsonb; profile_row public.profiles;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  shop := public.get_circle_shop_v4(tz);
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

create or replace function public.get_app_snapshot_v3(tz text default 'UTC') returns jsonb
language sql security definer set search_path = ''
as $$
  select jsonb_set(snapshot, '{circleShop}', public.camp_catalog_v3_shop(snapshot -> 'circleShop'))
  from (select public.get_app_snapshot_v4(tz) as snapshot) full_snapshot
$$;

-- Join responses are also wallets. New clients get full art selection; the
-- unversioned entry point remains safe even for the oldest installed catalog.
alter function public.join_shared_circle(text) rename to join_shared_circle_v4;
create function public.join_shared_circle(friend_code_input text) returns jsonb
language sql security definer set search_path = ''
as $$ select public.camp_catalog_v1_shop(public.camp_catalog_v3_shop(public.join_shared_circle_v4(friend_code_input))) $$;

revoke all on function public.camp_catalog_v3_shop(jsonb),
  public.get_circle_shop_v3(text), public.get_circle_shop_v4(text),
  public.get_app_snapshot_v3(text), public.get_app_snapshot_v4(text),
  public.purchase_circle_item_v3(uuid,text,integer), public.purchase_circle_item_v4(uuid,text,integer),
  public.set_circle_background_v3(uuid,text), public.set_circle_background_v4(uuid,text),
  public.join_shared_circle(text), public.join_shared_circle_v4(text) from public, anon, authenticated;
grant execute on function public.get_circle_shop_v3(text), public.get_circle_shop_v4(text),
  public.get_app_snapshot_v3(text), public.get_app_snapshot_v4(text),
  public.purchase_circle_item_v3(uuid,text,integer), public.purchase_circle_item_v4(uuid,text,integer),
  public.set_circle_background_v3(uuid,text), public.set_circle_background_v4(uuid,text),
  public.join_shared_circle(text), public.join_shared_circle_v4(text) to authenticated;
notify pgrst, 'reload schema';
