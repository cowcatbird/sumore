-- The runner starts a disposable transaction before this fixture, applies
-- migration 0019 next, then runs the after fixture and rolls everything back.
select set_config('test.price_owner', gen_random_uuid()::text, true);
select set_config('test.price_free_hat', gen_random_uuid()::text, true);
insert into auth.users (id, raw_user_meta_data) values
  (current_setting('test.price_owner')::uuid, '{"display_name":"Old purchase QA"}'),
  (current_setting('test.price_free_hat')::uuid, '{"display_name":"Old free hat QA"}');
select set_config('test.price_owner_code', friend_code, true) from public.profiles where id = current_setting('test.price_owner')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('test.price_owner'), true);
select set_config('test.price_group', public.get_circle_shop('UTC') ->> 'id', true);
select public.purchase_circle_item(current_setting('test.price_group')::uuid, 'hat:crown');
select public.purchase_circle_item(current_setting('test.price_group')::uuid, 'color:blue');
select public.purchase_circle_item(current_setting('test.price_group')::uuid, 'color:orange');
select public.purchase_circle_item(current_setting('test.price_group')::uuid, 'color:pink');
select public.update_my_character(auth.uid(), 'crown', 'tall', 0, 'blue');
select set_config('request.jwt.claim.sub', current_setting('test.price_free_hat'), true);
select public.join_shared_circle(current_setting('test.price_owner_code'));
select public.update_my_character(auth.uid(), 'wizard', 'short', 0);
select public.create_time_request(15::smallint, 'Upgrade serialization QA', 'Social apps');
reset role;
