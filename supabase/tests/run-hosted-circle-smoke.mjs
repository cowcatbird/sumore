// Deliberate live smoke test. Run ONLY after Circle deployment is approved.
// Uses marked disposable anonymous accounts and their own groups/requests only.
// No admin credentials, push tokens, email, existing-user discovery, or group deletion.
// Empty test groups are left in the private receipt for a separately guarded cleanup.
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
  throw new Error('Requires --confirm-project REF --env-file PATH --create-disposable-accounts. Run only after deployment approval.');
}
const env = {};
for (const line of (await readFile(envFile, 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY)\s*=\s*(.*?)\s*$/);
  if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const url = env.EXPO_PUBLIC_SUPABASE_URL;
assert.equal(new URL(url).origin, `https://${project}.supabase.co`, 'Explicit project must match the public environment');
const publicKey = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
assert.ok(publicKey, 'A public project key is required');
const runId = randomUUID();
const startedAt = new Date().toISOString();
const receiptDirectory = await mkdtemp(path.join(tmpdir(), 'sumore-hosted-circle-'));
const receiptPath = path.join(receiptDirectory, 'disposable-accounts.json');
const accounts = [];
const disposableGroups = [];
const checks = [];
const skipped = [];
const cleanupFailures = [];
let receiptFailed = false;
let failure;
let step = 'disposable account setup';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const options = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }) },
};
const receipt = () => writeFile(receiptPath, JSON.stringify({ project, runId, startedAt,
  accounts: accounts.map(({ id, label, deleted }) => ({ id, label, deleted })),
  disposableGroups, checks, skipped, cleanupFailures, ...(failure ? { failure } : {}),
}, null, 2), { mode: 0o600 });
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
const own = value => assert.ok(accounts.includes(value) && uuid.test(value.id), 'Only an account created by this run may be used');
const rpc = async (value, name, params = {}) => {
  own(value);
  const { data, error } = await value.client.rpc(name, params);
  assert.ok(!error, 'Expected disposable-account RPC must succeed');
  return data;
};
async function rejected(value, name, params, pattern) {
  own(value);
  const result = await value.client.rpc(name, params);
  assert.ok(result.error && pattern.test(result.error.message), 'Guarded RPC must reject with its expected boundary error');
}
async function query(resultPromise) {
  const { data, error } = await resultPromise;
  assert.ok(!error, 'Run-scoped read must succeed');
  return data;
}
async function rememberGroup(id, account, reason) {
  own(account);
  assert.ok(uuid.test(id), 'Disposable group must have a valid ID');
  if (!disposableGroups.some(group => group.id === id)) {
    disposableGroups.push({ id, createdFor: account.id, reason });
    await receipt();
  }
}
async function snapshot(value) {
  const result = await rpc(value, 'get_app_snapshot_v5', { tz: 'UTC' });
  assert.equal(result?.profile?.id, value.id, 'Snapshot must belong to the exact disposable account');
  assert.ok(Array.isArray(result.friends) && result.friends.every(friend => accounts.some(account => account.id === friend.id)),
    'Snapshot must contain only this run’s disposable peers');
  assert.ok(Array.isArray(result.campfire?.seats) && result.campfire.seats.every(seat => accounts.some(account => account.id === seat.id)),
    'Campsite must contain only this run’s disposable peers');
  return result;
}
async function account(label) {
  const client = createClient(url, publicKey, options);
  const result = await client.auth.signInAnonymously({ options: { data: {
    display_name: `Circle QA ${label} ${runId.slice(0, 8)}`, sumore_circle_test: runId,
  } } });
  // Record a returned identity before further assertions so a later failure
  // still leaves an exact receipt and attempts owner-only cleanup.
  const value = { id: result.data.user?.id, label, client, session: result.data.session, deleted: false };
  if (value.id) { accounts.push(value); await receipt(); }
  assert.ok(!result.error && value.session && value.id, 'Disposable anonymous signup must succeed');
  assert.equal(result.data.user.user_metadata?.sumore_circle_test, runId, 'Disposable identity must carry this run’s marker');
  const current = await snapshot(value);
  assert.equal(current.friends.length, 0, 'A disposable account must start alone');
  assert.equal(current.campfire.seats.length, 1, 'A disposable account must have only its own seat');
  assert.ok(!disposableGroups.some(group => group.id === current.circleShop.id), 'Each fresh account must start in its own new group');
  await rememberGroup(current.circleShop.id, value, 'initial personal group');
  value.initialGroup = current.circleShop.id;
  value.profile = current.profile;
  assert.ok(typeof value.profile.friendCode === 'string' && value.profile.friendCode.length > 0, 'Disposable code must be available');
  const tokens = await query(value.client.from('device_push_tokens').select('id').eq('user_id', value.id));
  assert.equal(tokens.length, 0, 'Disposable account must have no push destinations');
  return value;
}
async function join(value, peer, version = 'join_shared_circle_v5') {
  own(value); own(peer);
  assert.ok(['join_shared_circle', 'join_shared_circle_v4', 'join_shared_circle_v5'].includes(version), 'Use only supported join APIs');
  // The only input code comes from a marked account created in this process.
  return rpc(value, version, { friend_code_input: peer.profile.friendCode });
}
const identity = profile => ({ id: profile.id, displayName: profile.displayName, friendCode: profile.friendCode });
const wallet = shop => ({ id: shop.id, balance: shop.balance, unlocked: [...shop.unlocked].sort(), background: shop.background });
const grantIdentity = grant => ({ grantId: grant?.grantId, requesterId: grant?.requesterId,
  requestId: grant?.requestId, startedAt: grant?.startedAt, expiresAt: grant?.expiresAt });
