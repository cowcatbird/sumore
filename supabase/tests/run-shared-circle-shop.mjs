// Disposable PostgreSQL/WASM only. No environment credentials or live DB use.
// node supabase/tests/run-shared-circle-shop.mjs /absolute/temp/node_modules
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(path.resolve(process.argv[2] ?? 'node_modules'), '.circle-shop-qa.cjs'));
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const db = new PGlite({ extensions: { pgcrypto } });
let step = 'bootstrap';
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions;
    create extension pgcrypto with schema extensions;
    create publication supabase_realtime;
    create table auth.users (id uuid primary key, raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  const migrations = path.join(directory, '..', 'migrations');
  for (const name of (await readdir(migrations)).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 18).sort()) {
    step = name;
    if (name.startsWith('0016_')) await db.exec('alter default privileges in schema public grant all on tables to anon, authenticated, service_role');
    await db.exec(await readFile(path.join(migrations, name), 'utf8'));
    console.log(`PASS migration ${name}`);
  }
  for (const name of ['screen_time_grants.sql', 'shared_circle_shop.sql', 'additional_character_hats.sql']) {
    step = name;
    await db.exec(await readFile(path.join(directory, name), 'utf8'));
    console.log(`PASS ${name}`);
  }
  // Test the historical 0018 contract first, then verify the forward upgrade
  // against actual old purchases before testing the current 0019 catalog.
  const pricingMigration = await readFile(path.join(migrations, '0019_shared_shop_pricing.sql'), 'utf8');
  step = 'legacy purchase pricing upgrade';
  await db.exec('begin');
  await db.exec(await readFile(path.join(directory, 'shop_pricing_upgrade_before.sql'), 'utf8'));
  await db.exec(pricingMigration);
  await db.exec(await readFile(path.join(directory, 'shop_pricing_upgrade_after.sql'), 'utf8'));
  await db.exec('rollback');
  console.log('PASS 0019 upgrade preserves old purchases/balances and reconciles formerly free hats');
  step = '0019_shared_shop_pricing.sql';
  await db.exec(pricingMigration);
  console.log(`PASS migration ${step}`);
  for (const name of ['screen_time_grants.sql', 'shared_shop_pricing.sql', 'shop_client_compatibility.sql']) {
    step = name;
    await db.exec(await readFile(path.join(directory, name), 'utf8'));
    console.log(`PASS ${name}`);
  }
  step = '0020_additional_body_colors.sql';
  await db.exec(await readFile(path.join(migrations, step), 'utf8'));
  console.log(`PASS migration ${step}`);
  for (const name of ['shared_shop_pricing.sql', 'shop_client_compatibility.sql', 'additional_body_colors.sql']) {
    step = name;
    await db.exec(await readFile(path.join(directory, name), 'utf8'));
    console.log(`PASS ${name}`);
  }
  const snowMigration = await readFile(path.join(migrations, '0021_snow_background.sql'), 'utf8');
  step = 'snow catalog upgrade preserves existing state';
  await db.exec(`
    begin;
    select set_config('test.snow_upgrade', gen_random_uuid()::text, true);
    insert into auth.users (id, raw_user_meta_data) values
      (current_setting('test.snow_upgrade')::uuid, '{"display_name":"Snow upgrade QA"}');
    select set_config('request.jwt.claim.sub', current_setting('test.snow_upgrade'), true);
    do $test$
    declare group_key uuid; item record;
    begin
      group_key := (public.get_circle_shop_v3('UTC') ->> 'id')::uuid;
      for item in select * from (values
        ('hat:crown'::text,10), ('hat:wizard',5), ('hat:pirate',5), ('hat:clown',5), ('hat:viking',5),
        ('color:red',5), ('color:orange',5), ('color:yellow',5), ('color:green',5), ('color:blue',5), ('color:pink',5),
        ('background:beach',30)
      ) catalog(id, price) loop
        perform public.purchase_circle_item_v3(group_key, item.id, item.price);
      end loop;
      perform public.set_circle_background_v3(group_key, 'beach');
      perform public.update_my_character(auth.uid(), 'wizard', 'tall', 0, 'red');
      -- Existing legacy ledger prices also survive the new constraint.
      update public.camp_group_unlocks set cost = 1 where group_id = group_key
        and item_id in ('hat:crown','color:orange','color:blue','color:pink');
    end;
    $test$;
  `);
  const upgradeState = `select jsonb_build_object(
    'groups', (select jsonb_agg(to_jsonb(g) order by g.id) from public.camp_groups g),
    'unlocks', (select jsonb_agg(to_jsonb(u) order by u.group_id, u.item_id) from public.camp_group_unlocks u),
    'profiles', (select jsonb_agg(to_jsonb(p) order by p.id) from public.profiles p),
    'members', (select jsonb_agg(to_jsonb(m) order by m.user_id) from public.camp_group_members m)
  ) as state`;
  const beforeSnowUpgrade = (await db.query(upgradeState)).rows;
  await db.exec(snowMigration);
  assert.deepEqual((await db.query(upgradeState)).rows, beforeSnowUpgrade);
  await db.exec('rollback');
  console.log('PASS 0021 upgrade preserves all existing wallets, ledger prices, purchases, profiles and memberships');
  step = '0021_snow_background.sql';
  await db.exec(snowMigration);
  console.log(`PASS migration ${step}`);
  for (const name of ['shared_shop_pricing.sql', 'shop_client_compatibility.sql', 'additional_body_colors.sql', 'snow_background.sql']) {
    step = name;
    await db.exec(await readFile(path.join(directory, name), 'utf8'));
    console.log(`PASS ${name}`);
  }
  for (const name of ['0022_account_access_and_shared_limits.sql', '0023_feedback_reports.sql']) {
    step = name;
    await db.exec(await readFile(path.join(migrations, name), 'utf8'));
    console.log(`PASS migration ${name}`);
  }
  const accessoriesMigration = await readFile(path.join(migrations, '0024_character_accessories.sql'), 'utf8');
  step = 'accessory upgrade preserves existing state';
  await db.exec(`begin;
    select set_config('test.accessories_upgrade', gen_random_uuid()::text, true);
    insert into auth.users(id,raw_user_meta_data) values
      (current_setting('test.accessories_upgrade')::uuid,'{"display_name":"Accessory upgrade QA"}');
    select set_config('request.jwt.claim.sub',current_setting('test.accessories_upgrade'),true);
    do $test$
    declare group_key uuid;
    begin
      group_key := (public.get_circle_shop_v4('UTC')->>'id')::uuid;
      perform public.purchase_circle_item_v4(group_key,'hat:crown',10);
      perform public.purchase_circle_item_v4(group_key,'color:blue',5);
      perform public.purchase_circle_item_v4(group_key,'background:snow',30);
      perform public.set_circle_background_v4(group_key,'snow');
      perform public.update_my_character(auth.uid(),'crown','tall',0,'blue');
      update public.camp_group_unlocks set cost=1 where group_id=group_key and item_id in ('hat:crown','color:blue');
    end $test$;
  `);
  const beforeAccessoriesUpgrade = (await db.query(upgradeState)).rows;
  await db.exec(accessoriesMigration);
  assert.deepEqual((await db.query(upgradeState)).rows, beforeAccessoriesUpgrade);
  await db.exec('rollback');
  console.log('PASS 0024 upgrade preserves existing wallets, historic purchase costs, snow selection, appearance and membership');
  step = '0024_character_accessories.sql';
  await db.exec(accessoriesMigration);
  console.log(`PASS migration ${step}`);
  for (const name of ['shared_shop_pricing.sql', 'shop_client_compatibility.sql', 'additional_body_colors.sql', 'snow_background.sql', 'character_accessories.sql', 'account_access.sql']) {
    step = name;
    await db.exec(await readFile(path.join(directory, name), 'utf8'));
    console.log(`PASS ${name}`);
  }
  assert.deepEqual((await db.query(`select
    (select count(*)::int from auth.users) as users,
    (select count(*)::int from public.camp_groups) as groups,
    (select count(*)::int from public.camp_group_unlocks) as unlocks,
    (select count(*)::int from public.camp_group_days) as days`)).rows[0], { users: 0, groups: 0, unlocks: 0, days: 0 });
  assert.doesNotMatch((await db.query("select pg_get_functiondef('public.camp_now()'::regprocedure) as definition")).rows[0].definition,
    /test\.camp_clock/);
  console.log('PASS fixture rollback, shared wallet, roster isolation, request-day history, current/historical prices, shared hats/colors/backgrounds, client compatibility, timezone and ACL checks');
  console.log('NOT TESTED: simultaneous connections, live Supabase, or native device enforcement');
} catch (error) {
  console.error(`FAIL ${step}: ${error.message}`);
  if (error.detail) console.error(error.detail);
  if (error.where) console.error(error.where);
  process.exitCode = 1;
} finally { await db.close(); }
