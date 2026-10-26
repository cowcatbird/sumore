// Disposable PostgreSQL/WASM only: no credentials, remote URLs, or live users.
// node supabase/tests/run-circle-membership-controls.mjs /absolute/temp/node_modules
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.join(directory, '..', 'migrations');
const require = createRequire(path.join(path.resolve(process.argv[2] ?? 'node_modules'), '.circle-safety-qa.cjs'));
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const db = new PGlite({ extensions: { pgcrypto } });
let step = 'bootstrap';
const sql = async (query, params = []) => (await db.query(query, params)).rows;
const scalar = async (query, params = []) => Object.values((await sql(query, params))[0])[0];
async function asUser(id) {
  await db.exec('reset role');
  await sql("select set_config('request.jwt.claim.sub',$1,false)", [id ?? '']);
  await db.exec(`set role ${id ? 'authenticated' : 'anon'}`);
}
async function admin() { await db.exec('reset role'); }
async function user(name) {
  await admin();
  const id = randomUUID();
  await sql('insert into auth.users(id,raw_user_meta_data) values($1,$2)', [id, { display_name: name }]);
  const code = await scalar('select friend_code from public.profiles where id=$1', [id]);
  await asUser(id);
  const shop = await scalar("select public.get_circle_shop_v5('UTC')");
  return { id, code, group: shop.id };
}
const join = async (actor, peer, version = '_v5') => {
  assert.ok(['', '_v4', '_v5'].includes(version));
  await asUser(actor.id);
  return scalar(`select public.join_shared_circle${version}($1)`, [peer.code]);
};
const request = async actor => {
  await asUser(actor.id);
  return scalar("select public.create_time_request(15::smallint,'Safety QA','Selected apps')");
};
async function rejected(query, params, pattern) { await assert.rejects(() => sql(query, params), pattern); }
async function context(id, status) {
  await admin(); await db.exec('set role service_role');
  return scalar('select public.circle_notification_context($1,$2)', [id, status]);
}
async function fixtureRows() {
  await admin();
  const tables = await sql("select tablename from pg_tables where schemaname='public' order by tablename");
  const rows = {};
  for (const { tablename } of tables) {
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
  for (const name of (await readdir(migrations)).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 24).sort()) {
    step = name;
    if (name.startsWith('0016_')) await db.exec('alter default privileges in schema public grant all on tables to anon,authenticated,service_role');
    await db.exec(await readFile(path.join(migrations, name), 'utf8'));
  }
  step = 'seed genuine pre-migration wallets/appearance and prove upgrade does not rewrite data';
  const a = await user('Safety QA A'); const b = await user('Safety QA B'); const c = await user('Safety QA C');
  const d = await user('Safety QA stranger'); const e = await user('Safety QA legacy');
  await join(b, a); await join(c, a);
  await asUser(a.id);
  await sql("select public.purchase_circle_item_v5($1,'hat:crown',10)", [a.group]);
  await sql("select public.update_my_character($1,'crown','tall',0,'cream')", [a.id]);
  await sql('select public.add_friend_by_code($1)', [b.code]);
  await sql('select public.add_friend_by_code($1)', [c.code]);
  const before = await fixtureRows();
  await db.exec(await readFile(path.join(migrations, '0026_circle_membership_controls.sql'), 'utf8'));
  const after = await fixtureRows();
  assert.deepEqual(after.circle_blocks, []); delete after.circle_blocks;
  assert.deepEqual(after, before);
  assert.equal(await scalar("select column_default from information_schema.columns where table_schema='public' and table_name='camp_groups' and column_name='balance'"), '99');
  console.log('PASS migration leaves all existing rows untouched and works WITHOUT provisional 0025');

  step = 'ACL / expected-account / expected-group guards';
  await asUser(a.id);
  for (const [query, args] of [
    ['select public.get_blocked_people($1)', [b.id]],
    ['select public.get_blocked_people($1)', [null]],
    ['select public.leave_shared_circle($1,$2)', [a.group, b.id]],
    ['select public.block_circle_person($1,$2,$3)', [b.id, a.group, b.id]],
    ['select public.unblock_circle_person($1,$2)', [b.id, b.id]],
  ]) await rejected(query, args, /account changed/);
  await rejected('select public.leave_shared_circle($1,$2)', [b.group, a.id], /circle changed/);
  await rejected('select public.block_circle_person($1,$2,$3)', [d.id, a.group, a.id], /Camper unavailable/);
  await rejected('select public.block_circle_person($1,$2,$3)', [a.id, a.group, a.id], /another camper/);
  for (const query of [
    'select public.circle_safety_lock()',
    `select public.circle_pair_blocked('${a.id}','${b.id}')`,
    `select public.circle_create_request_legacy(15::smallint,null,'Selected apps')`,
    `select public.circle_add_friend_legacy('${b.code}')`,
    `select public.circle_notification_context('${randomUUID()}','pending')`,
    `insert into public.circle_blocks(owner_id,target_id) values('${a.id}','${b.id}')`,
    `update public.camp_group_members set group_id='${d.group}' where user_id='${a.id}'`,
    `delete from public.circle_members where user_id='${b.id}'`,
  ]) await rejected(query, [], /permission denied/);
  await asUser(null);
  await rejected('select public.get_blocked_people($1)', [a.id], /permission denied/);
  console.log('PASS owner/group validation, anonymous denial, private helpers and direct-write ACLs');

  step = 'real requests, authoritative notification context and approved grant preservation';
  await admin();
  for (const camper of [a,b,c,d]) await sql("insert into public.device_push_tokens(user_id,token,platform) values($1,$2,'ios')", [camper.id, `ExponentPushToken[${camper.id}]`]);
  const approved = await request(c);
  await asUser(a.id); await sql("select public.decide_time_request($1,'approved')", [approved]);
  await asUser(c.id); const grant = await scalar('select public.claim_screen_time_grant($1)', [approved]);
  assert.equal((await context(approved, 'approved')).tokens.length, 1);
  assert.equal(await context(approved, 'pending'), null);
  const outgoing = await request(a); const incoming = await request(b);
  assert.equal((await context(outgoing, 'pending')).tokens.length, 2);
  await admin();
  const savedProfile = await scalar('select to_jsonb(p) from public.profiles p where id=$1', [a.id]);
  const savedGrant = await scalar('select to_jsonb(g) from public.screen_time_grants g where request_id=$1', [approved]);
  const savedUnlocks = await sql('select * from public.camp_group_unlocks where group_id=$1 order by item_id', [a.group]);
  const wallet = await scalar('select balance from public.camp_groups where id=$1', [a.group]);
  // An already-expired claimed grant must never produce a fresh push even if
  // a trusted writer supplied a recent decision timestamp. Restore unchanged.
  await sql(`with sampled as materialized(select clock_timestamp() as at)
    update public.screen_time_grants set started_at=sampled.at-interval '16 minutes',expires_at=sampled.at-interval '1 minute'
    from sampled where request_id=$1`, [approved]);
  assert.equal(await context(approved,'approved'),null);
  await admin();
  await sql('update public.screen_time_grants set started_at=$1,expires_at=$2 where request_id=$3', [savedGrant.started_at,savedGrant.expires_at,approved]);
  // Inject a non-current legacy recipient in this disposable database only:
  // current membership must win over a historical recipient row.
  await sql('insert into public.request_recipients(request_id,recipient_id) values($1,$2)',[outgoing,d.id]);
  assert.equal((await context(outgoing,'pending')).tokens.length,2);
  await asUser(a.id);
  const left = await scalar('select public.leave_shared_circle($1,$2)', [a.group, a.id]);
  assert.equal(left.leftCircle, true); assert.notEqual(left.circleShop.id, a.group);
  assert.equal(left.circleShop.balance, 0); assert.deepEqual(left.circleShop.unlocked, []);
  assert.equal(left.circleShop.eligibleToday, false);
  await admin();
  assert.deepEqual(await scalar('select to_jsonb(p) from public.profiles p where id=$1', [a.id]), savedProfile);
  await asUser(a.id);
  // The leave RPC preserves the whole profile. The EXISTING shop-read path
  // then reconciles unsupported paid appearance to the new circle's entitlements.
  const personalSnapshot = await scalar("select public.get_app_snapshot_v5('UTC')");
  assert.equal(personalSnapshot.profile.character.appearance.hat,'none');
  assert.equal(personalSnapshot.profile.character.appearance.body,'tall');
  assert.equal(personalSnapshot.profile.character.revision,savedProfile.character_revision+1);
  assert.equal(personalSnapshot.profile.id,a.id);
  assert.equal(personalSnapshot.profile.displayName,savedProfile.display_name);
  assert.equal(personalSnapshot.profile.friendCode,savedProfile.friend_code);
  const solo = left.circleShop.id;
  const repeated = await scalar('select public.leave_shared_circle($1,$2)', [solo, a.id]);
  assert.equal(repeated.leftCircle, false); assert.equal(repeated.circleShop.id, solo); assert.equal(repeated.circleShop.balance, 0);
  await rejected('select public.leave_shared_circle($1,$2)', [a.group, a.id], /circle changed/);
  await rejected("select public.decide_time_request($1,'approved')", [incoming], /no longer available/);
  await admin();
  assert.equal(await scalar('select status from public.time_requests where id=$1', [outgoing]), 'cancelled');
  assert.deepEqual(await sql('select recipient_id from public.request_recipients where request_id=$1', [incoming]), [{recipient_id: c.id}]);
  assert.equal(await scalar('select status from public.time_requests where id=$1', [incoming]), 'pending');
  assert.equal(await scalar('select balance from public.camp_groups where id=$1', [a.group]), wallet);
  assert.deepEqual(await sql('select * from public.camp_group_unlocks where group_id=$1 order by item_id', [a.group]), savedUnlocks);
  assert.deepEqual(await scalar('select to_jsonb(g) from public.screen_time_grants g where request_id=$1', [approved]), savedGrant);
  assert.equal(await scalar('select count(*)::int from public.circle_members m join public.circles c on c.id=m.circle_id where m.user_id=$1 or c.owner_id=$1', [a.id]), 0);
  assert.equal(await context(outgoing, 'pending'), null);
  assert.equal(await context(approved, 'approved'), null);
  assert.deepEqual((await context(incoming, 'pending')).tokens, [`ExponentPushToken[${c.id}]`]);
  await asUser(c.id); assert.equal((await scalar('select public.get_active_screen_time_grant()')).grantId, grant.grantId);
  console.log('PASS leave cancels crossed pending requests only, preserves peers/wallet/history/profile/approved grant, suppresses stale push, solo leave cannot refill');

  step = 'block, reverse/third-party code bypasses, legacy APIs and private lists';
  await join(a, b); // Explicit rejoin is allowed before blocking.
  assert.equal((await scalar("select public.get_app_snapshot_v5('UTC')")).profile.character.appearance.hat,'none');
  await asUser(e.id); await sql('select public.add_friend_by_code($1)', [b.code]);
  await admin();
  const invitation = await scalar(`insert into public.circle_members(circle_id,user_id,invited_by,status)
    select id,$1,owner_id,'invited' from public.circles where owner_id=$2 returning id`, [a.id,e.id]);
  await asUser(a.id);
  const blocked = await scalar('select public.block_circle_person($1,$2,$3)', [b.id, a.group, a.id]);
  assert.equal(blocked.blockedUserId, b.id); assert.equal(blocked.leftCircle, true);
  assert.equal(blocked.circleShop.balance, 0); assert.deepEqual(blocked.circleShop.unlocked, []);
  const blockedSolo = blocked.circleShop.id;
  assert.deepEqual((await scalar('select public.get_blocked_people($1)', [a.id])).map(x => x.id), [b.id]);
  assert.equal((await sql('select * from public.circle_blocks')).length, 1);
  assert.equal((await sql('select id from public.profiles where id=$1', [b.id])).length, 0);
  await rejected('select public.respond_to_circle_invite($1,true)', [invitation], /Invitation is not available/);
  const legacySnapshot = await scalar('select public.get_app_snapshot()');
  assert.ok(!legacySnapshot.friends.some(friend => friend.id === b.id));
  for (const version of ['', '_v4', '_v5']) {
    await assert.rejects(() => join(a, b, version), /circle is unavailable/);
    await assert.rejects(() => join(a, c, version), /circle is unavailable/);
    await assert.rejects(() => join(b, a, version), /circle is unavailable/);
  }
  await asUser(b.id);
  assert.deepEqual(await scalar('select public.get_blocked_people($1)', [b.id]), []);
  assert.deepEqual(await sql('select * from public.circle_blocks'), []);
  await rejected('select public.add_friend_by_code($1)', [a.code], /circle is unavailable/);
  // Third-person legacy roster includes B. Adding A there must also fail.
  await asUser(e.id);
  const legacyInvite = await scalar('select public.create_circle_invite()');
  await asUser(a.id);
  await rejected('select public.add_friend_by_code($1)', [e.code], /circle is unavailable/);
  await rejected('select public.redeem_circle_invite($1)', [legacyInvite], /circle is unavailable/);
  // Opposite-direction block remains private and equally effective.
  await asUser(a.id); await sql('select public.unblock_circle_person($1,$2)', [b.id, a.id]);
  assert.equal((await scalar("select public.get_circle_shop_v5('UTC')")).id, blockedSolo);
  await join(a, b);
  await asUser(b.id);
  const reverse = await scalar('select public.block_circle_person($1,$2,$3)', [a.id, a.group, b.id]);
  assert.equal(reverse.leftCircle, true);
  await assert.rejects(() => join(a, b), /circle is unavailable/);
  await asUser(a.id); await sql('select public.unblock_circle_person($1,$2)', [b.id, a.id]);
  await assert.rejects(() => join(a, b), /circle is unavailable/);
  console.log('PASS whole-roster + reverse block enforcement across v1/v4/v5 joins and old friend/invite paths, private owner-only lists, unblock never rejoins');

  step = 'notification expiry, non-current recipient and exact decision status';
  // The original C approval remains stored, but its decider is no longer a peer
  // of blocked B. No notification API can reinterpret it as a pending request.
  assert.equal(await context(approved, 'pending'), null);
  await admin();
  await sql("update public.time_requests set expires_at=clock_timestamp()-interval '1 second' where id=$1", [incoming]);
  assert.equal(await context(incoming, 'pending'), null);
  await assert.rejects(() => request(d), /Join a friend’s circle/);
  console.log('PASS stale/expired notification suppression and solo requests fail closed');

  step = 'repeat leave/rejoin cannot duplicate daily awards or starter balance';
  await admin();
  await db.exec(`create or replace function public.camp_now() returns timestamptz language sql volatile
    set search_path = '' as $$ select current_setting('test.safety_clock')::timestamptz $$;`);
  await sql("select set_config('test.safety_clock','2040-01-01T12:00:00Z',false)");
  const f = await user('Daily safety F'); const g = await user('Daily safety G');
  const departedGroups = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    await join(f,g);
    await asUser(f.id);
    const result = await scalar('select public.leave_shared_circle($1,$2)',[g.group,f.id]);
    assert.equal(result.circleShop.balance,0); assert.equal(result.circleShop.eligibleToday,false);
    departedGroups.push(result.circleShop.id);
    assert.equal((await scalar('select public.leave_shared_circle($1,$2)',[result.circleShop.id,f.id])).leftCircle,false);
  }
  await admin(); await sql("select set_config('test.safety_clock','2040-01-03T12:00:00Z',false)");
  await asUser(f.id); assert.equal((await scalar("select public.get_circle_shop_v5('UTC')")).balance,1);
  await asUser(g.id); assert.equal((await scalar("select public.get_circle_shop_v5('UTC')")).balance,100);
  await admin();
  for (const group of departedGroups.slice(0,-1)) {
    await sql('select public.camp_settle($1)',[group]);
    assert.equal(await scalar('select balance from public.camp_groups where id=$1',[group]),0);
    assert.equal(await scalar('select count(*)::int from public.camp_group_days where group_id=$1 and earned',[group]),0);
  }
  assert.equal(await scalar('select count(*)::int from public.camp_group_days where group_id=any($1::uuid[]) and day=$2::date and earned',
    [[g.group,...departedGroups],'2040-01-01']),0);
  console.log('PASS repeated leave/rejoin keeps zero starter funds, partial days never earn, empty abandoned groups never earn, genuine complete clean days still earn once');

  step = 'existing grant and account-access regression fixtures under the new safety migration';
  await admin();
  await db.exec(`create or replace function public.camp_now() returns timestamptz language sql volatile
    set search_path = '' as $$ select clock_timestamp() $$;`);
  for (const name of ['screen_time_grants.sql','account_access.sql']) {
    await db.exec(await readFile(path.join(directory,name),'utf8'));
    console.log(`PASS existing ${name} against 0026`);
  }
  console.log('PASS all disposable migration/behavior fixtures; no live database touched');
} catch (error) {
  console.error(`FAIL ${step}: ${error.stack ?? error.message}`);
  if (error.detail) console.error(error.detail);
  if (error.where) console.error(error.where);
  process.exitCode = 1;
} finally { await db.close(); }
