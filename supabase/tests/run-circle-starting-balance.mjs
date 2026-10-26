// Disposable PostgreSQL/WASM only. Never reads environment credentials or a
// live database. Run: node supabase/tests/run-circle-starting-balance.mjs /absolute/temp/node_modules
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.join(directory, '..', 'migrations');
const require = createRequire(path.join(path.resolve(process.argv[2] ?? 'node_modules'), '.starting-balance-qa.cjs'));
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const db = new PGlite({ extensions: { pgcrypto } });
let step = 'bootstrap';

async function allFixtureRows() {
  const tables = (await db.query(`select schemaname, tablename from pg_tables
    where schemaname = 'public' or (schemaname = 'auth' and tablename = 'users')
    order by schemaname, tablename`)).rows;
  const rows = {};
  for (const { schemaname, tablename } of tables) {
    assert.match(schemaname, /^[a-z_]+$/);
    assert.match(tablename, /^[a-z_]+$/);
    rows[`${schemaname}.${tablename}`] = (await db.query(
      `select to_jsonb(t) as row from ${schemaname}.${tablename} t order by to_jsonb(t)::text`)).rows;
  }
  return rows;
}

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
  // Simulate upgrading the existing 0026 backend, also with the independent
  // immutable-code 0027 change present. 0025 has never been deployed.
  for (const name of (await readdir(migrations)).filter(name => /^\d{4}_.*\.sql$/.test(name)
    && (Number(name.slice(0, 4)) <= 24 || /^002[67]_/.test(name))).sort()) {
    step = name;
    if (name.startsWith('0016_')) await db.exec('alter default privileges in schema public grant all on tables to anon, authenticated, service_role');
    await db.exec(await readFile(path.join(migrations, name), 'utf8'));
  }
  const baseline = await allFixtureRows();
  step = 'existing pre-release wallet and history fixtures';
  await db.exec(`begin;
    create or replace function public.camp_now() returns timestamptz
      language sql volatile set search_path = '' as $$ select current_setting('test.balance_clock')::timestamptz $$;
    select set_config('test.balance_clock','2030-04-02T12:00:00Z',true);
    select set_config('test.balance_owner',gen_random_uuid()::text,true);
    select set_config('test.balance_peer',gen_random_uuid()::text,true);
    select set_config('test.balance_zero',gen_random_uuid()::text,true);
    insert into auth.users(id,raw_user_meta_data) values
      (current_setting('test.balance_owner')::uuid,'{"display_name":"Existing wallet QA"}'),
      (current_setting('test.balance_peer')::uuid,'{"display_name":"Existing peer QA"}'),
      (current_setting('test.balance_zero')::uuid,'{"display_name":"Existing empty wallet QA"}');
    select set_config('request.jwt.claim.sub',current_setting('test.balance_owner'),true);
    select set_config('test.balance_group',public.get_circle_shop_v5('UTC')->>'id',true);
    select public.purchase_circle_item_v5(current_setting('test.balance_group')::uuid,'hat:crown',10);
    select public.purchase_circle_item_v5(current_setting('test.balance_group')::uuid,'color:blue',5);
    select public.purchase_circle_item_v5(current_setting('test.balance_group')::uuid,'background:snow',30);
    select public.set_circle_background_v5(current_setting('test.balance_group')::uuid,'snow');
    select public.update_my_character(auth.uid(),'crown','tall',0,'blue');
    update public.camp_group_unlocks set cost=1 where group_id=current_setting('test.balance_group')::uuid
      and item_id in ('hat:crown','color:blue');
    select set_config('request.jwt.claim.sub',current_setting('test.balance_peer'),true);
    select public.join_shared_circle((select friend_code from public.profiles where id=current_setting('test.balance_owner')::uuid));
    select set_config('test.balance_request',public.create_time_request(15::smallint,'Disposable history','Selected apps')::text,true);
    select public.cancel_time_request(current_setting('test.balance_request')::uuid);
    select set_config('request.jwt.claim.sub',current_setting('test.balance_zero'),true);
    select set_config('test.balance_zero_group',public.get_circle_shop_v5('UTC')->>'id',true);
    update public.camp_groups set balance=0 where id=current_setting('test.balance_zero_group')::uuid;
  `);
  const before = await allFixtureRows();
  assert.ok(before['public.camp_group_unlocks'].length >= 3);
  assert.ok(before['public.camp_group_days'].length >= 2);
  assert.equal(before['public.time_requests'].length, 1);

  step = '0025 default-only migration preserves every existing fixture row';
  await db.exec(await readFile(path.join(migrations, '0025_new_circle_starting_balance.sql'), 'utf8'));
  assert.deepEqual(await allFixtureRows(), before);
  console.log('PASS default change preserves every existing public/auth fixture row, including balances, history, purchases, memberships and appearance');

  step = 'new-circle five balance, starter purchase, repeat reads, real earnings, and access controls';
  await db.exec(`
    select set_config('test.balance_new',gen_random_uuid()::text,true);
    insert into auth.users(id,raw_user_meta_data) values
      (current_setting('test.balance_new')::uuid,'{"display_name":"New circle QA"}');
    select set_config('request.jwt.claim.sub',current_setting('test.balance_new'),true);
    set local role authenticated;
    do $test$
    declare first jsonb; again jsonb; current_shop jsonb;
    begin
      first := public.get_circle_shop_v5('UTC');
      again := public.get_circle_shop_v5('UTC');
      perform set_config('test.balance_new_group',first->>'id',true);
      if first->>'balance' <> '5' or first->>'eligibleToday' <> 'false'
        or first->'unlocked' <> '[]'::jsonb or first->>'background' <> 'forest'
        or again->>'id' <> first->>'id' or again->>'balance' <> '5'
        then raise exception 'New circle did not start once at five'; end if;
      begin
        perform public.purchase_circle_item_v5((first->>'id')::uuid,'hat:crown',10);
        raise exception 'Unaffordable purchase was accepted';
      exception when raise_exception then
        if sqlerrm <> 'Your circle needs more s’mores' then raise; end if;
      end;
      begin
        update public.camp_groups set balance=99 where id=(first->>'id')::uuid;
        raise exception 'Client could overwrite wallet';
      exception when insufficient_privilege then null;
      end;
      current_shop := public.purchase_circle_item_v5((first->>'id')::uuid,'hat:cat-ears',5);
      again := public.get_circle_shop_v5('UTC');
      if current_shop->>'balance' <> '0' or again->>'balance' <> '0'
        or not (again->'unlocked' @> '["hat:cat-ears"]'::jsonb)
        then raise exception 'Starter purchase did not spend exactly five or wallet refilled'; end if;
      perform set_config('test.balance_clock','2030-04-03T12:00:00Z',true);
      current_shop := public.get_circle_shop_v5('UTC');
      if current_shop->>'balance' <> '0' then raise exception 'Partial first day earned a reward'; end if;
      perform set_config('test.balance_clock','2030-04-04T12:00:00Z',true);
      current_shop := public.get_circle_shop_v5('UTC');
      if current_shop->>'balance' <> '1' then raise exception 'First complete clean day did not earn one reward'; end if;
      perform set_config('test.balance_clock','2030-04-08T12:00:00Z',true);
      current_shop := public.get_circle_shop_v5('UTC');
      if current_shop->>'balance' <> '5' then raise exception 'Completed request-free days did not accumulate'; end if;
      current_shop := public.purchase_circle_item_v5((first->>'id')::uuid,'color:blue',5);
      again := public.get_circle_shop_v5('UTC');
      if current_shop->>'balance' <> '0' or again->>'balance' <> '0'
        or not (again->'unlocked' @> '["hat:cat-ears","color:blue"]'::jsonb)
        then raise exception 'Purchase/reset contract changed'; end if;
    end $test$;
    reset role;
  `);
  console.log('PASS new circles start at 5, can spend the starter balance once, repeated reads do not refill, clean-day earnings and direct-write denial remain intact');

  step = 'joining and leaving do not transfer or refill starter wallets';
  await db.exec(`
    select set_config('test.balance_joiner',gen_random_uuid()::text,true);
    insert into auth.users(id,raw_user_meta_data) values
      (current_setting('test.balance_joiner')::uuid,'{"display_name":"Joining circle QA"}');
    select set_config('request.jwt.claim.sub',current_setting('test.balance_joiner'),true);
    select set_config('test.balance_joiner_group',public.get_circle_shop_v5('UTC')->>'id',true);
    select set_config('test.balance_join_code',(select friend_code from public.profiles where id=current_setting('test.balance_new')::uuid),true);
    set local role authenticated;
    do $test$
    declare joined jsonb; left_circle jsonb; again jsonb;
    begin
      if public.get_circle_shop_v5('UTC')->>'balance' <> '5'
        then raise exception 'Second new circle did not start at five'; end if;
      joined := public.join_shared_circle_v5(current_setting('test.balance_join_code'));
      if joined->>'balance' <> '0'
        or joined->>'id' <> current_setting('test.balance_new_group')
        then raise exception 'Joining transferred or refilled starter balance'; end if;
      left_circle := public.leave_shared_circle((joined->>'id')::uuid,auth.uid());
      again := public.get_circle_shop_v5('UTC');
      if left_circle->'circleShop'->>'balance' <> '0' or again->>'balance' <> '0'
        or again->'unlocked' <> '[]'::jsonb
        then raise exception 'Leaving awarded another starter balance or copied unlocks'; end if;
      joined := public.join_shared_circle_v5(current_setting('test.balance_join_code'));
      if joined->>'balance' <> '0' then raise exception 'Rejoining refilled wallet'; end if;
    end $test$;
    reset role;
  `);
  console.log('PASS joining/rejoining does not transfer or refill s’mores; leaving still creates an empty personal wallet');

  step = 'fixture rollback';
  await db.exec('rollback');
  // Preserve migration-owned configuration rows; only fixture additions vanish.
  assert.deepEqual(await allFixtureRows(), baseline);
  assert.doesNotMatch((await db.query("select pg_get_functiondef('public.camp_now()'::regprocedure) as definition")).rows[0].definition,
    /test\.balance_clock/);
  console.log('PASS all fixtures and test-clock replacement rolled back; no live database touched');
} catch (error) {
  console.error(`FAIL ${step}: ${error.message}`);
  if (error.detail) console.error(error.detail);
  if (error.where) console.error(error.where);
  process.exitCode = 1;
} finally { await db.close(); }
