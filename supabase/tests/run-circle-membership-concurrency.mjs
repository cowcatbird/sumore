// Real PostgreSQL, entirely disposable and Unix-socket-only (no TCP listener).
// Never reads production credentials, an existing cluster, or environment DB URLs.
// node supabase/tests/run-circle-membership-concurrency.mjs /opt/homebrew/opt/postgresql@17/bin
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
const directory = await mkdtemp(path.join(os.tmpdir(), 'sumore-circle-concurrency.'));
const cluster = path.join(directory, 'pg');
const here = path.dirname(fileURLToPath(import.meta.url));
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: directory };
const args = ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', directory, '-p', '55426', '-U', 'postgres', '-d', 'postgres'];
let started = false;
let step = 'bootstrap';
const active = new Set();
function command(executable, argv, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { env, cwd: directory, stdio: ['pipe','pipe','pipe'] });
    active.add(child);
    const timeout = setTimeout(() => { child.kill('SIGTERM'); }, 15000);
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
async function user(name) {
  const id = randomUUID();
  await sql(`insert into auth.users(id,raw_user_meta_data) values('${id}',${literal(JSON.stringify({display_name: name}))});`);
  const actor = { id, code: await sql(`select friend_code from public.profiles where id='${id}';`) };
  actor.group = (await rpc(actor, "public.get_circle_shop_v5('UTC')")).id;
  return actor;
}
// Keep transaction 1 open after its complete safety mutation, then observe
// transaction 2 actually waiting on an advisory lock (not an arbitrary sleep).
async function heldTransaction(actor, expression) {
  const child = spawn(path.join(pgBin, 'psql'), args, { env, cwd: directory, stdio: ['pipe','pipe','pipe'] });
  active.add(child);
  let errors = ''; let output = ''; let reached;
  const barrier = new Promise((resolve, reject) => {
    reached = resolve;
    child.on('error', reject);
    child.on('close', code => { if (!output.includes('SAFETY_BARRIER')) reject(new Error(`No transaction barrier: ${code} ${errors}`)); });
  });
  child.stdout.on('data', value => { output += value; if (output.includes('SAFETY_BARRIER')) reached(); });
  child.stderr.on('data', value => { errors += value; });
  const done = new Promise((resolve, reject) => child.on('close', code => {
    active.delete(child);
    if (code === 0) resolve(output); else reject(new Error(errors));
  }));
  const timeout = setTimeout(() => child.kill('SIGTERM'), 12000);
  child.stdin.write(`begin; ${identity(actor)} select to_jsonb(${expression});\n\\echo SAFETY_BARRIER\n`);
  await barrier;
  return async () => {
    child.stdin.end('commit;\n');
    try { return await done; } finally { clearTimeout(timeout); }
  };
}
async function race(first, firstExpression, second, secondExpression, expectedPattern = null) {
  const release = await heldTransaction(first, firstExpression);
  const app = `safety_wait_${randomUUID().replaceAll('-','')}`;
  const waiting = sql(`set application_name='${app}'; begin; ${identity(second)} select to_jsonb(${secondExpression}); commit;`)
    .then(value => ({ value }), error => ({ error }));
  let observed = false;
  try {
    for (let tries = 0; tries < 30; tries++) {
      observed = await sql(`select exists(select 1 from pg_stat_activity where application_name='${app}' and wait_event_type='Lock' and wait_event='advisory');`) === 't';
      if (observed) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(observed, 'Second connection must genuinely wait on the safety mutex');
  } finally { await release(); }
  const result = await waiting;
  if (expectedPattern) {
    assert(result.error, 'Unsafe concurrent operation must fail');
    assert.match(result.error.message, expectedPattern);
  } else {
    if (result.error) throw result.error;
    assert(result.value, 'Safe concurrent operation should finish');
  }
  return result;
}

try {
  await command(path.join(pgBin, 'initdb'), ['-D', cluster, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--locale=C', '--encoding=UTF8']);
  // Local auth is confined by a random mode-0700 socket directory; TCP disabled.
  await command(path.join(pgBin, 'pg_ctl'), ['-D',cluster,'-l',path.join(directory,'postgres.log'),'-o',
    `-h '' -k ${directory} -p 55426 -c shared_buffers=32MB -c max_connections=12 -c log_statement=none`, '-w','start']);
  started = true;
  await sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
    create publication supabase_realtime;
    create table auth.users(id uuid primary key,raw_user_meta_data jsonb not null default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  const migrations = path.join(here,'../migrations');
  for (const name of (await readdir(migrations)).filter(name => /^\d{4}_.*\.sql$/.test(name) && (Number(name.slice(0,4)) <= 24 || name.startsWith('0026_'))).sort()) {
    step = name;
    if (name.startsWith('0016_')) await sql('alter default privileges in schema public grant all on tables to anon,authenticated,service_role;');
    await sql(await readFile(path.join(migrations,name),'utf8'));
  }
  const a = await user('Concurrent QA A'); const b = await user('Concurrent QA B'); const c = await user('Concurrent QA C');
  await rpc(b, `public.join_shared_circle_v5('${a.code}')`);
  await rpc(c, `public.join_shared_circle_v5('${a.code}')`);

  step = 'block commits first, reverse join waits then refuses';
  await race(a, `public.block_circle_person('${b.id}','${a.group}','${a.id}')`, b,
    `public.join_shared_circle_v5('${a.code}')`, /That circle is unavailable/);
  assert.equal(await sql(`select a.group_id<>b.group_id from public.camp_group_members a,public.camp_group_members b where a.user_id='${a.id}' and b.user_id='${b.id}';`), 't');
  console.log('PASS real simultaneous block-before-join: waiter cannot share blocked group');

  step = 'third-party legacy join waits behind existing blocker transaction';
  const solo = (await rpc(a,"public.get_circle_shop_v5('UTC')")).id;
  await race(a, `public.block_circle_person('${b.id}','${solo}','${a.id}')`, a,
    `public.join_shared_circle('${c.code}')`, /That circle is unavailable/);
  console.log('PASS legacy third-party-code join waits and cannot bypass destination-roster block');

  step = 'join commits first, block waits then separates blocker';
  await rpc(a,`public.unblock_circle_person('${b.id}','${a.id}')`);
  await race(a, `public.join_shared_circle_v5('${b.code}')`, b,
    `public.block_circle_person('${a.id}','${a.group}','${b.id}')`);
  assert.equal(await sql(`select a.group_id<>b.group_id from public.camp_group_members a,public.camp_group_members b where a.user_id='${a.id}' and b.user_id='${b.id}';`), 't');
  console.log('PASS real join-before-block: block sees committed roster and moves only blocker');

  step = 'leave commits first, pending decision waits and refuses';
  const pending = await rpc(a,"public.create_time_request(15::smallint,'Race','Selected apps')");
  await race(a,`public.leave_shared_circle('${a.group}','${a.id}')`,c,
    `public.decide_time_request('${pending}','approved')`, /Request is no longer available/);
  assert.equal(await sql(`select status from public.time_requests where id='${pending}';`),'cancelled');
  console.log('PASS leave-before-approval: old pending request cannot be approved after departure');

  step = 'approval commits first, subsequent leave preserves real approved grant';
  await rpc(a,`public.join_shared_circle_v5('${c.code}')`);
  const approved = await rpc(a,"public.create_time_request(15::smallint,'Race two','Selected apps')");
  await race(c,`public.decide_time_request('${approved}','approved')`,a,
    `public.leave_shared_circle('${a.group}','${a.id}')`);
  const grant = await rpc(a,`public.claim_screen_time_grant('${approved}')`);
  assert.equal(grant.requestId,approved);
  assert.equal(await sql(`select status from public.time_requests where id='${approved}';`),'approved');
  console.log('PASS approval-before-leave: already-authorized grant remains claimable and expires normally');
  console.log('PASS native PostgreSQL concurrency fixtures; no hosted services or real accounts touched');
} catch (error) {
  console.error(`FAIL ${step}: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const child of active) child.kill('SIGTERM');
  if (started) await command(path.join(pgBin,'pg_ctl'),['-D',cluster,'-m','fast','-w','stop']);
  console.log(`Disposable PostgreSQL stopped. Isolated fixture files: ${directory}`);
}
