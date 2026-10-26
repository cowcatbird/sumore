import { describe, expect, it, vi } from 'vitest';
import { createAccountAccessHandler, createLoginKey, hashSecret, normalizeLoginKey, type AccessDependencies, type AccessUser } from '../../../../supabase/functions/account-access/core';

// Pure edge tests: no SDK, network, admin credentials, or real accounts.
const owner = { id: 'owner', is_anonymous: true };
const target = { id: 'target', email: 'target@accounts.sumore.invalid' };
const key = `SUMORE-${Array(8).fill('ABCDEF').join('-')}`;
const input = (body: unknown, token = 'fixture-bearer') => new Request('https://fixture.invalid', {
  method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body),
});
function fixture(actor: AccessUser = owner) {
  const rpc = vi.fn(async (name: string): Promise<unknown> => {
    if (name === 'account_access_allow') return true;
    if (name === 'account_lookup_key') return { userId: target.id, email: target.email };
    if (name === 'account_key_status') return { hasKey: true, matches: true };
    if (name === 'account_prepare_transfer' || name === 'account_finish_transfer') return true;
    return null;
  });
  const deps = {
    authenticate: vi.fn(async () => actor as AccessUser | null), rpc,
    getUser: vi.fn(async (id: string) => (id === actor.id ? actor : target) as AccessUser | null),
    attachRecoveryIdentity: vi.fn(async (user: AccessUser, email: string) => ({ ...user, email })),
    createSession: vi.fn(async () => ({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', user: { id: target.id } })),
    deleteAccount: vi.fn(async () => undefined), ipHash: vi.fn(async () => '0'.repeat(64)),
  } satisfies AccessDependencies;
  return { deps, handler: createAccountAccessHandler(deps) };
}

describe('private recovery edge boundary', () => {
  it('generates 192-bit keys, canonicalizes case and never accepts a friend code', async () => {
    const keys = Array.from({ length: 80 }, createLoginKey);
    expect(new Set(keys).size).toBe(80);
    for (const value of keys) expect(value).toMatch(/^SUMORE(?:-[0-9A-F]{6}){8}$/);
    expect(normalizeLoginKey(key.toLowerCase().replaceAll('-', ' '))).toBe(key);
    expect(normalizeLoginKey('A5B3C7D2')).toBeNull();
    expect(normalizeLoginKey('x'.repeat(161))).toBeNull();
    expect(await hashSecret(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashSecret(key)).not.toContain(key);
  });
  it.each(['status', 'create', 'recover', 'revoke', 'finish', 'delete'])('authenticates %s before any operation', async action => {
    const { deps, handler } = fixture();
    expect((await handler(input({ action }, ''))).status).toBe(401);
    deps.authenticate.mockResolvedValue(null);
    expect((await handler(input({ action }, 'forged'))).status).toBe(401);
    expect(deps.rpc).not.toHaveBeenCalled();
    expect(deps.deleteAccount).not.toHaveBeenCalled();
  });
  it('limits malformed recovery attempts before parsing the key', async () => {
    const { deps, handler } = fixture();
    deps.rpc.mockResolvedValue(false);
    expect((await handler(input({ action: 'recover', key: 'friendcode' }))).status).toBe(429);
    expect(deps.rpc).toHaveBeenCalledExactlyOnceWith('account_access_allow', { actor_id: owner.id, ip_hash: '0'.repeat(64), operation: 'recover' });
    expect(deps.createSession).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON and bodies over 2048 bytes without retaining them', async () => {
    const { deps, handler } = fixture();
    const large = await handler(input({ action: 'recover', key: '🌙'.repeat(1024) }));
    expect(large.status).toBe(400);
    expect(deps.rpc).not.toHaveBeenCalled();
    expect((await handler(new Request('https://fixture.invalid', { method: 'POST', headers: { Authorization: 'Bearer x' }, body: '{bad' }))).status).toBe(400);
  });
  it('stores only a hash and links an anonymous identity to the same UUID', async () => {
    const { deps, handler } = fixture();
    const response = await handler(input({ action: 'create', userId: 'attacker-selected' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({ key: expect.stringMatching(/^SUMORE(?:-[0-9A-F]{6}){8}$/) });
    const email = deps.attachRecoveryIdentity.mock.calls[0][1];
    expect(email).toMatch(/^[0-9a-f-]+@accounts\.sumore\.invalid$/);
    expect(deps.attachRecoveryIdentity.mock.calls[0][0].id).toBe(owner.id);
    expect(deps.rpc).toHaveBeenLastCalledWith('account_store_key', { actor_id: owner.id, new_hash: await hashSecret(body.key), identity_email: email });
  });
  it('never overwrites a real email identity', async () => {
    const { deps, handler } = fixture({ id: 'real', email: 'existing@example.invalid' });
    expect((await handler(input({ action: 'create' }))).status).toBe(200);
    expect(deps.attachRecoveryIdentity).not.toHaveBeenCalled();
    expect(deps.rpc).toHaveBeenLastCalledWith('account_store_key', expect.objectContaining({ actor_id: 'real', identity_email: 'existing@example.invalid' }));
  });
  it('preserves a real identity linked after bearer verification', async () => {
    const { deps, handler } = fixture();
    deps.getUser.mockResolvedValue({ ...owner, email: 'newly-linked@example.invalid' });
    expect((await handler(input({ action: 'create' }))).status).toBe(200);
    expect(deps.attachRecoveryIdentity).not.toHaveBeenCalled();
    expect(deps.rpc).toHaveBeenLastCalledWith('account_store_key', expect.objectContaining({ identity_email: 'newly-linked@example.invalid' }));
  });
  it('keeps final key recoverable when concurrent first creates store out of order', async () => {
    const { deps, handler } = fixture();
    let authEmail: string | undefined;
    let stored: { new_hash: string; identity_email: string } | undefined;
    let stores = 0;
    const firstStoreStarted = Promise.withResolvers<void>();
    const letFirstStoreFinish = Promise.withResolvers<void>();
    // Both first requests can see no identity before either attaches one.
    deps.getUser.mockResolvedValue(owner);
    deps.attachRecoveryIdentity.mockImplementation(async (user, email) => { authEmail = email; return { ...user, email }; });
    deps.rpc.mockImplementation(async (name, ...rest: unknown[]) => {
      if (name !== 'account_store_key') return true;
      stores += 1;
      if (stores === 1) { firstStoreStarted.resolve(); await letFirstStoreFinish.promise; }
      stored = rest[0] as typeof stored;
      return null;
    });
    const first = handler(input({ action: 'create' }));
    await firstStoreStarted.promise;
    const second = await handler(input({ action: 'create' }));
    expect(second.status).toBe(200);
    letFirstStoreFinish.resolve();
    const last = await first;
    expect(last.status).toBe(200);
    const returned = await last.json();
    expect(stored).toEqual(expect.objectContaining({ identity_email: authEmail, new_hash: await hashSecret(returned.key) }));
    expect(deps.attachRecoveryIdentity.mock.calls[0][1]).toBe(deps.attachRecoveryIdentity.mock.calls[1][1]);
  });
  it('does not introduce a recovery bypass for accounts with verified MFA', async () => {
    const { deps, handler } = fixture({ ...owner, factors: [{ status: 'verified' }] });
    expect((await handler(input({ action: 'create' }))).status).toBe(409);
    expect(deps.attachRecoveryIdentity).not.toHaveBeenCalled();
    expect(deps.rpc.mock.calls.map(call => call[0])).toEqual(['account_access_allow']);
  });
  it('rejects an identity setup that changes the account UUID', async () => {
    const { deps, handler } = fixture();
    deps.attachRecoveryIdentity.mockImplementation(async (_, email) => ({ id: 'different', email }));
    expect((await handler(input({ action: 'create' }))).status).toBe(503);
    expect(deps.rpc.mock.calls.map(call => call[0])).toEqual(['account_access_allow']);
  });
  it.each(['syntax', 'missing', 'identity', 'mfa', 'transport', 'revoked'])('returns identical failure for %s without credentials', async failure => {
    const { deps, handler } = fixture();
    if (failure === 'missing') deps.rpc.mockImplementation(async name => name === 'account_access_allow' ? true : null);
    if (failure === 'identity') deps.getUser.mockResolvedValue({ ...target, email: 'changed@example.invalid' });
    if (failure === 'mfa') deps.getUser.mockResolvedValue({ ...target, factors: [{ status: 'verified' }] });
    if (failure === 'transport') deps.createSession.mockRejectedValue(new Error('secret SDK payload'));
    if (failure === 'revoked') deps.rpc.mockImplementation(async name => name === 'account_key_status' ? { matches: false } : name === 'account_lookup_key' ? { userId: target.id, email: target.email } : true);
    const response = await handler(input({ action: 'recover', key: failure === 'syntax' ? 'FRIENDCODE' : key }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'That login key could not be used. Check it and try again.' });
  });
  it('prepares conditional source cleanup before Auth exchange, but does not revoke a key itself', async () => {
    const { deps, handler } = fixture();
    deps.createSession.mockImplementation(async () => {
      expect(deps.rpc).toHaveBeenLastCalledWith('account_prepare_transfer', expect.objectContaining({ actor_id: owner.id, target_id: target.id }));
      return { access_token: 'fixture-access', refresh_token: 'fixture-refresh', user: { id: target.id } };
    });
    const response = await handler(input({ action: 'recover', key }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: target.id, accessToken: 'fixture-access', refreshToken: 'fixture-refresh', cleanupTicket: expect.stringMatching(/^SUMORE-/) });
    expect(deps.rpc.mock.calls.map(call => call[0])).not.toContain('account_revoke_key');
    expect(deps.rpc.mock.calls.map(call => call[0])).not.toContain('account_finish_transfer');
    expect(deps.deleteAccount).not.toHaveBeenCalled();
  });
  it('never releases an Auth session for a different UUID', async () => {
    const { deps, handler } = fixture();
    deps.createSession.mockResolvedValue({ access_token: 'wrong-token', refresh_token: 'wrong-refresh', user: { id: 'wrong' } });
    const response = await handler(input({ action: 'recover', key }));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toMatch(/wrong-token|wrong-refresh/);
  });
  it('pins finishing to the authenticated recovered account, not payload user IDs', async () => {
    const { deps, handler } = fixture(target);
    expect((await handler(input({ action: 'finish', ticket: key, userId: owner.id }))).status).toBe(200);
    expect(deps.rpc).toHaveBeenLastCalledWith('account_finish_transfer', { actor_id: target.id, candidate_ticket_hash: await hashSecret(key) });
  });
  it('deletes only the bearer owner via the scoped SQL RPC, never client target IDs', async () => {
    const { deps, handler } = fixture();
    expect(await (await handler(input({ action: 'delete', userId: target.id }))).json()).toEqual({ deleted: true });
    expect(deps.deleteAccount).toHaveBeenCalledExactlyOnceWith('fixture-bearer');
    expect(deps.createSession).not.toHaveBeenCalled();
  });
});
