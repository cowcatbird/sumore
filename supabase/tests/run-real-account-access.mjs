// Disposable, loopback-only acceptance against the real GoTrue binary and PostgreSQL.
// Usage: node supabase/tests/run-real-account-access.mjs /absolute/path/to/auth /absolute/path/to/pg/bin
// Never reads .env files, production URLs, or existing database credentials.
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountAccessHandler, hashSecret, createLoginKey } from '../functions/account-access/core.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const require = createRequire(path.join(repo, 'apps/mobile/package.json'));
const { GoTrueClient } = require('@supabase/auth-js');
const binary = process.argv[2];
const pgBin = process.argv[3];
assert(binary && pgBin && path.isAbsolute(binary) && path.isAbsolute(pgBin), 'Provide absolute Auth binary and PostgreSQL bin paths');
process.umask(0o077);
const directory = await mkdtemp(path.join(os.tmpdir(), 'sumore-auth-acceptance.'));
await chmod(directory, 0o700);
const baseEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TMPDIR: directory };
const pgPassword = randomBytes(32).toString('hex');
const authPassword = randomBytes(32).toString('hex');
const jwtSecret = randomBytes(48).toString('hex');
const passFile = path.join(directory, 'init-password');
await writeFile(passFile, pgPassword, { mode: 0o600 });
const cluster = path.join(directory, 'postgres');
let postgresStarted = false;
let authProcess;
let stage = 'initialization';
const evidence = [];
let deletionRejections;
function passed(message) { evidence.push(message); console.log(`PASS ${message}`); }
function command(executable, args, { input = '', env = baseEnv, cwd = directory } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', part => { output += part; });
    child.stderr.on('data', part => { errors += part; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(output.trim());
      else { const error = new Error(`Local command failed: ${path.basename(executable)} (exit ${code})`); error.details = errors; reject(error); }
    });
    child.stdin.end(input);
  });
}
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const dbPort = await freePort();
const authPort = await freePort();
const authUrl = `http://127.0.0.1:${authPort}`;
const database = `sumore_qa_${randomBytes(6).toString('hex')}`;
const pgEnv = { ...baseEnv, PGPASSWORD: pgPassword };
function sql(text, db = database) {
  return command(path.join(pgBin, 'psql'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(dbPort), '-U', 'postgres', '-d', db], { env: pgEnv, input: text });
}
const literal = value => value === null || value === undefined ? 'null' : typeof value === 'object'
  ? `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb` : `'${String(value).replaceAll("'", "''")}'`;
