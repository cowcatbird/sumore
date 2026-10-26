// Real, disposable PostgreSQL with a private Unix socket and no TCP listener.
// No environment credentials, existing clusters, hosted services, or real users.
// node supabase/tests/run-panic-zero-balance.mjs /opt/homebrew/opt/postgresql@17/bin
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pgBin = process.argv[2];
assert(pgBin && path.isAbsolute(pgBin), 'Provide an absolute PostgreSQL binary directory');
process.umask(0o077);
const directory = await mkdtemp(path.join(os.tmpdir(), 'sumore-panic-balance.'));
const cluster = path.join(directory, 'pg');
const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.join(here, '../migrations');
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: directory };
const args = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', directory, '-p', '55431', '-U', 'postgres', '-d', 'postgres'];
const active = new Set();
let started = false;
let step = 'bootstrap';

function command(executable, argv, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { env, cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    active.add(child);
    const timeout = setTimeout(() => child.kill('SIGTERM'), 15_000);
    let output = ''; let errors = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { errors += value; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout); active.delete(child);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${path.basename(executable)} exited ${code}: ${errors}`));
    });
    child.stdin.end(input);
  });
}
const sql = text => command(path.join(pgBin, 'psql'), args, text);
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const identity = actor => `set local role authenticated; set local request.jwt.claim.sub=${literal(actor.id)};`;
const rpc = async (actor, expression) => JSON.parse(await sql(`begin; ${identity(actor)} select to_jsonb(${expression}); commit;`));
const panicCall = actor => `public.use_panic_button('${actor.id}'::uuid)`;
const wallet = actor => sql(`select balance from public.camp_groups where id='${actor.group}';`).then(Number);
const balance = (actor, amount) => sql(`update public.camp_groups set balance=${amount} where id='${actor.group}';`);

async function user(name, zone = 'UTC') {
  const id = randomUUID();
  await sql(`insert into auth.users(id,raw_user_meta_data) values('${id}',${literal(JSON.stringify({ display_name: name }))});`);
  const actor = { id, name, code: await sql(`select friend_code from public.profiles where id='${id}';`) };
  actor.shop = await rpc(actor, `public.get_circle_shop_v5(${literal(zone)})`);
  actor.group = actor.shop.id;
  return actor;
}

async function allFixtureRows() {
  const tables = JSON.parse(await sql(`select jsonb_agg(jsonb_build_object('schema',schemaname,'table',tablename)
    order by schemaname,tablename) from pg_tables
    where schemaname='public' or (schemaname='auth' and tablename='users');`));
  const rows = {};
  for (const table of tables) {
    assert.match(table.schema, /^[a-z_]+$/); assert.match(table.table, /^[a-z_]+$/);
    rows[`${table.schema}.${table.table}`] = JSON.parse(await sql(
      `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) from ${table.schema}.${table.table} t;`));
  }
  return rows;
}

async function assertPanic(actor, result, expectedBalance) {
  assert.equal(result.shop.balance, expectedBalance);
  assert.equal(await wallet(actor), expectedBalance);
  assert.equal(result.shop.askedToday, true);
  assert.equal(result.grant.requesterId, actor.id);
  assert.equal(result.grant.requestId, null);
  assert.equal(result.grant.source, 'panic');
  assert.equal(result.grant.startedAt, result.grant.serverNow);
  assert.equal(Date.parse(result.grant.expiresAt) - Date.parse(result.grant.startedAt), 15 * 60_000);
  assert.equal(await sql(`select count(*) from public.panic_events e
    join public.camp_groups g on g.id=e.group_id
    join public.screen_time_grants s on s.id='${result.grant.grantId}'
    where e.actor_id='${actor.id}' and e.group_id='${actor.group}' and e.actor_name=${literal(actor.name)}
      and e.day=(e.created_at at time zone g.time_zone)::date and e.expires_at=s.expires_at
      and s.minutes=15 and s.source='panic' and s.request_id is null;`), '1');
  const restored = await rpc(actor, 'public.get_active_screen_time_grant()');
  for (const key of ['grantId', 'requesterId', 'requestId', 'source', 'startedAt', 'expiresAt']) {
    assert.equal(restored[key], result.grant[key]);
  }
}

// Hold a completed panic mutation open, then observe the other PostgreSQL
// connection actually waiting on a lock before releasing the first one.
async function heldPanic(actor) {
  const child = spawn(path.join(pgBin, 'psql'), args, { env, cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
  active.add(child);
  let output = ''; let errors = ''; let reached;
  const barrier = new Promise((resolve, reject) => {
    reached = resolve;
    child.on('error', reject);
    child.on('close', code => { if (!output.includes('PANIC_BARRIER')) reject(new Error(`No panic barrier: ${code} ${errors}`)); });
  });
  child.stdout.on('data', value => { output += value; if (output.includes('PANIC_BARRIER')) reached(); });
  child.stderr.on('data', value => { errors += value; });
  const done = new Promise((resolve, reject) => child.on('close', code => {
    active.delete(child);
    if (code === 0) resolve(output); else reject(new Error(errors));
  }));
  const timeout = setTimeout(() => child.kill('SIGTERM'), 12_000);
  child.stdin.write(`begin; ${identity(actor)} select ${panicCall(actor)};\n\\echo PANIC_BARRIER\n`);
  await barrier;
  const receipt = JSON.parse(output.split('\n').find(line => line.startsWith('{')));
  return {
    receipt,
    release: async (rollback = false) => {
      child.stdin.end(rollback ? 'rollback;\n' : 'commit;\n');
      try { await done; } finally { clearTimeout(timeout); }
    },
  };
}

async function race(first, second, { reject = false, rollback = false } = {}) {
  const held = await heldPanic(first);
  const app = `panic_wait_${randomUUID().replaceAll('-', '')}`;
  const waiting = sql(`set application_name='${app}'; begin; ${identity(second)} select ${panicCall(second)}; commit;`)
    .then(value => ({ value: JSON.parse(value) }), error => ({ error }));
  let observed = false;
  try {
    for (let tries = 0; tries < 50; tries++) {
      observed = await sql(`select exists(select 1 from pg_stat_activity
        where application_name='${app}' and wait_event_type='Lock');`) === 't';
      if (observed) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(observed, 'Second connection must wait on the existing account/group lock');
  } finally { await held.release(rollback); }
  const result = await waiting;
  if (reject) {
    assert(result.error, 'Concurrent repeat must reject an already-running break');
    assert.match(result.error.message, /Your extra time is already running/);
  } else if (result.error) throw result.error;
  return { first: held.receipt, second: result.value };
}

try {
  await command(path.join(pgBin, 'initdb'), ['-D', cluster, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--locale=C', '--encoding=UTF8']);
  await command(path.join(pgBin, 'pg_ctl'), ['-D', cluster, '-l', path.join(directory, 'postgres.log'), '-o',
    `-h '' -k ${directory} -p 55431 -c shared_buffers=32MB -c max_connections=12 -c log_statement=none`, '-w', 'start']);
  started = true;
  await sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
    create publication supabase_realtime;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  for (const name of (await readdir(migrations)).filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 30).sort()) {
    step = name;
    if (name.startsWith('0016_')) await sql('alter default privileges in schema public grant all on tables to anon,authenticated,service_role;');
    await sql(await readFile(path.join(migrations, name), 'utf8'));
  }

  step = 'upgrade preserves every existing wallet and fixture row';
  const existing = await user('Existing earned wallet');
  const empty = await user('Existing empty wallet');
  await balance(existing, 12); await balance(empty, 0);
  await rpc(existing, `public.purchase_circle_item_v5('${existing.group}','hat:cat-ears',5)`);
  await rpc(existing, 'public.use_panic_button()');
  const before = await allFixtureRows();
  const migration = await readFile(path.join(migrations, '0031_panic_zero_balance.sql'), 'utf8');
  await sql(migration);
  assert.deepEqual(await allFixtureRows(), before);
  await sql(migration);
  assert.deepEqual(await allFixtureRows(), before);
  assert.equal(await wallet(existing), 6); assert.equal(await wallet(empty), 0);
  assert.equal(await sql("select column_default from information_schema.columns where table_schema='public' and table_name='camp_groups' and column_name='balance';"), '0');
  console.log('PASS upgrade and reapplication preserve all existing rows, earned/zero wallets, purchases, history and active grants');

  step = 'account binding and notification ACL upgrade preserves existing rows';
  assert.equal(await sql("select has_function_privilege('service_role','public.panic_notification_context(uuid)','EXECUTE');"), 'f');
  const bindingMigration = await readFile(path.join(migrations, '0032_panic_account_binding.sql'), 'utf8');
  await sql(bindingMigration);
  assert.deepEqual(await allFixtureRows(), before);
  await sql(bindingMigration);
  assert.deepEqual(await allFixtureRows(), before);
  console.log('PASS 0032 and reapplication preserve rows while restoring only service-role notification access');

  step = 'new groups, repeated reads, joins and leaves start at zero';
  const fresh = await user('New zero wallet'); const joiner = await user('New joining wallet');
  assert.equal(fresh.shop.balance, 0); assert.equal(joiner.shop.balance, 0);
  assert.deepEqual(fresh.shop.unlocked, []);
  assert.equal((await rpc(fresh, "public.get_circle_shop_v5('UTC')")).balance, 0);
  assert.equal((await rpc(joiner, `public.join_shared_circle_v5('${fresh.code}')`)).balance, 0);
  const left = await rpc(joiner, `public.leave_shared_circle('${fresh.group}','${joiner.id}')`);
  assert.equal(left.circleShop.balance, 0);
  assert.equal((await rpc(joiner, "public.get_circle_shop_v5('UTC')")).balance, 0);
  console.log('PASS new and leave-created groups start at zero; reads and joins never refill wallets');

  step = 'null and stale expected accounts cannot mutate either account';
  const untouched = await allFixtureRows();
  await assert.rejects(() => rpc(fresh, 'public.use_panic_button(null::uuid)'), /Your account changed/);
  await assert.rejects(() => rpc(fresh, panicCall(joiner)), /Your account changed/);
  await assert.rejects(() => rpc(joiner, panicCall(fresh)), /Your account changed/);
  assert.deepEqual(await allFixtureRows(), untouched);
  // The same guard must run even before a brand-new account has a group.
  const noGroup = { id: randomUUID() };
  await sql(`insert into auth.users(id,raw_user_meta_data) values('${noGroup.id}','{"display_name":"No group yet"}');`);
  const beforeGroup = await allFixtureRows();
  await assert.rejects(() => rpc(noGroup, 'public.use_panic_button(null::uuid)'), /Your account changed/);
  await assert.rejects(() => rpc(noGroup, panicCall(fresh)), /Your account changed/);
  assert.deepEqual(await allFixtureRows(), beforeGroup);
  console.log('PASS null/stale expected accounts leave every row unchanged, including before group creation');

  step = 'zero, one and positive balance panic grants';
  for (const amount of [0, 1, 7]) {
    const actor = await user(`Panic balance ${amount}`, 'Pacific/Kiritimati');
    await balance(actor, amount);
    const receipt = await rpc(actor, panicCall(actor));
    await assertPanic(actor, receipt, Math.max(amount - 1, 0));
    const afterFirst = await allFixtureRows();
    await assert.rejects(() => rpc(actor, panicCall(actor)), /Your extra time is already running/);
    assert.deepEqual(await allFixtureRows(), afterFirst);
  }
  console.log('PASS balances 0→0, 1→0 and 7→6; fixed 15-minute receipt, day burn, event, restore and duplicate refusal');

  step = 'installed zero-argument clients retain compatibility';
  const legacy = await user('Legacy panic client');
  await assertPanic(legacy, await rpc(legacy, 'public.use_panic_button()'), 0);
  console.log('PASS zero-argument panic compatibility remains available to authenticated installed clients');

  step = 'authentication, account and direct-write guards';
  await assert.rejects(() => sql('set role anon; select public.use_panic_button();'), /permission denied/);
  await assert.rejects(() => rpc({ id: '' }, 'public.use_panic_button()'), /Authentication required/);
  await assert.rejects(() => rpc({ id: randomUUID() }, 'public.use_panic_button()'), /Your account is not available/);
  await assert.rejects(() => sql(`set role anon; select ${panicCall(fresh)};`), /permission denied/);
  await assert.rejects(() => sql(`set role service_role; select ${panicCall(fresh)};`), /permission denied/);
  await assert.rejects(() => rpc({ id: '' }, panicCall(fresh)), /Authentication required/);
  const unavailable = { id: randomUUID() };
  await assert.rejects(() => rpc(unavailable, panicCall(unavailable)), /Your account is not available/);
  await assert.rejects(() => sql(`begin; ${identity(fresh)} update public.camp_groups set balance=99 where id='${fresh.group}'; commit;`), /permission denied/);
  await assert.rejects(() => sql(`begin; ${identity(fresh)} insert into public.panic_events(group_id,actor_id,actor_name,day,expires_at)
    values('${fresh.group}','${fresh.id}','Forged',current_date,clock_timestamp()); commit;`), /permission denied/);
  console.log('PASS anonymous, missing-account and direct-write denial');

  step = 'an approved request grant still blocks panic without side effects';
  const requester = await user('Request grant owner'); const approver = await user('Request grant approver');
  await rpc(approver, `public.join_shared_circle_v5('${requester.code}')`);
  const request = await rpc(requester, "public.create_time_request(15::smallint,'Panic regression','Selected apps')");
  await rpc(approver, `public.decide_time_request('${request}','approved')`);
  await rpc(requester, `public.claim_screen_time_grant('${request}')`);
  const approved = await allFixtureRows();
  await assert.rejects(() => rpc(requester, panicCall(requester)), /Your extra time is already running/);
  assert.deepEqual(await allFixtureRows(), approved);
  console.log('PASS active request grants still exclude panic without charging or recording an event');

  step = 'notification helper resolves recipients only for the service role';
  const sender = await user('Panic notification sender'); const recipient = await user('Panic notification recipient');
  const outsider = await user('Panic notification outsider');
  await rpc(recipient, `public.join_shared_circle_v5('${sender.code}')`);
  const recipientToken = `ExponentPushToken[${recipient.id}]`;
  await sql(`insert into public.device_push_tokens(user_id,token,platform) values
    ('${sender.id}','ExponentPushToken[${sender.id}]','ios'),
    ('${recipient.id}',${literal(recipientToken)},'ios'),
    ('${outsider.id}','ExponentPushToken[${outsider.id}]','ios');`);
  await rpc(sender, panicCall(sender));
  const eventId = await sql(`select id from public.panic_events where actor_id='${sender.id}';`);
  const contextCall = `public.panic_notification_context('${eventId}'::uuid)`;
  const context = JSON.parse(await sql(`set role service_role; select ${contextCall};`));
  assert.deepEqual(context, { panicId: eventId, actorName: sender.name, tokens: [recipientToken] });
  await assert.rejects(() => sql(`set role anon; select ${contextCall};`), /permission denied/);
  await assert.rejects(() => rpc(sender, contextCall), /permission denied/);
  await assert.rejects(() => rpc(recipient, contextCall), /permission denied/);
  await sql(`update public.device_push_tokens set disabled_at=clock_timestamp() where token=${literal(recipientToken)};`);
  assert.equal(await sql(`set role service_role; select ${contextCall} is null;`), 't');
  console.log('PASS service-role notification RPC returns only active current-peer tokens; anonymous/authenticated callers remain denied');

  step = 'two members concurrently panic from zero or the last s’more';
  for (const amount of [0, 1]) {
    const first = await user(`Concurrent ${amount} first`); const second = await user(`Concurrent ${amount} second`);
    await rpc(second, `public.join_shared_circle_v5('${first.code}')`); second.group = first.group;
    await balance(first, amount);
    const receipts = await race(first, second);
    assert.notEqual(receipts.first.grant.grantId, receipts.second.grant.grantId);
    await assertPanic(first, receipts.first, 0); await assertPanic(second, receipts.second, 0);
    assert.equal(await sql(`select count(*) from public.panic_events where group_id='${first.group}';`), '2');
  }
  console.log('PASS real two-member races at 0 and 1: both get one break, two events, shared wallet remains zero');

  step = 'same-account concurrent repeat and rollback';
  const duplicate = await user('Concurrent same account'); await balance(duplicate, 3);
  const one = await race(duplicate, duplicate, { reject: true });
  await assertPanic(duplicate, one.first, 2);
  assert.equal(await sql(`select count(*) from public.screen_time_grants where requester_id='${duplicate.id}';`), '1');
  assert.equal(await sql(`select count(*) from public.panic_events where actor_id='${duplicate.id}';`), '1');
  const rollback = await user('Concurrent rollback'); await balance(rollback, 1);
  const rolled = await race(rollback, rollback, { rollback: true });
  await assertPanic(rollback, rolled.second, 0);
  assert.equal(await sql(`select count(*) from public.screen_time_grants where requester_id='${rollback.id}';`), '1');
  assert.equal(await sql(`select count(*) from public.panic_events where actor_id='${rollback.id}';`), '1');
  console.log('PASS real same-account races: one debit/grant/event; rollback lets the waiter succeed exactly once');
  console.log('PASS disposable PostgreSQL backend regression suite; no hosted database or physical device tested');
} catch (error) {
  console.error(`FAIL ${step}: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const child of active) child.kill('SIGTERM');
  if (started) await command(path.join(pgBin, 'pg_ctl'), ['-D', cluster, '-m', 'fast', '-w', 'stop']);
  console.log(`Disposable PostgreSQL stopped. Isolated fixture files: ${directory}`);
}
