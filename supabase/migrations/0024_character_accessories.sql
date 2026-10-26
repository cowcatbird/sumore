-- Six supplied accessories. No balance grants, historic cost changes, roster
-- changes, or forced appearance resets. Sunflower and lollipop remain free.
alter table public.profiles drop constraint profiles_character_shape,
  add constraint profiles_character_shape check (
    (character_hat is null and character_body is null)
    or (character_hat is not null and character_body is not null
      and character_hat in ('none','cowboy','cow','cat','sunglasses','duck','top-hat','halo','crown',
        'beanie','bucket','headband','propeller','wizard','pirate','clown','viking',
        'cat-ears','sunflower','lollipop','bubble-gum','googly-eyes','disguise-glasses')
      and character_body in ('short','tall'))
  );
alter table public.camp_group_unlocks
  drop constraint camp_group_unlocks_item_id_check,
  drop constraint camp_group_unlocks_cost_check,
  add constraint camp_group_unlocks_item_id_check check (item_id in (
    'hat:crown','hat:wizard','hat:pirate','hat:clown','hat:viking',
    'hat:cat-ears','hat:bubble-gum','hat:googly-eyes','hat:disguise-glasses',
    'color:red','color:orange','color:yellow','color:green','color:blue','color:pink',
    'background:beach','background:snow'
  )),
  add constraint camp_group_unlocks_cost_check check (
    (item_id = 'hat:crown' and cost in (1,10))
    or (item_id in ('hat:wizard','hat:pirate','hat:clown','hat:viking',
      'hat:cat-ears','hat:bubble-gum','hat:googly-eyes','hat:disguise-glasses',
      'color:red','color:yellow','color:green') and cost = 5)
    or (item_id in ('color:blue','color:orange','color:pink') and cost in (1,5))
    or (item_id in ('background:beach','background:snow') and cost = 30)
  );

-- One private paid-hat predicate shared by purchases, equip enforcement and
-- group moves. Free/unknown hats never become purchasable through this helper.
create function public.camp_hat_price(hat text) returns integer
language sql immutable set search_path = ''
as $$ select case when hat = 'crown' then 10
  when hat in ('wizard','pirate','clown','viking','cat-ears','bubble-gum','googly-eyes','disguise-glasses') then 5
  else null end $$;

create or replace function public.camp_check_character_unlock() returns trigger
language plpgsql security definer set search_path = ''
as $$ declare group_key uuid;
begin
  select group_id into group_key from public.camp_group_members where user_id = new.id;
  if public.camp_hat_price(new.character_hat) is not null and not exists (
    select 1 from public.camp_group_unlocks where group_id = group_key and item_id = 'hat:' || new.character_hat
  ) then
    if new.character_hat = 'crown' then raise exception 'Unlock the crown in your circle’s shop first'; end if;
    raise exception 'Unlock this hat in your circle’s shop first';
  end if;
  if new.character_color <> 'cream' and not exists (select 1 from public.camp_group_unlocks
    where group_id = group_key and item_id = 'color:' || new.character_color)
    then raise exception 'Unlock this color in your circle’s shop first'; end if;
  return new;
end $$;

create or replace function public.camp_reconcile_character(member_id uuid, target_group_id uuid) returns void
language plpgsql security definer set search_path = ''
as $$ begin
  update public.profiles p set
    character_hat = case when public.camp_hat_price(p.character_hat) is not null and not exists (
      select 1 from public.camp_group_unlocks where group_id = target_group_id and item_id = 'hat:' || p.character_hat
    ) then 'none' else p.character_hat end,
    character_color = case when p.character_color <> 'cream' and not exists (
      select 1 from public.camp_group_unlocks where group_id = target_group_id and item_id = 'color:' || p.character_color
    ) then 'cream' else p.character_color end,
    character_revision = character_revision + 1
  where p.id = member_id and (
    (public.camp_hat_price(p.character_hat) is not null and not exists (
      select 1 from public.camp_group_unlocks where group_id = target_group_id and item_id = 'hat:' || p.character_hat))
    or (p.character_color <> 'cream' and not exists (select 1 from public.camp_group_unlocks
      where group_id = target_group_id and item_id = 'color:' || p.character_color))
  );
