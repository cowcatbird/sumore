// Disposable in-memory PostgreSQL only. No environment credentials, network,
// production users, or remote URLs. Separately tested migration 0025 is NOT applied;
// this intentionally checks an independent upgrade from the deployed 99 default.
// node supabase/tests/run-immutable-friend-codes.mjs /absolute/temp/node_modules
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.join(directory, '..', 'migrations');
const require = createRequire(path.join(path.resolve(process.argv[2] ?? 'node_modules'), '.immutable-friend-code-qa.cjs'));
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const db = new PGlite({ extensions: { pgcrypto } });
const sql = async (query, params = []) => (await db.query(query, params)).rows;
const scalar = async (query, params = []) => Object.values((await sql(query, params))[0])[0];
const immutable = /Friend codes are automatically assigned and cannot be changed\./;
let step = 'bootstrap';
async function admin() { await db.exec('reset role'); }
async function asUser(id) {
  await admin();
  await sql("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
  await db.exec(`set role ${id ? 'authenticated' : 'anon'}`);
}
async function user(name, metadata = {}) {
  await admin();
  const id = randomUUID();
  await sql('insert into auth.users(id,raw_user_meta_data) values($1,$2)', [id, { display_name: name, ...metadata }]);
  const code = await scalar('select friend_code from public.profiles where id=$1', [id]);
  await asUser(id);
  const shop = await scalar("select public.get_circle_shop_v5('UTC')");
  return { id, code, group: shop.id };
}
async function fixtureRows() {
  await admin();
  const rows = { auth: await sql('select to_jsonb(t) as row from auth.users t order by id') };
  for (const { tablename } of await sql("select tablename from pg_tables where schemaname='public' order by tablename")) {
    assert.match(tablename, /^[a-z_]+$/);
    rows[tablename] = await sql(`select to_jsonb(t) as row from public.${tablename} t order by to_jsonb(t)::text`);
  }
  return rows;
}
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions;
    create extension pgcrypto with schema extensions;
    create publication supabase_realtime;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
  `);
  for (const name of (await readdir(migrations)).filter(name => /^\d{4}_.*\.sql$/.test(name)
    && (Number(name.slice(0, 4)) <= 24 || name.startsWith('0026_'))).sort()) {
    step = name;
    if (name.startsWith('0016_')) await db.exec('alter default privileges in schema public grant all on tables to anon,authenticated,service_role');
    await db.exec(await readFile(path.join(migrations, name), 'utf8'));
  }

  step = 'preexisting custom code, shared wallet, appearance, request and grant';
  const a = await user('Existing camper A');
  const b = await user('Existing camper B');
  const outside = await user('Existing outsider');
  await asUser(a.id);
  await sql("select public.update_my_friend_code('KEEPTHISCODE')");
  a.code = 'KEEPTHISCODE';
  await sql("select public.purchase_circle_item_v5($1,'hat:crown',10)", [a.group]);
  await sql("select public.update_my_character($1,'crown','tall',0,'cream')", [a.id]);
  await asUser(b.id);
  await sql('select public.join_shared_circle_v5($1)', [a.code]);
  const request = await scalar("select public.create_time_request(15::smallint,'Immutable code QA','Selected apps')");
  await asUser(a.id);
  await sql("select public.decide_time_request($1,'approved')", [request]);
  await asUser(b.id);
  await sql('select public.claim_screen_time_grant($1)', [request]);
  await admin();
  // Deliberately permissive table AND column grants: the migration must close
  // both, not rely on a particular cloud default privilege configuration.
  await db.exec(`grant insert, update, delete on public.profiles to public, anon, authenticated;
    grant insert(friend_code), update(friend_code) on public.profiles to public, anon, authenticated;`);
  const before = await fixtureRows();
  step = 'apply 0027 without 0025';
  await db.exec(await readFile(path.join(migrations, '0027_immutable_friend_codes.sql'), 'utf8'));
  assert.deepEqual(await fixtureRows(), before);
  assert.equal(await scalar("select column_default from information_schema.columns where table_schema='public' and table_name='camp_groups' and column_name='balance'"), '99');
  assert.equal(await scalar("select relrowsecurity from pg_class where oid='public.profiles'::regclass"), true);
  assert.equal(await scalar("select count(*)::int from pg_constraint where conrelid='public.profiles'::regclass and conname in ('profiles_friend_code_unique','profiles_friend_code_format')"), 2);
  console.log('PASS migration preserves every existing auth/public row, custom code, wallet, appearance, membership and grant; excludes 0025');

  step = 'new account generation ignores metadata and stays unique';
  const generated = [];
  for (let i = 0; i < 40; i++) {
    const camper = await user(`Generated camper ${i}`, { friend_code: 'CHOOSETHIS', friendCode: 'CHOOSETHIS' });
    assert.match(camper.code, /^[A-F0-9]{8}$/);
    generated.push(camper.code);
  }
  assert.equal(new Set(generated).size, generated.length);
  await admin();
  await sql('update auth.users set raw_user_meta_data=$1 where id=$2', [{ display_name: 'Metadata edit', friend_code: 'CHOOSETHIS' }, a.id]);
  assert.equal(await scalar('select friend_code from public.profiles where id=$1', [a.id]), a.code);
  // A trusted future profile-insert writer also cannot select the code. Only
  // the auth provisioning trigger is paused for this isolated, rolled-back
  // fixture; the new profile guard remains enabled throughout.
  await db.exec('begin; alter table auth.users disable trigger on_auth_user_created');
  const directId = randomUUID();
  await sql('insert into auth.users(id,raw_user_meta_data) values($1,$2)', [directId, { display_name: 'Direct insertion QA' }]);
  await db.exec('alter table auth.users enable trigger on_auth_user_created');
  const directCode = await scalar("insert into public.profiles(id,display_name,friend_code) values($1,'Direct insertion QA','CHOOSETHIS') returning friend_code", [directId]);
  assert.match(directCode, /^[A-F0-9]{8}$/);
  await db.exec('rollback');
  console.log('PASS server-generated unique codes; supplied signup metadata/direct-insert codes and later auth metadata cannot select or rotate a code');

  step = 'private helper and direct mutation privileges';
  for (const role of ['anon', 'authenticated']) {
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(await scalar('select has_table_privilege($1,\'public.profiles\',$2)', [role, privilege]), false);
    }
    for (const privilege of ['INSERT', 'UPDATE']) {
      assert.equal(await scalar('select has_column_privilege($1,\'public.profiles\',\'friend_code\',$2)', [role, privilege]), false);
    }
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const fn of ['guard_profile_friend_code()', 'generate_friend_code()', 'handle_new_user()']) {
      assert.equal(await scalar('select has_function_privilege($1,$2,\'execute\')', [role, `public.${fn}`]), false);
    }
  }
  await asUser(a.id);
  for (const candidate of ['NEWCODE', b.code, a.code, '', null]) {
    await assert.rejects(() => sql('select public.update_my_friend_code($1)', [candidate]), immutable);
  }
  for (const query of [
    "update public.profiles set friend_code='NEWCODE' where id=$1",
    'delete from public.profiles where id=$1',
    "insert into public.profiles(id,display_name,friend_code) values($1,'Forged','FORGED') on conflict(id) do update set friend_code=excluded.friend_code",
  ]) await assert.rejects(() => sql(query, [a.id]), /permission denied/);
  await asUser(null);
  await assert.rejects(() => sql("select public.update_my_friend_code('NEWCODE')"), /permission denied/);
  console.log('PASS anonymous/owner/direct-write denial, legacy RPC explicit refusal, and private generator/trigger helpers');

  step = 'defense against accidental grants and security-definer writers';
  await admin();
  await db.exec('grant update(friend_code,display_name) on public.profiles to authenticated');
  await asUser(a.id);
  for (const candidate of ['NEWCODE', b.code, null]) {
    await assert.rejects(() => sql("update public.profiles set friend_code=$1,display_name='Must roll back' where id=$2", [candidate, a.id]), immutable);
  }
  assert.equal((await sql("update public.profiles set friend_code='NEWCODE' where id=$1 returning id", [outside.id])).length, 0);
  await admin();
  // Even a trusted SECURITY DEFINER operation cannot mutate an existing code.
  await db.exec(`create function public.test_legacy_code_writer(target_id uuid, value text) returns void
    language sql security definer set search_path='' as $$
      update public.profiles set friend_code=value where id=target_id $$;
    grant execute on function public.test_legacy_code_writer(uuid,text) to authenticated;`);
  await asUser(a.id);
  await assert.rejects(() => sql('select public.test_legacy_code_writer($1,$2)', [a.id, 'NEWCODE']), immutable);
  await admin();
  await db.exec('drop function public.test_legacy_code_writer(uuid,text); revoke update(friend_code,display_name) on public.profiles from authenticated');
  assert.equal(await scalar('select display_name from public.profiles where id=$1', [a.id]), 'Existing camper A');
  await assert.rejects(() => sql("update public.profiles set friend_code='NEWCODE' where id=$1", [a.id]), immutable);
  await assert.rejects(() => sql("insert into public.profiles(id,display_name,friend_code) values($1,'Upsert','NEWCODE') on conflict(id) do update set friend_code=excluded.friend_code", [a.id]), immutable);
  console.log('PASS trigger rejects direct, NULL, duplicate and legacy-definer mutations atomically even after accidental grants; RLS still isolates owners');

  step = 'unchanged profile edit, appearance and joining contracts';
  await asUser(a.id);
  await sql("select public.update_my_profile_name('  Renamed camper  ')");
  await sql("select public.update_my_profile('Legacy renamed camper','ignored_handle')");
  await sql("select public.update_my_character($1,'crown','short',1,'cream')", [a.id]);
  const snapshot = await scalar("select public.get_app_snapshot_v5('UTC')");
  assert.equal(snapshot.profile.friendCode, a.code);
  assert.equal(snapshot.profile.displayName, 'Legacy renamed camper');
  assert.equal(snapshot.profile.character.appearance.hat, 'crown');
  assert.equal(snapshot.profile.character.appearance.body, 'short');
  await asUser(outside.id);
  const joined = await scalar('select public.join_shared_circle_v5($1)', [a.code.toLowerCase()]);
  assert.equal(joined.id, a.group);
  await sql('select public.add_friend_by_code($1)', [a.code]);
  await admin();
  await sql('update public.profiles set friend_code=friend_code where id=$1', [a.id]);
  assert.equal(await scalar('select friend_code from public.profiles where id=$1', [a.id]), a.code);
  console.log('PASS current/legacy name edits, paid appearance, current/legacy code joins, snapshots and unchanged-value updates');

  step = 'name signup collision/retry and account recovery/deletion regression fixtures';
  const beforeFixtures = await fixtureRows();
  await db.exec(await readFile(path.join(directory, 'name_only_profiles.sql'), 'utf8'));
  assert.deepEqual(await fixtureRows(), beforeFixtures);
  console.log('PASS forced code collision retries exactly once; five exhausted retries roll back signup; name validation unchanged');
  await db.exec(`
    begin;
    create temporary table other_conflict_code as select public.generate_friend_code() as code;
    create temporary sequence other_conflict_attempts;
    create unique index test_immutable_code_display_name_unique on public.profiles(display_name);
    create or replace function public.generate_friend_code() returns text
    language plpgsql security definer set search_path='' as $generator$
    begin
      perform nextval('pg_temp.other_conflict_attempts');
      return (select code from pg_temp.other_conflict_code);
    end $generator$;
    do $test$
    declare attempted_id uuid := gen_random_uuid(); conflict_name text;
    begin
      begin
        insert into auth.users(id,raw_user_meta_data)
        values(attempted_id,'{"display_name":"Legacy renamed camper"}');
        raise exception 'Unrelated unique constraint unexpectedly succeeded';
      exception when unique_violation then
        get stacked diagnostics conflict_name = constraint_name;
        if conflict_name <> 'test_immutable_code_display_name_unique' then raise; end if;
      end;
      if (select last_value from pg_temp.other_conflict_attempts) <> 1
        or exists(select 1 from auth.users where id=attempted_id)
        or exists(select 1 from public.profiles where id=attempted_id)
        or exists(select 1 from public.circles where owner_id=attempted_id)
      then raise exception 'Unrelated unique failure was retried or partially committed'; end if;
    end $test$;
    rollback;
  `);
  assert.deepEqual(await fixtureRows(), beforeFixtures);
  console.log('PASS unrelated unique failures are not retried or swallowed; the entire signup remains atomic');
  await db.exec(await readFile(path.join(directory, 'account_access.sql'), 'utf8'));
  assert.deepEqual(await fixtureRows(), beforeFixtures);
  console.log('PASS recovery keys/transfers, access isolation, sharing and account deletion retain their existing contracts; fixtures roll back');
  console.log('All immutable friend-code checks passed (in-memory PostgreSQL; no hosted/device or concurrent-connection test).');
} catch (error) {
  console.error(`FAIL at ${step}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