const blocked = value => rpc(value, 'get_blocked_people', { expected_user_id: value.id });
const request = value => rpc(value, 'create_time_request', {
  requested_minutes: 15, request_reason: 'Disposable Circle verification', request_category_label: 'Selected apps',
});
function solo(result, formerGroup) {
  assert.equal(result.leftCircle, true, 'Membership change must report a real departure');
  assert.notEqual(result.circleShop.id, formerGroup, 'Departure must create a separate personal group');
  assert.equal(result.circleShop.balance, 0, 'Departure must never mint starter currency');
  assert.deepEqual(result.circleShop.unlocked, [], 'Old group purchases must stay behind');
  assert.equal(result.circleShop.eligibleToday, false, 'A partial membership day must not earn a reward');
}
async function preservedPeerWallet(peer, expected) {
  const current = await snapshot(peer);
  assert.deepEqual(wallet(current.circleShop), expected, 'Peer wallet, purchases and background must remain unchanged');
  return current;
}
async function preservedGrant(value, expected) {
  const active = await rpc(value, 'get_active_screen_time_grant');
  assert.deepEqual(grantIdentity(active), grantIdentity(expected), 'An approved grant and its fixed deadline must survive circle changes');
}

try {
  await receipt();
  const a = await account('A'); const b = await account('B'); const c = await account('C');
  await join(a, b); await join(c, b);
  const together = await snapshot(b);
  assert.equal(together.circleShop.id, b.initialGroup, 'Joins must target the run-created peer group');
  assert.deepEqual(together.friends.map(friend => friend.id).sort(), [a.id, c.id].sort(), 'Only this run’s peers may be joined');
  pass('isolated disposable accounts join only their own marked circle without push destinations');

  step = 'expected owner and group guards';
  await rejected(a, 'get_blocked_people', { expected_user_id: b.id }, /account changed/i);
  await rejected(a, 'leave_shared_circle', { expected_group_id: b.initialGroup, expected_user_id: b.id }, /account changed/i);
  await rejected(a, 'leave_shared_circle', { expected_group_id: c.initialGroup, expected_user_id: a.id }, /circle changed/i);
  await rejected(a, 'block_circle_person', { target_user_id: b.id, expected_group_id: b.initialGroup, expected_user_id: b.id }, /account changed/i);
  assert.deepEqual(await blocked(a), [], 'Rejected mutations must not create a block');
  assert.equal((await snapshot(a)).circleShop.id, b.initialGroup, 'Rejected mutations must not change membership');
  pass('stale-owner and stale-group mutations fail closed without changing membership');

  step = 'disposable wallet and approved grant fixtures';
  if (together.circleShop.balance >= 10) {
    const purchased = await rpc(b, 'purchase_circle_item_v5', { target_group_id: b.initialGroup, item_id: 'hat:crown', expected_cost: 10 });
    assert.equal(purchased.balance, together.circleShop.balance - 10, 'Disposable purchase must charge its actual price');
    assert.ok(purchased.unlocked.includes('hat:crown'), 'Disposable purchase must unlock the selected item');
    pass('disposable shared purchase is created at the server price');
  } else {
    // Do not grant currency or alter project defaults just to make a fixture.
    skipped.push('paid purchase fixture: disposable starting wallet is below the item price');
  }
  const peerWallet = wallet((await snapshot(b)).circleShop);
  const approvedRequest = await request(a);
  await rpc(b, 'decide_time_request', { target_request_id: approvedRequest, requested_decision: 'approved' });
  const approvedGrant = await rpc(a, 'claim_screen_time_grant', { target_request_id: approvedRequest });
  assert.equal(approvedGrant.requesterId, a.id, 'Grant must belong to the disposable requester');
  assert.equal(approvedGrant.requestId, approvedRequest, 'Grant must match the approved request');
  assert.ok(uuid.test(approvedGrant.grantId), 'Grant must have a server identity');
  assert.equal(Date.parse(approvedGrant.expiresAt) - Date.parse(approvedGrant.startedAt), 15 * 60_000, 'Grant must retain a fixed fifteen-minute deadline');
  const outgoing = await request(a);
  const incoming = await request(b);
  pass('disposable requests and a fixed approved grant are created without registering notifications');

  step = 'leave and crossed request cleanup';
  const left = await rpc(a, 'leave_shared_circle', { expected_group_id: b.initialGroup, expected_user_id: a.id });
  // Record the group before checking its payload, including on a failed check.
  await rememberGroup(left.circleShop.id, a, 'leave personal group');
  solo(left, b.initialGroup);
  const alone = await snapshot(a);
  assert.deepEqual(identity(alone.profile), identity(a.profile), 'Leaving must retain account identity and friend code');
  assert.equal(alone.friends.length, 0, 'Leaving must remove old peers from the personal roster');
  const remaining = await preservedPeerWallet(b, peerWallet);
  assert.deepEqual(remaining.friends.map(friend => friend.id), [c.id], 'Leaving must not eject the other peers');
  const cancelled = await query(a.client.from('time_requests').select('id,status').eq('id', outgoing).eq('requester_id', a.id));
  assert.deepEqual(cancelled, [{ id: outgoing, status: 'cancelled' }], 'Departed pending outgoing request must be cancelled');
  const peerRequest = await query(b.client.from('time_requests').select('id,status').eq('id', incoming).eq('requester_id', b.id));
  assert.deepEqual(peerRequest, [{ id: incoming, status: 'pending' }], 'A remaining peer must retain an answerable incoming request');
  const recipients = await query(b.client.from('request_recipients').select('recipient_id').eq('request_id', incoming));
  assert.deepEqual(recipients, [{ recipient_id: c.id }], 'Only the departed request recipient must be removed');
  await rejected(a, 'decide_time_request', { target_request_id: incoming, requested_decision: 'approved' }, /no longer available/i);
  await preservedGrant(a, approvedGrant);
  const repeated = await rpc(a, 'leave_shared_circle', { expected_group_id: left.circleShop.id, expected_user_id: a.id });
  assert.equal(repeated.leftCircle, false, 'Repeated solo leave must be a no-op');
  assert.deepEqual(wallet(repeated.circleShop), wallet(left.circleShop), 'Repeated solo leave must not refill or replace the wallet');
  await rejected(a, 'leave_shared_circle', { expected_group_id: b.initialGroup, expected_user_id: a.id }, /circle changed/i);
  pass('leave preserves peers, shared purchases, account and active grant while pruning crossed pending requests');

  step = 'block privacy and all supported join boundaries';
  await join(a, b);
  const result = await rpc(a, 'block_circle_person', { target_user_id: b.id, expected_group_id: b.initialGroup, expected_user_id: a.id });
  await rememberGroup(result.circleShop.id, a, 'block personal group');
  solo(result, b.initialGroup);
  assert.equal(result.blockedUserId, b.id, 'Block must target the exact disposable peer');
  const list = await blocked(a);
  assert.equal(list.length, 1, 'Only the selected peer must be blocked');
  assert.equal(list[0].id, b.id, 'Private list must identify the selected disposable peer');
  assert.equal(list[0].displayName, b.profile.displayName, 'Private list must preserve the selected peer label');
  assert.ok(Number.isFinite(Date.parse(list[0].blockedAt)), 'Private block must have a server timestamp');
  assert.deepEqual(await blocked(b), [], 'The target must not see the blocker’s private list');
  await rejected(b, 'get_blocked_people', { expected_user_id: a.id }, /account changed/i);
  const ownRows = await query(a.client.from('circle_blocks').select('owner_id,target_id').eq('owner_id', a.id).eq('target_id', b.id));
  assert.deepEqual(ownRows, [{ owner_id: a.id, target_id: b.id }], 'Owner may read only their exact block');
  const hiddenRows = await query(b.client.from('circle_blocks').select('owner_id,target_id').eq('owner_id', a.id).eq('target_id', b.id));
  assert.deepEqual(hiddenRows, [], 'Table RLS must hide the blocker’s row from its target');
  const hiddenProfile = await query(a.client.from('profiles').select('id').eq('id', b.id));
  assert.deepEqual(hiddenProfile, [], 'The blocked peer profile must not leak through a direct read');
  for (const version of ['join_shared_circle', 'join_shared_circle_v4', 'join_shared_circle_v5']) {
    for (const [actor, peer] of [[a, b], [a, c], [b, a]]) {
      await rejected(actor, version, { friend_code_input: peer.profile.friendCode }, /circle is unavailable/i);
    }
  }
  assert.equal((await snapshot(a)).circleShop.id, result.circleShop.id, 'Rejected joins must leave the blocker in the same personal circle');
  await preservedPeerWallet(b, peerWallet);
  await preservedGrant(a, approvedGrant);
  pass('block stays private and prevents direct, reverse and third-peer rejoining across supported clients');

  step = 'unblock without implicit rejoin';
  const unblocked = await rpc(a, 'unblock_circle_person', { target_user_id: b.id, expected_user_id: a.id });
  assert.equal(unblocked.unblockedUserId, b.id, 'Unblock must identify the selected disposable peer');
  assert.deepEqual(await blocked(a), [], 'Owner’s block list must be empty after unblock');
  const unjoined = await snapshot(a);
  assert.equal(unjoined.circleShop.id, result.circleShop.id, 'Unblock must not silently join a circle');
  assert.equal(unjoined.friends.length, 0, 'Unblock alone must not restore old peer relationships');
  assert.deepEqual(wallet(unjoined.circleShop), wallet(result.circleShop), 'Unblock must not import old purchases or balance');
  await join(a, b);
  const rejoined = await preservedPeerWallet(b, peerWallet);
  assert.deepEqual(rejoined.friends.map(friend => friend.id).sort(), [a.id, c.id].sort(), 'Explicit rejoin may restore the original circle');
  await preservedGrant(a, approvedGrant);
  pass('unblock never rejoins automatically and explicit rejoin preserves the existing wallet and grant');
} catch {
  // Never print SDK errors, response bodies, tokens, friend codes or assertion values.
  failure = `Hosted Circle check failed during ${step}`;
} finally {
  // Delete requester A first: its approved request references decider B.
  // Deleting B first could hit the retained request’s non-null decision invariant.
  for (const value of accounts) {
    try {
      own(value);
      assert.ok(value.session?.access_token, 'Cleanup requires the exact disposable owner session');
      const verified = await value.client.auth.getUser(value.session.access_token);
      assert.ok(!verified.error && verified.data.user?.id === value.id, 'Cleanup must authenticate the exact run-created account');
      assert.equal(verified.data.user.user_metadata?.sumore_circle_test, runId, 'Cleanup requires the original run marker');
      const response = await fetch(`${url}/functions/v1/account-access`, {
        method: 'POST', signal: AbortSignal.timeout(25_000),
        headers: { apikey: publicKey, 'Content-Type': 'application/json', Authorization: `Bearer ${value.session.access_token}` },
        body: JSON.stringify({ action: 'delete' }),
      });
      const data = await response.json();
      assert.equal(response.status, 200, 'Owner-only deletion must be acknowledged');
      assert.equal(data?.deleted, true, 'Disposable account cleanup must succeed');
      const removed = await value.client.auth.getUser(value.session.access_token);
      assert.equal(removed.error?.status, 403, 'Deleted owner must receive an explicit Auth rejection');
      assert.equal(removed.error?.code, 'user_not_found', 'Deleted account must no longer exist');
      assert.equal(removed.data.user, null, 'Deleted owner must not retain an authenticated identity');
      const refreshed = await value.client.auth.refreshSession({ refresh_token: value.session.refresh_token });
      assert.equal(refreshed.error?.status, 400, 'Deleted refresh must be explicitly rejected');
      assert.equal(refreshed.error?.code, 'refresh_token_not_found', 'Deleted refresh token must be revoked');
      assert.equal(refreshed.data.session, null, 'Deleted session must not refresh');
      value.deleted = true;
    } catch { cleanupFailures.push(value.id); }
    // A receipt filesystem error must never stop cleanup of the next account.
    try { await receipt(); } catch { receiptFailed = true; }
  }
  if (cleanupFailures.length) failure ??= 'Disposable account cleanup requires attention';
  if (receiptFailed) failure ??= 'Disposable receipt could not be updated';
  try { await receipt(); } catch { failure ??= 'Disposable receipt could not be updated'; }
  console.log(JSON.stringify({ passed: !failure, checks: checks.length, skipped: skipped.length,
    created: accounts.length, deleted: accounts.filter(value => value.deleted).length,
    cleanupFailures: cleanupFailures.length, receiptPath, ...(failure ? { failure } : {}) }));
  if (failure) process.exitCode = 1;
}