end $$;

create or replace function public.camp_character(member public.profiles) returns jsonb
language sql stable security definer set search_path = ''
as $$ select jsonb_build_object('appearance', case when member.character_hat is null then null else
  jsonb_build_object(
    'hat', case when public.camp_hat_price(member.character_hat) is not null and not exists (
      select 1 from public.camp_group_members m join public.camp_group_unlocks u on u.group_id = m.group_id
      where m.user_id = member.id and u.item_id = 'hat:' || member.character_hat
    ) then 'none' else member.character_hat end,
    'body', member.character_body,
    'color', case when member.character_color <> 'cream' and not exists (
      select 1 from public.camp_group_members m join public.camp_group_unlocks u on u.group_id = m.group_id
      where m.user_id = member.id and u.item_id = 'color:' || member.character_color
    ) then 'cream' else member.character_color end
  ) end, 'revision', member.character_revision) $$;

create or replace function public.update_my_character(target_profile_id uuid, new_hat text, new_body text,
  expected_revision integer, new_color text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare saved public.profiles; group_key uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if target_profile_id is distinct from auth.uid() then raise exception 'This camper belongs to a different account'; end if;
  if new_hat is null or new_hat not in (
      'none','cowboy','cow','cat','sunglasses','duck','top-hat','halo','crown',
      'beanie','bucket','headband','propeller','wizard','pirate','clown','viking',
      'cat-ears','sunflower','lollipop','bubble-gum','googly-eyes','disguise-glasses'
    ) or new_body is null or new_body not in ('short','tall') or expected_revision is null or expected_revision < 0
    or (new_color is not null and new_color not in ('cream','red','orange','yellow','green','blue','pink'))
    then raise exception 'Choose a supported hat, body and color'; end if;
  group_key := public.camp_ensure_group(auth.uid());
  perform 1 from public.camp_groups where id = group_key for update;
  update public.profiles set character_hat = new_hat, character_body = new_body,
    character_color = coalesce(new_color, character_color), character_revision = character_revision + 1
    where id = auth.uid() and character_revision = expected_revision returning * into saved;
  if saved.id is null then raise exception 'Your camper changed on another device. Refresh and retry your choice.' using errcode = '40001'; end if;
  return jsonb_build_object('appearance', jsonb_build_object('hat', saved.character_hat, 'body', saved.character_body,
    'color', saved.character_color), 'revision', saved.character_revision);
end $$;

-- Installed v4 clients know snow/colors, but not these six accessory images.
-- Hide unsupported serialized data only; preserve the real wallet and revision.
create function public.camp_catalog_v4_shop(payload jsonb) returns jsonb
language sql immutable set search_path = ''
as $$ select jsonb_set(payload, '{unlocked}', coalesce((
  select jsonb_agg(item order by position)
  from jsonb_array_elements(payload -> 'unlocked') with ordinality as entries(item, position)
  where item #>> '{}' in ('hat:crown','hat:wizard','hat:pirate','hat:clown','hat:viking',
    'color:red','color:orange','color:yellow','color:green','color:blue','color:pink','background:beach','background:snow')
), '[]'::jsonb)) $$;
create function public.camp_catalog_v4_character(payload jsonb) returns jsonb
language sql immutable set search_path = ''
as $$ select case when payload #>> '{appearance,hat}' is not null
  and payload #>> '{appearance,hat}' not in ('none','cowboy','cow','cat','sunglasses','duck','top-hat','halo','crown',
    'beanie','bucket','headband','propeller','wizard','pirate','clown','viking')
  then jsonb_set(payload, '{appearance,hat}', '"none"'::jsonb) else payload end $$;