const ident = value => { assert(/^[a-z][a-z0-9_]*$/.test(value), 'Unsafe SQL identifier'); return `"${value}"`; };
async function rpc(name, args = {}, role = 'service_role', userId = null) {
  assert(['service_role', 'authenticated', 'anon'].includes(role));
  const claim = userId ? `set local request.jwt.claim.sub = ${literal(userId)};` : '';
  const result = await sql(`begin; set local role ${role}; ${claim}
    select jsonb_build_object('value',public.${ident(name)}(${Object.entries(args).map(([key, value]) => `${ident(key)} => ${literal(value)}`).join(',')})); commit;`);
  return JSON.parse(result).value;
}
const jwt = role => {
  // Local self-hosted test keys only, generated from an ephemeral secret.
  const data = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ role, iss: 'supabase', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')].join('.');
  return `${data}.${createHmac('sha256', jwtSecret).update(data).digest('base64url')}`;
};
const client = key => new GoTrueClient({ url: authUrl, headers: { Authorization: `Bearer ${key}` }, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
const admin = client(jwt('service_role'));
const publicKey = jwt('anon');
async function newUser(name) {
  const auth = client(publicKey);
  const result = await auth.signInAnonymously({ options: { data: { display_name: name } } });
  assert(!result.error && result.data.session && result.data.user, 'Real anonymous sign-in must succeed');
  return { auth, session: result.data.session, id: result.data.user.id };
}
async function userFromToken(token) {
  const { data, error } = await admin.getUser(token); return error ? null : data.user;
}
const deps = {
  authenticate: userFromToken, rpc,
  async getUser(id) { const { data, error } = await admin.admin.getUserById(id); return error ? null : data.user; },
  async attachRecoveryIdentity(user, email) {
    const { data, error } = await admin.admin.updateUserById(user.id, { email, email_confirm: true, app_metadata: { ...user.app_metadata, sumore_recovery_identity: true } });
    assert(!error && data.user, 'Real Auth identity upgrade must succeed'); return data.user;
  },
  async createSession(user) {
    const { data, error } = await admin.admin.generateLink({ type: 'magiclink', email: user.email });
    assert(!error && data.user.id === user.id && data.properties.hashed_token, 'Real Auth link must target same user');
    const result = await client(publicKey).verifyOtp({ type: 'magiclink', token_hash: data.properties.hashed_token });
    assert(!result.error && result.data.user?.id === user.id && result.data.session, 'Real Auth OTP must yield target session');
    return result.data.session;
  },
  async deleteAccount(token) {
    const owner = await userFromToken(token); assert(owner, 'Deleted account must be authenticated');
    await rpc('delete_my_account', {}, 'authenticated', owner.id);
  },
  async ipHash() { return hashSecret('disposable-loopback-acceptance'); },
};
const handler = createAccountAccessHandler(deps);
async function action(user, body, useHandler = handler) {
  const response = await useHandler(new Request(`${authUrl}/account-access`, { method: 'POST', headers: { Authorization: `Bearer ${user.session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json() };
}
async function successful(user, body, useHandler = handler) { const result = await action(user, body, useHandler); assert.equal(result.status, 200, `${body.action} must succeed`); return result.body; }
async function shop(user) { return rpc('get_circle_shop_v5', { tz: 'UTC' }, 'authenticated', user.id); }
function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.replace(/=+$/, '').toUpperCase()].map(value => {
    const index = alphabet.indexOf(value); assert(index >= 0); return index.toString(2).padStart(5, '0');
  }).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  return String((digest.readUInt32BE(digest[19] & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}

try {
  const authVersion = await command(binary, ['version']); assert.equal(authVersion, 'v2.197.0');
  await command(path.join(pgBin, 'initdb'), ['-D', cluster, '-U', 'postgres', '--auth=scram-sha-256', `--pwfile=${passFile}`, '--locale=C', '--encoding=UTF8']);
  await command(path.join(pgBin, 'pg_ctl'), ['-D', cluster, '-l', path.join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${dbPort} -k ${directory} -c max_connections=40 -c shared_buffers=32MB -c log_statement=none`, '-w', 'start']);
  postgresStarted = true;
  await sql(`create database ${ident(database)};`, 'postgres');
  await sql(`create role anon; create role authenticated; create role service_role bypassrls;
    create role supabase_auth_admin login password ${literal(authPassword)} noinherit createrole;
    create schema auth authorization supabase_auth_admin;
    grant create on database ${ident(database)} to supabase_auth_admin;
    alter role supabase_auth_admin set search_path to auth;
    create schema extensions; create extension pgcrypto with schema extensions;
    create publication supabase_realtime;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;`);
  const authLog = await open(path.join(directory, 'auth.log'), 'a', 0o600);
  const authEnv = { ...baseEnv, GOTRUE_API_HOST: '127.0.0.1', PORT: String(authPort), API_EXTERNAL_URL: authUrl,
    GOTRUE_DB_DRIVER: 'postgres', DB_NAMESPACE: 'auth', GOTRUE_DB_MIGRATIONS_PATH: path.join(path.dirname(binary), 'migrations'), DATABASE_URL: `postgres://supabase_auth_admin:${authPassword}@127.0.0.1:${dbPort}/${database}?sslmode=disable`,
    GOTRUE_JWT_SECRET: jwtSecret, GOTRUE_JWT_EXP: '3600', GOTRUE_JWT_AUD: 'authenticated', GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated', GOTRUE_JWT_ADMIN_ROLES: 'service_role',
    GOTRUE_SITE_URL: authUrl, GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true', GOTRUE_EXTERNAL_PHONE_ENABLED: 'false', GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: 'true', GOTRUE_DISABLE_SIGNUP: 'false',
    GOTRUE_MAILER_AUTOCONFIRM: 'false', GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED: 'true', GOTRUE_SECURITY_MANUAL_LINKING_ENABLED: 'false',
    GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: 'true', GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL: '10',
    GOTRUE_MFA_TOTP_ENROLL_ENABLED: 'true', GOTRUE_MFA_TOTP_VERIFY_ENABLED: 'true', GOTRUE_LOG_LEVEL: 'error', LOG_LEVEL: 'error',
    GOTRUE_RATE_LIMIT_ANONYMOUS_USERS: '200', GOTRUE_RATE_LIMIT_VERIFY: '200', GOTRUE_RATE_LIMIT_TOKEN_REFRESH: '200',
    GOTRUE_SMTP_HOST: '127.0.0.1', GOTRUE_SMTP_PORT: '1', GOTRUE_SMTP_ADMIN_EMAIL: 'noreply@sumore.invalid', GOTRUE_SMTP_SENDER_NAME: 'Disposable acceptance' };
  // The empty private working directory also prevents GoTrue loading a local
  // .env beside an installed binary. Only our generated environment is passed.
  await command(binary, ['migrate'], { env: authEnv });
  authProcess = spawn(binary, ['serve'], { env: authEnv, cwd: directory, stdio: ['ignore', authLog.fd, authLog.fd] });
  await authLog.close();
  let health;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (authProcess.exitCode !== null) throw new Error('Disposable Auth process exited before health check');
    try { const response = await fetch(`${authUrl}/health`); if (response.ok) { health = await response.json(); break; } } catch { /* Boot only, no credentials. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(health?.version, 'v2.197.0', 'Expected real Auth version');
  const settings = await (await fetch(`${authUrl}/settings`)).json();
  assert.equal(settings.disable_signup, false); assert.equal(settings.mailer_autoconfirm, false);
  assert.equal(settings.external.email, true); assert.equal(settings.external.anonymous_users, true);
  await sql(`grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;`);
  stage = 'app migrations';
  for (const name of (await readdir(path.join(repo, 'supabase/migrations'))).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()) {
    await sql(await readFile(path.join(repo, 'supabase/migrations', name), 'utf8'));
  }
  passed('real GoTrue v2.197.0 + PostgreSQL 17 with all application migrations');
  stage = 'anonymous identity and recovery';
  const target = await newUser('Disposable target');
  const source = await newUser('Disposable source');
  const peer = await newUser('Disposable peer');
  const originalShop = await shop(target);
  const targetKey = (await successful(target, { action: 'create' })).key;
  assert(targetKey && !targetKey.includes(target.id));
  const upgraded = await deps.getUser(target.id);
  assert.equal(upgraded.id, target.id); assert.equal(upgraded.is_anonymous, false); assert.match(upgraded.email, /@accounts\.sumore\.invalid$/);
  assert.deepEqual(await shop(target), originalShop);
  const privateRow = JSON.parse(await sql(`select jsonb_build_object('hash',key_hash,'email',recovery_email) from public.account_recovery_keys where user_id=${literal(target.id)};`));
  assert.equal(privateRow.hash, await hashSecret(targetKey)); assert.equal(privateRow.email, upgraded.email);
  assert(!JSON.stringify(privateRow).includes(targetKey));
  passed('anonymous identity upgrade preserves UUID/profile/circle/wallet and stores only key hash');
  const sourceKey = (await successful(source, { action: 'create' })).key;
  const recovered = await successful(source, { action: 'recover', key: targetKey });
  assert.equal(recovered.userId, target.id); assert(recovered.cleanupTicket);
  const restoredClient = client(publicKey);
  const installed = await restoredClient.setSession({ access_token: recovered.accessToken, refresh_token: recovered.refreshToken });
  assert(!installed.error && installed.data.user?.id === target.id);
  const refreshed = await restoredClient.refreshSession(); assert(!refreshed.error && refreshed.data.session?.user.id === target.id);
  const restored = { id: target.id, auth: restoredClient, session: refreshed.data.session };
  assert.equal((await successful(source, { action: 'status', key: sourceKey })).matches, true);
  assert.equal((await successful(restored, { action: 'finish', ticket: recovered.cleanupTicket })).previousKeyRevoked, true);
  assert.equal((await successful(source, { action: 'status', key: sourceKey })).hasKey, false);
  assert(await deps.getUser(source.id));
  assert.equal((await successful(restored, { action: 'finish', ticket: recovered.cleanupTicket })).previousKeyRevoked, false);
  passed('real magic-link verification/session install/refresh and idempotent account-switch cleanup');
  stage = 'invalid and revoked credentials';
  const malformed = await action(peer, { action: 'recover', key: 'bad' });
  const missing = await action(peer, { action: 'recover', key: createLoginKey() });
  const retired = await action(peer, { action: 'recover', key: sourceKey });
  assert.deepEqual(malformed, missing); assert.deepEqual(malformed, retired); assert.equal(malformed.status, 400);
  await assert.rejects(rpc('account_lookup_key', { candidate_hash: await hashSecret(targetKey) }, 'authenticated', peer.id));
  passed('invalid/missing/revoked keys have uniform errors and private RPC denies authenticated clients');
  const forged = await action({ session: { access_token: 'not-a-real-jwt' } }, { action: 'recover', key: targetKey });
  assert.equal(forged.status, 401);
  const revokedDuringExchange = await newUser('Revocation target');
  const revocableKey = (await successful(revokedDuringExchange, { action: 'create' })).key;
  const revokingHandler = createAccountAccessHandler({ ...deps, async createSession(user) {
    const session = await deps.createSession(user); await rpc('account_revoke_key', { actor_id: user.id }); return session;
  } });
  assert.deepEqual(await action(peer, { action: 'recover', key: revocableKey }, revokingHandler), malformed);
  assert.deepEqual(await action(peer, { action: 'recover', key: revocableKey }), malformed);
  passed('forged bearer and key revocation during real Auth exchange cannot return session credentials');
  stage = 'concurrent initial identity';
  const concurrent = await newUser('Concurrent target');
  let entrants = 0; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const racing = createAccountAccessHandler({ ...deps, async attachRecoveryIdentity(user, email) {
    entrants++; if (entrants === 2) release(); await gate; return deps.attachRecoveryIdentity(user, email);
  } });
  const keys = await Promise.all([successful(concurrent, { action: 'create' }, racing), successful(concurrent, { action: 'create' }, racing)]);
  const status = await Promise.all(keys.map(({ key }) => successful(concurrent, { action: 'status', key })));
  assert.equal(status.filter(value => value.matches).length, 1);
  const winner = keys[status.findIndex(value => value.matches)].key;
  assert.equal((await successful(peer, { action: 'recover', key: winner })).userId, concurrent.id);
  passed('simultaneous first-key identity upgrades leave exactly one usable latest key');
  stage = 'rotation versus transfer cleanup';
  const replacementSource = await newUser('Rotating source');
  await successful(replacementSource, { action: 'create' });
  const handoff = await successful(replacementSource, { action: 'recover', key: targetKey });
  const rotatedKey = (await successful(replacementSource, { action: 'create' })).key;
  assert.equal((await successful(restored, { action: 'finish', ticket: handoff.cleanupTicket })).previousKeyRevoked, false);
  assert.equal((await successful(replacementSource, { action: 'status', key: rotatedKey })).matches, true);
  passed('source-key rotation wins over delayed recovery cleanup');
  stage = 'existing email identity';
  const email = `${randomUUID()}@existing.sumore.invalid`;
  const createdEmail = await admin.admin.createUser({ email, email_confirm: true, user_metadata: { display_name: 'Existing email' } });
  assert(!createdEmail.error && createdEmail.data.user);
  const emailUser = { id: createdEmail.data.user.id, session: await deps.createSession(createdEmail.data.user) };
  const emailKey = (await successful(emailUser, { action: 'create' })).key;
  assert.equal((await deps.getUser(emailUser.id)).email, email);
  assert.equal((await successful(peer, { action: 'recover', key: emailKey })).userId, emailUser.id);
  passed('existing email identity is preserved and recovers to the same user');
  stage = 'verified MFA exclusion';
  const mfaClient = client(publicKey);
  assert(!(await mfaClient.setSession(emailUser.session)).error);
  const enrolled = await mfaClient.mfa.enroll({ factorType: 'totp', friendlyName: 'Disposable test factor' });
  assert(!enrolled.error && enrolled.data?.totp?.secret, 'Real TOTP enrollment must succeed');
  const verified = await mfaClient.mfa.challengeAndVerify({ factorId: enrolled.data.id, code: totp(enrolled.data.totp.secret) });
  assert(!verified.error, 'Real TOTP verification must succeed');
  const mfaSession = (await mfaClient.getSession()).data.session;
  assert.equal((await action({ ...emailUser, session: mfaSession }, { action: 'create' })).status, 409);
  assert.deepEqual(await action(peer, { action: 'recover', key: emailKey }), malformed);
  passed('real verified TOTP factor prevents key creation and key-based MFA bypass');
  stage = 'concurrent rate limits';
  const rateUser = await newUser('Rate-limit target');
  const rateIp = await hashSecret('independent-concurrency-rate-bucket');
  const allowed = await Promise.all(Array.from({ length: 24 }, () => rpc('account_access_allow', { actor_id: rateUser.id, ip_hash: rateIp, operation: 'recover' })));
  assert.equal(allowed.filter(Boolean).length, 15);
  passed('24 concurrent database connections honor the 15-attempt account quota exactly');
  stage = 'feedback concurrent reservations';
  const feedbackActor = await newUser('Feedback target');
  const feedbackArgs = reportId => ({ actor_id: feedbackActor.id, report_id: reportId, report_message: 'Disposable acceptance report only.', report_platform: 'ios', report_version: 'test-only', sender: 'test@sumore.invalid' });
  const reportId = randomUUID();
  const reservations = await Promise.all(Array.from({ length: 8 }, () => rpc('feedback_reserve', feedbackArgs(reportId))));
  assert.equal(reservations.filter(value => value.state === 'ready').length, 1);
  assert.equal(reservations.filter(value => value.state === 'busy').length, 7);
  const lease = reservations.find(value => value.state === 'ready').leaseId;
  assert.equal(await rpc('feedback_finish', { actor_id: feedbackActor.id, report_id: reportId, lease_id: randomUUID(), provider_id: randomUUID() }), false);
  assert.equal(await rpc('feedback_finish', { actor_id: feedbackActor.id, report_id: reportId, lease_id: lease, provider_id: randomUUID() }), true);
  assert.equal((await rpc('feedback_reserve', feedbackArgs(reportId))).state, 'sent');
  const independent = await Promise.all(Array.from({ length: 8 }, () => rpc('feedback_reserve', feedbackArgs(randomUUID()))));
  assert.equal(independent.filter(value => value.state === 'ready').length, 2);
  assert.equal(independent.filter(value => value.state === 'rateLimited').length, 6);
  await assert.rejects(rpc('feedback_reserve', feedbackArgs(randomUUID()), 'authenticated', feedbackActor.id));
  passed('feedback leases/idempotence/owner-private access and hourly quotas hold under concurrent connections');
  stage = 'shared group account deletion';
  const friendCode = await sql(`select friend_code from public.profiles where id=${literal(target.id)};`);
  await rpc('join_shared_circle_v5', { friend_code_input: friendCode }, 'authenticated', peer.id);
  stage = 'shared purchase concurrency and rollback';
  const beforeConcurrentPurchase = await shop(peer);
  const purchases = await Promise.all([target, peer].map(owner => rpc('purchase_circle_item_v5', {
    target_group_id: originalShop.id, item_id: 'hat:cat-ears', expected_cost: 5,
  }, 'authenticated', owner.id)));
  assert(purchases.every(value => value.balance === beforeConcurrentPurchase.balance - 5));
  assert(purchases.every(value => value.unlocked.filter(item => item === 'hat:cat-ears').length === 1));
  const beforeRollback = await shop(peer);
  await assert.rejects(sql(`begin; set local role authenticated; set local request.jwt.claim.sub = ${literal(target.id)};
    select public.purchase_circle_item_v5(${literal(originalShop.id)},'hat:googly-eyes',5);
    do $$ begin raise exception 'intentional_acceptance_rollback'; end $$; commit;`),
  error => error.details?.includes('intentional_acceptance_rollback'));
  const afterRollback = await shop(peer);
  assert.equal(afterRollback.balance, beforeRollback.balance);
  assert.deepEqual(afterRollback.unlocked, beforeRollback.unlocked);
  passed('two members purchasing the same new accessory charge once; failed transaction rolls back balance and unlock');
  stage = 'shared group account deletion';
  await rpc('purchase_circle_item_v5', { target_group_id: originalShop.id, item_id: 'hat:crown', expected_cost: 10 }, 'authenticated', target.id);
  await rpc('set_shared_app_limits', { entries: [{ label: 'Test game', minutes: 15 }], allocation_minutes: 15, expected_user_id: target.id }, 'authenticated', target.id);
  await rpc('feedback_reserve', { ...feedbackArgs(randomUUID()), actor_id: target.id });
  const peerRequest = await rpc('create_time_request', { requested_minutes: 15, request_reason: 'Disposable acceptance', request_category_label: 'Test game' }, 'authenticated', peer.id);
  await rpc('decide_time_request', { target_request_id: peerRequest, requested_decision: 'approved' }, 'authenticated', target.id);
  const peerBeforeDeletion = await shop(peer);
  assert.equal((await successful(restored, { action: 'delete' })).deleted, true);
  assert.equal(await deps.getUser(target.id), null);
  const deletedUserResult = await admin.getUser(restored.session.access_token);
  assert.equal(deletedUserResult.data.user, null);
  const afterDeleteRefresh = await client(publicKey).refreshSession({ refresh_token: restored.session.refresh_token });
  assert(afterDeleteRefresh.error && !afterDeleteRefresh.data.session);
  deletionRejections = { getUser: { status: deletedUserResult.error?.status, code: deletedUserResult.error?.code },
    refresh: { status: afterDeleteRefresh.error.status, code: afterDeleteRefresh.error.code } };
  console.log(`Deletion rejection metadata: ${JSON.stringify(deletionRejections)}`);
  assert.equal(deletionRejections.getUser.status, 403); assert.equal(deletionRejections.getUser.code, 'user_not_found');
  assert.equal(deletionRejections.refresh.status, 400); assert.equal(deletionRejections.refresh.code, 'refresh_token_not_found');
  for (const [table, column] of [['profiles', 'id'], ['account_recovery_keys', 'user_id'], ['shared_app_limits', 'user_id'], ['feedback_reports', 'actor_id'], ['camp_group_members', 'user_id']]) {
    assert.equal(await sql(`select count(*) from public.${ident(table)} where ${ident(column)}=${literal(target.id)};`), '0');
  }
  const peerAfterDeletion = await shop(peer);
  assert.equal(peerAfterDeletion.id, peerBeforeDeletion.id); assert.equal(peerAfterDeletion.balance, peerBeforeDeletion.balance);
  assert.deepEqual(peerAfterDeletion.unlocked, peerBeforeDeletion.unlocked); assert(await deps.getUser(peer.id));
  assert.equal(await sql(`select count(*) from public.time_requests where id=${literal(peerRequest)} and status='approved' and decided_by is null;`), '1');
  assert.equal(await sql(`select count(*) from public.camp_group_days where group_id=${literal(originalShop.id)} and requested;`), '1');
  assert.equal(await sql(`select count(*) from public.account_access_attempts where bucket like ${literal(`actor:${target.id}:%`)};`), '0');
  passed('actual Auth deletion invalidates tokens/refresh, cascades personal rows, and preserves peer/shared wallet/unlocks');
  await writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ result: 'passed', authVersion, postgresVersion: await command(path.join(pgBin, 'postgres'), ['--version']), appMigrations: 24, checks: evidence, deletionRejections,
    limitations: ['Direct PostgreSQL RPC adapter, not hosted PostgREST/Edge gateway', 'No SMTP provider or device SecureStore', 'Disposable loopback-only users and credentials'] }, null, 2), { mode: 0o600 });
  console.log(`Evidence: ${path.join(directory, 'evidence.json')}`);
} catch (error) {
  // Error details can contain SQL/credentials. Keep them in the private directory only.
  await writeFile(path.join(directory, 'failure.txt'), `Stage: ${stage}\n${error.message}\n${error.details ?? ''}\n`, { mode: 0o600 });
  console.error(`FAIL at ${stage}. Private diagnostic: ${path.join(directory, 'failure.txt')}`);
  process.exitCode = 1;
} finally {
  if (authProcess && authProcess.exitCode === null) {
    const stopped = once(authProcess, 'exit'); authProcess.kill('SIGTERM');
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (authProcess.exitCode === null) authProcess.kill('SIGKILL');
  }
  if (postgresStarted) await command(path.join(pgBin, 'pg_ctl'), ['-D', cluster, '-m', 'fast', '-w', 'stop']);
  console.log('Disposable Auth and PostgreSQL stopped; no production endpoints used.');
}
