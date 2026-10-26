// Deliberate live smoke test: creates only its own marked disposable accounts.
// Never reads existing users, prints credentials, or changes another account.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/mobile/package.json'));
const { createClient } = require('@supabase/supabase-js');
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const project = option('--confirm-project');
const envFile = option('--env-file');
if (!project || !envFile || !args.includes('--create-disposable-accounts')) {
  throw new Error('Requires --confirm-project REF --env-file PATH --create-disposable-accounts. Optional --send-feedback sends one setup email to the configured support inbox.');
}
const env = {};
for (const line of (await readFile(envFile, 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY)\s*=\s*(.*?)\s*$/);
  if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const url = env.EXPO_PUBLIC_SUPABASE_URL;
assert.equal(new URL(url).origin, `https://${project}.supabase.co`, 'Explicit project must match the public environment');
const publicKey = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert.ok(publicKey);
const runId = randomUUID();
const receiptDirectory = await mkdtemp(path.join(tmpdir(), 'sumore-hosted-setup-'));
const receiptPath = path.join(receiptDirectory, 'disposable-accounts.json');
const accounts = [];
const disposableGroups = [];
const checks = [];
const cleanupFailures = [];
const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }) } };
const freshClient = () => createClient(url, publicKey, options);
const receipt = () => writeFile(receiptPath, JSON.stringify({ project, runId,
  accounts: accounts.map(({ id, deleted }) => ({ id, deleted })), disposableGroups, checks, cleanupFailures }, null, 2), { mode: 0o600 });
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
async function invoke(token, body, endpoint = 'account-access', extraHeaders = {}) {
  const response = await fetch(`${url}/functions/v1/${endpoint}`, {
    method: 'POST', signal: AbortSignal.timeout(25_000),
    headers: { apikey: publicKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}
async function account(label) {
  const client = freshClient();
  const result = await client.auth.signInAnonymously({ options: { data: {
    display_name: `Setup QA ${label}`, sumore_setup_test: runId,
  } } });
  assert.ok(!result.error && result.data.session, 'Disposable signup must succeed');
  const value = { id: result.data.user.id, client, session: result.data.session, deleted: false };
  accounts.push(value);
  await receipt();
  return value;
}
async function rpc(client, name, params) {
  const result = await client.rpc(name, params);
  assert.ok(!result.error, `${name} must succeed`);
  return result.data;
}
async function keyFor(value) {
  const result = await invoke(value.session.access_token, { action: 'create' });
  assert.equal(result.status, 200, 'Key creation must succeed');
  assert.match(result.data.key, /^SUMORE(?:-[0-9A-F]{6}){8}$/);
  return result.data.key;
}
let failure;
try {
  assert.equal((await invoke(null, { action: 'status' })).status, 401);
  assert.equal((await invoke('not-a-valid-bearer', { action: 'status' })).status, 401);
  pass('hosted function rejects missing and invalid authentication');
  const target = await account('Target');
  const before = await rpc(target.client, 'get_app_snapshot_v5', { tz: 'UTC' });
  assert.equal(before.profile.id, target.id);
  assert.equal(before.friends.length, 0, 'Disposable account must not belong to an existing circle');
  disposableGroups.push(before.circleShop.id);
  await receipt();
  const key = await keyFor(target);
  const identity = await target.client.auth.getUser(target.session.access_token);
  assert.ok(!identity.error && identity.data.user?.id === target.id);
  assert.match(identity.data.user.email, /^[0-9a-f]{64}@accounts\.sumore\.invalid$/);
  pass('same account UUID retained during real anonymous identity upgrade');
  const status = await invoke(target.session.access_token, { action: 'status', key });
  assert.equal(status.data?.matches, true);
  const after = await rpc(target.client, 'get_app_snapshot_v5', { tz: 'UTC' });
  assert.equal(after.circleShop.id, before.circleShop.id);
  assert.equal(after.circleShop.balance, before.circleShop.balance);
  const selected = await rpc(target.client, 'update_my_character', {
    target_profile_id: target.id, new_hat: 'lollipop', new_body: 'short', new_color: 'cream',
    expected_revision: after.profile.character.revision,
  });
  assert.equal(selected.appearance.hat, 'lollipop');
  const legacy = await rpc(target.client, 'get_app_snapshot_v4', { tz: 'UTC' });
  assert.equal(legacy.profile.character.appearance.hat, 'none');
  assert.equal((await rpc(target.client, 'get_app_snapshot_v5', { tz: 'UTC' })).profile.character.appearance.hat, 'lollipop');
  pass('v5 catalog accepts new art while v4 remains compatible');
  await rpc(target.client, 'set_shared_app_limits', {
    entries: [{ label: 'Setup test', minutes: 15 }], allocation_minutes: 15, expected_user_id: target.id,
  });
  const shared = await rpc(target.client, 'get_circle_app_limits');
  assert.equal(shared[0]?.totalDailyMinutes, 15);
  pass('optional shared allocation works on disposable account');

  const source = await account('Source');
  const oldKey = await keyFor(source);
  assert.equal((await invoke(source.session.access_token, { action: 'recover', key: 'NOT-A-LOGIN-KEY' })).status, 400);
  const restored = await invoke(source.session.access_token, { action: 'recover', key });
  assert.equal(restored.status, 200, 'Hosted recovery must succeed');
  assert.equal(restored.data.userId, target.id);
  const recoveredClient = freshClient();
  const installed = await recoveredClient.auth.setSession({ access_token: restored.data.accessToken, refresh_token: restored.data.refreshToken });
  assert.ok(!installed.error && installed.data.user?.id === target.id, 'Recovered session must authenticate exact target');
  const refreshed = await recoveredClient.auth.refreshSession();
  assert.ok(!refreshed.error && refreshed.data.user?.id === target.id && refreshed.data.session, 'Recovered session must refresh');
  target.client = recoveredClient;
  target.session = refreshed.data.session;
  const finished = await invoke(target.session.access_token, { action: 'finish', ticket: restored.data.cleanupTicket });
  assert.equal(finished.data?.previousKeyRevoked, true);
  assert.equal((await invoke(source.session.access_token, { action: 'status', key: oldKey })).data?.hasKey, false);
  assert.equal((await invoke(source.session.access_token, { action: 'recover', key: oldKey })).status, 400);
  assert.equal((await rpc(target.client, 'get_app_snapshot_v5', { tz: 'UTC' })).profile.character.appearance.hat, 'lollipop');
  pass('real recovery, refresh, progress retention and old-key retirement');

  if (args.includes('--send-feedback')) {
    const report = { id: randomUUID(), message: `Automatic setup verification for sumore. This is a disposable test report, not a user problem. Run ${runId}.`, platform: 'web', appVersion: '1.2.0-setup-check' };
    const sent = await invoke(target.session.access_token, report, 'report-problem');
    assert.equal(sent.status, 200, 'Feedback provider must accept setup report');
    assert.equal(sent.data?.sent, true);
    const retry = await invoke(target.session.access_token, report, 'report-problem');
    assert.equal(retry.status, 200, 'Duplicate feedback retry must be acknowledged');
    assert.equal(retry.data?.sent, true);
    assert.equal(retry.data?.reportId, report.id);
    pass('support report accepted and duplicate retry acknowledged');
  }
} catch (error) {
  // Assertion messages are static; never print SDK responses or secret values.
  failure = error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Hosted setup check failed';
} finally {
  for (const value of accounts.reverse()) {
    try {
      const verified = await value.client.auth.getUser(value.session.access_token);
      assert.equal(verified.data.user?.id, value.id, 'Cleanup may target only an account created by this run');
      assert.equal(verified.data.user.user_metadata.sumore_setup_test, runId, 'Cleanup must retain exact test marker');
      const result = await invoke(value.session.access_token, { action: 'delete' });
      assert.equal(result.status, 200, 'Disposable deletion must be acknowledged');
      assert.equal(result.data?.deleted, true, 'Disposable account cleanup must succeed');
      const removed = await value.client.auth.getUser(value.session.access_token);
      assert.equal(removed.error?.status, 403, 'Deletion must produce an explicit Auth rejection');
      assert.equal(removed.error?.code, 'user_not_found', 'Deleted account must no longer exist in Auth');
      assert.equal(removed.data.user, null);
      const refresh = await value.client.auth.refreshSession({ refresh_token: value.session.refresh_token });
      assert.equal(refresh.error?.status, 400, 'Deleted session must be explicitly rejected');
      assert.equal(refresh.error?.code, 'refresh_token_not_found', 'Deleted account refresh token must not exist');
      assert.equal(refresh.data.session, null);
      value.deleted = true;
    } catch { cleanupFailures.push(value.id); }
    await receipt();
  }
  if (cleanupFailures.length) failure ??= 'Disposable account cleanup requires attention';
  await receipt();
  console.log(JSON.stringify({ passed: !failure, checks: checks.length, created: accounts.length,
    deleted: accounts.filter(value => value.deleted).length, cleanupFailures: cleanupFailures.length,
    receiptPath, ...(failure ? { failure } : {}) }));
  if (failure) process.exitCode = 1;
}