alter function public.get_circle_shop_v4(text) rename to get_circle_shop_v5;
create function public.get_circle_shop_v4(tz text default 'UTC') returns jsonb
language sql security definer set search_path = ''
as $$ select public.camp_catalog_v4_shop(public.get_circle_shop_v5(tz)) $$;

create function public.purchase_circle_item_v5(target_group_id uuid, item_id text, expected_cost integer default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare group_key uuid; price integer; already_owned boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  group_key := public.camp_ensure_group(auth.uid());
  if group_key is distinct from target_group_id then raise exception 'Your circle changed. Refresh and try again'; end if;
  price := case
    when item_id like 'hat:%' then public.camp_hat_price(substr(item_id, 5))
    when item_id in ('color:red','color:orange','color:yellow','color:green','color:blue','color:pink') then 5
    when item_id in ('background:beach','background:snow') then 30 else null end;
  if price is null then raise exception 'Choose an available shop item'; end if;
  perform 1 from public.camp_groups where id = group_key for update;
  select exists(select 1 from public.camp_group_unlocks u
    where u.group_id = group_key and u.item_id = purchase_circle_item_v5.item_id) into already_owned;
  if not already_owned then
    if expected_cost is null and item_id <> 'background:beach' then raise exception 'Update sumore to see the latest shop prices'; end if;
    if expected_cost is not null and expected_cost <> price then raise exception 'The price changed. Refresh the shop and try again'; end if;
  end if;
  perform public.camp_settle(group_key);
  if not already_owned then
    update public.camp_groups set balance = balance - price, updated_at = clock_timestamp()
      where id = group_key and balance >= price;
    if not found then raise exception 'Your circle needs more s’mores'; end if;
    insert into public.camp_group_unlocks(group_id,item_id,cost) values(group_key,purchase_circle_item_v5.item_id,price);
  end if;
  return public.camp_shop_payload(group_key);
end $$;
create or replace function public.purchase_circle_item_v4(target_group_id uuid, item_id text, expected_cost integer default null) returns jsonb
language sql security definer set search_path = ''
as $$ select public.camp_catalog_v4_shop(public.purchase_circle_item_v5(target_group_id,item_id,expected_cost)) $$;

alter function public.set_circle_background_v4(uuid,text) rename to set_circle_background_v5;
create function public.set_circle_background_v4(target_group_id uuid, new_background text) returns jsonb
language sql security definer set search_path = ''
as $$ select public.camp_catalog_v4_shop(public.set_circle_background_v5(target_group_id,new_background)) $$;
alter function public.join_shared_circle_v4(text) rename to join_shared_circle_v5;
create function public.join_shared_circle_v4(friend_code_input text) returns jsonb
language sql security definer set search_path = ''
as $$ select public.camp_catalog_v4_shop(public.join_shared_circle_v5(friend_code_input)) $$;

create function public.get_app_snapshot_v5(tz text default 'UTC') returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare result jsonb; shop jsonb; group_key uuid; member_rows jsonb; seat_rows jsonb; profile_row public.profiles;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  shop := public.get_circle_shop_v5(tz);
  group_key := (shop ->> 'id')::uuid;
  result := public.camp_legacy_snapshot(shop ->> 'timeZone');
  select * into profile_row from public.profiles where id = auth.uid();
  result := jsonb_set(result, '{profile,character}', public.camp_character(profile_row));
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'displayName',p.display_name,'friendCode',p.friend_code,'initials',public.profile_initials(p.display_name),
    'color','#FFD2BF','online',false,'character',public.camp_character(p)
  ) order by p.display_name,p.id),'[]'::jsonb) into member_rows
    from public.camp_group_members m join public.profiles p on p.id = m.user_id
    where m.group_id = group_key and p.id <> auth.uid();
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'displayName',p.display_name,'initials',public.profile_initials(p.display_name),'isYou',p.id = auth.uid(),
    'askedToday',(standing.value ->> 'askedToday')::boolean,'streak',(standing.value ->> 'streak')::integer,
    'golden',0,'character',public.camp_character(p)
  ) order by p.id <> auth.uid(),p.display_name,p.id),'[]'::jsonb) into seat_rows
    from public.camp_group_members m join public.profiles p on p.id = m.user_id
    cross join lateral (select public.campfire_standing(p.id,shop ->> 'timeZone') value) standing
    where m.group_id = group_key;
  result := jsonb_set(result,'{friends}',member_rows);
  result := jsonb_set(result,'{campfire}',jsonb_build_object('localDate',shop ->> 'localDate',
    'seats',seat_rows,'groupGolden',(shop ->> 'balance')::integer));
  result := result || jsonb_build_object('circleShop',shop);
  select coalesce(jsonb_agg(jsonb_set(r,'{friend,character}',public.camp_character(p))),'[]'::jsonb)
    into member_rows from jsonb_array_elements(result -> 'incomingRequests') r
    join public.profiles p on p.id = (r #>> '{friend,id}')::uuid;
  return jsonb_set(result,'{incomingRequests}',member_rows);
end $$;

create or replace function public.get_app_snapshot_v4(tz text default 'UTC') returns jsonb
language plpgsql security definer set search_path = ''
as $$ declare result jsonb; rows jsonb;
begin
  result := public.get_app_snapshot_v5(tz);
  result := jsonb_set(result,'{circleShop}',public.camp_catalog_v4_shop(result -> 'circleShop'));
  result := jsonb_set(result,'{profile,character}',public.camp_catalog_v4_character(result #> '{profile,character}'));
  select coalesce(jsonb_agg(jsonb_set(item,'{character}',public.camp_catalog_v4_character(item -> 'character'))
    order by position),'[]'::jsonb) into rows
    from jsonb_array_elements(result -> 'friends') with ordinality as entries(item,position);
  result := jsonb_set(result,'{friends}',rows);
  select coalesce(jsonb_agg(jsonb_set(item,'{character}',public.camp_catalog_v4_character(item -> 'character'))
    order by position),'[]'::jsonb) into rows
    from jsonb_array_elements(result #> '{campfire,seats}') with ordinality as entries(item,position);
  result := jsonb_set(result,'{campfire,seats}',rows);
  select coalesce(jsonb_agg(jsonb_set(item,'{friend,character}',public.camp_catalog_v4_character(item #> '{friend,character}'))
    order by position),'[]'::jsonb) into rows
    from jsonb_array_elements(result -> 'incomingRequests') with ordinality as entries(item,position);
  return jsonb_set(result,'{incomingRequests}',rows);
end $$;

revoke all on function public.camp_hat_price(text), public.camp_catalog_v4_shop(jsonb), public.camp_catalog_v4_character(jsonb),
  public.camp_check_character_unlock(), public.camp_reconcile_character(uuid,uuid), public.camp_character(public.profiles),
  public.update_my_character(uuid,text,text,integer,text),
  public.get_circle_shop_v4(text), public.get_circle_shop_v5(text), public.get_app_snapshot_v4(text), public.get_app_snapshot_v5(text),
  public.purchase_circle_item_v4(uuid,text,integer), public.purchase_circle_item_v5(uuid,text,integer),
  public.set_circle_background_v4(uuid,text), public.set_circle_background_v5(uuid,text),
  public.join_shared_circle_v4(text), public.join_shared_circle_v5(text) from public, anon, authenticated;
grant execute on function public.update_my_character(uuid,text,text,integer,text),
  public.get_circle_shop_v4(text), public.get_circle_shop_v5(text), public.get_app_snapshot_v4(text), public.get_app_snapshot_v5(text),
  public.purchase_circle_item_v4(uuid,text,integer), public.purchase_circle_item_v5(uuid,text,integer),
  public.set_circle_background_v4(uuid,text), public.set_circle_background_v5(uuid,text),
  public.join_shared_circle_v4(text), public.join_shared_circle_v5(text) to authenticated;
notify pgrst, 'reload schema';
