import { describe, expect, it, vi } from 'vitest';

import type { ScreenTimeGrant } from '@/domain/screen-time-grants';
import type { RecentDecision, ScreenTimeStatus } from '@/types/domain';

import { createScreenTimeGrantSync } from './screen-time-grant-sync';

const clock = Date.parse('2026-09-14T12:00:00.000Z');
const receipt: ScreenTimeGrant = {
  grantId: 'grant-a', requesterId: 'user-a', requestId: 'request-a', source: 'request',
  startedAt: '2026-09-14T12:00:00.000Z', expiresAt: '2026-09-14T12:15:00.000Z', serverNow: '2026-09-14T12:00:00.000Z',
};
const approved: RecentDecision = { id: 'request-a', status: 'approved', minutes: 15, decidedAt: '2026-09-14T11:59:00.000Z' };
const ready: ScreenTimeStatus = {
  available: true, authorized: true, blockingEnabled: true, shielded: true,
  temporaryAccessExpiresAt: null, appliedGrantId: null, authorizationStatus: 'approved',
  selection: { applications: 1, categories: 0, webDomains: 0 }, message: 'Ready',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  let status = { ...ready };
  let active: ScreenTimeGrant | null = null;
  let now = clock;
  const configureAccount = vi.fn(async (_userId: string | null) => status);
  const getStatus = vi.fn(async () => status);
  const applyGrant = vi.fn(async (grant: ScreenTimeGrant) => {
    status = { ...status, temporaryAccessExpiresAt: grant.expiresAt, appliedGrantId: grant.grantId,
      appliedRequestId: grant.requestId, shielded: false };
    return status;
  });
  const claimGrant = vi.fn(async (_requestId: string): Promise<ScreenTimeGrant | null> => {
    active = receipt;
    return receipt;
  });
  const getActiveGrant = vi.fn(async () => active);
  const onError = vi.fn();
  const sync = createScreenTimeGrantSync({ configureAccount, getStatus, applyGrant, claimGrant, getActiveGrant, onError, now: () => now });
  return {
    sync, configureAccount, getStatus, applyGrant, claimGrant, getActiveGrant, onError,
    setStatus: (next: Partial<ScreenTimeStatus>) => { status = { ...status, ...next }; },
    setActive: (next: ScreenTimeGrant | null) => { active = next; },
    setNow: (next: number) => { now = next; },
  };
}

describe('session-bound Screen Time grant reconciliation', () => {
  it('configures once per owner, including explicit signed-out cleanup', async () => {
    const h = harness();
    await h.sync.setUser(null);
    await h.sync.setUser('user-a');
    await h.sync.setUser('user-a');
    await h.sync.sync(null);
    await h.sync.sync(null);
    await h.sync.setUser(null);
    expect(h.configureAccount.mock.calls.map(([user]) => user)).toEqual([null, 'user-a', null]);
  });

  it('invalidates lifecycle work without configuring or clearing the native account', async () => {
    const h = harness();
    await h.sync.setUser('user-a');
    h.sync.invalidate();
    h.sync.invalidate();
    await h.sync.sync(approved);
    expect(h.configureAccount).toHaveBeenCalledExactlyOnceWith('user-a');
    expect(h.getActiveGrant).not.toHaveBeenCalled();
    expect(h.applyGrant).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('preserves native blocking, selection and the active deadline across a same-account lifecycle replay', async () => {
    const h = harness();
    let persistedOwner: string | null = 'user-a';
    h.configureAccount.mockImplementation(async nextOwner => {
      // Mirror the native engine: only an owner change clears the saved setup.
      if (nextOwner !== persistedOwner) {
        h.setStatus({ blockingEnabled: false, shielded: false, temporaryAccessExpiresAt: null,
          appliedGrantId: null, selection: { applications: 0, categories: 0, webDomains: 0 } });
      }
      persistedOwner = nextOwner;
      return h.getStatus();
    });
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    h.sync.invalidate();
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.configureAccount.mock.calls.map(([user]) => user)).toEqual(['user-a', 'user-a']);
    expect(await h.getStatus()).toMatchObject({
      blockingEnabled: true, selection: { applications: 1, categories: 0, webDomains: 0 },
      temporaryAccessExpiresAt: receipt.expiresAt, appliedGrantId: receipt.grantId,
    });
    expect(h.applyGrant).toHaveBeenCalledTimes(1);
    expect(h.claimGrant).toHaveBeenCalledTimes(1);
  });

  it('does not apply a pending claim after lifecycle invalidation, even when the same user rebinds', async () => {
    const h = harness();
    const pending = deferred<ScreenTimeGrant | null>();
    h.claimGrant.mockReturnValueOnce(pending.promise);
    await h.sync.setUser('user-a');
    const stale = h.sync.sync(approved);
    await vi.waitFor(() => expect(h.claimGrant).toHaveBeenCalled());
    h.sync.invalidate();
    const rebound = h.sync.setUser('user-a');
    pending.resolve(receipt);
    await Promise.all([stale, rebound]);
    expect(h.applyGrant).not.toHaveBeenCalled();
    expect(h.configureAccount.mock.calls.map(([user]) => user)).toEqual(['user-a', 'user-a']);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('suppresses stale errors after cleanup and clears an existing error only after rebind', async () => {
    const h = harness();
    const pending = deferred<ScreenTimeGrant | null>();
    await h.sync.setUser('user-a');
    h.getActiveGrant.mockRejectedValueOnce(new Error('First failure'));
    await h.sync.sync(approved);
    h.getActiveGrant.mockReturnValueOnce(pending.promise);
    const stale = h.sync.sync(approved);
    await vi.waitFor(() => expect(h.getActiveGrant).toHaveBeenCalledTimes(2));
    h.sync.invalidate();
    pending.reject(new Error('Stale failure'));
    await stale;
    expect(h.onError).toHaveBeenCalledExactlyOnceWith('Screen Time: First failure');
    await h.sync.setUser('user-a');
    expect(h.onError).toHaveBeenLastCalledWith(null);
  });

  it('still clears the native account on explicit sign-out after lifecycle invalidation', async () => {
    const h = harness();
    await h.sync.setUser('user-a');
    h.sync.invalidate();
    await h.sync.setUser(null);
    expect(h.configureAccount.mock.calls.map(([user]) => user)).toEqual(['user-a', null]);
  });

  it.each([
    { available: false }, { authorized: false }, { blockingEnabled: false },
    { mode: 'daily' as const, dailyLimitReached: false },
  ])('does not claim or emit failures when the engine is disabled: %o', async unavailable => {
    const h = harness();
    h.setStatus(unavailable);
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    await h.sync.sync(approved);
    expect(h.getActiveGrant).not.toHaveBeenCalled();
    expect(h.claimGrant).not.toHaveBeenCalled();
    expect(h.applyGrant).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('waits for a daily threshold before starting an approved break', async () => {
    const h = harness();
    h.setStatus({ mode: 'daily', dailyLimitReached: false, shielded: false });
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.claimGrant).not.toHaveBeenCalled();
    h.setStatus({ dailyLimitReached: true, shielded: true });
    await h.sync.sync();
    expect(h.claimGrant).toHaveBeenCalledExactlyOnceWith('request-a');
    expect(h.applyGrant).toHaveBeenCalledOnce();
  });

  it('recognizes an existing fixed-expiry break after a daily rollover', async () => {
    const h = harness();
    h.setStatus({ mode: 'daily', dailyLimitReached: false, shielded: false,
      temporaryAccessExpiresAt: receipt.expiresAt, appliedGrantId: receipt.grantId });
    h.setActive(receipt);
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.claimGrant).not.toHaveBeenCalled();
    expect(h.applyGrant).not.toHaveBeenCalled();
  });

  it.each([5, 10] as const)('never claims legacy %s-minute approvals', async minutes => {
    const h = harness();
    await h.sync.setUser('user-a');
    await h.sync.sync({ ...approved!, minutes });
    expect(h.claimGrant).not.toHaveBeenCalled();
    expect(h.applyGrant).not.toHaveBeenCalled();
  });

  it('claims an approved 30-minute request and never claims a denial', async () => {
    const h = harness();
    await h.sync.setUser('user-a');
    await h.sync.sync({ ...approved!, status: 'denied' });
    expect(h.claimGrant).not.toHaveBeenCalled();
    await h.sync.sync({ ...approved!, minutes: 30 });
    expect(h.claimGrant).toHaveBeenCalledWith('request-a');
  });

  it('restores an active receipt before claiming a newer decision', async () => {
    const h = harness();
    h.setActive(receipt);
    await h.sync.setUser('user-a');
    await h.sync.sync({ ...approved!, id: 'request-new' });
    expect(h.applyGrant).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(h.claimGrant).not.toHaveBeenCalled();
  });

  it('does not reapply confirmed time or claim it again after expiry', async () => {
    const h = harness();
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    await h.sync.sync(approved);
    expect(h.applyGrant).toHaveBeenCalledTimes(1);
    expect(h.claimGrant).toHaveBeenCalledTimes(1);
    h.setNow(clock + 16 * 60_000);
    h.setActive(null);
    h.setStatus({ temporaryAccessExpiresAt: null, shielded: true });
    await h.sync.sync(approved);
    expect(h.claimGrant).toHaveBeenCalledTimes(1);
  });

  it('recovers a claim whose response was lost without claiming or extending again', async () => {
    const h = harness();
    h.claimGrant.mockImplementationOnce(async () => {
      h.setActive(receipt);
      throw new Error('Connection lost after claim');
    });
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.onError).toHaveBeenLastCalledWith(expect.stringContaining('Connection lost'));
    await h.sync.sync(approved);
    expect(h.claimGrant).toHaveBeenCalledTimes(1);
    expect(h.applyGrant).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(h.onError).toHaveBeenLastCalledWith(null);
  });

  it('keeps a failed native application retryable with the same immutable expiry', async () => {
    const h = harness();
    h.applyGrant.mockRejectedValueOnce(new Error('Monitor could not start'));
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    await h.sync.sync(approved);
    expect(h.applyGrant).toHaveBeenCalledTimes(2);
    expect(h.applyGrant.mock.calls.map(([grant]) => grant.expiresAt)).toEqual([receipt.expiresAt, receipt.expiresAt]);
    expect(h.claimGrant).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenLastCalledWith(null);
  });

  it('does not mark a resolved-but-unconfirmed native application successful', async () => {
    const h = harness();
    h.applyGrant.mockResolvedValueOnce({ ...ready, temporaryAccessExpiresAt: null });
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.onError).toHaveBeenLastCalledWith(expect.stringContaining('not confirmed'));
    await h.sync.sync(approved);
    expect(h.applyGrant).toHaveBeenCalledTimes(2);
  });

  it.each([
    { appliedGrantId: 'different-grant', shielded: false },
    { appliedGrantId: receipt.grantId, shielded: true },
    { appliedGrantId: receipt.grantId, appliedRequestId: 'different-request', shielded: false },
  ])('does not accept a matching expiry without the correct unshielded grant: %o', async partial => {
    const h = harness();
    h.setActive(receipt);
    h.setStatus({ temporaryAccessExpiresAt: receipt.expiresAt, ...partial });
    h.applyGrant.mockResolvedValueOnce({ ...ready, temporaryAccessExpiresAt: receipt.expiresAt, ...partial });
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.applyGrant).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenLastCalledWith(expect.stringContaining('not confirmed'));
    await h.sync.sync(approved);
    expect(h.applyGrant).toHaveBeenCalledTimes(2);
    expect(h.onError).toHaveBeenLastCalledWith(null);
  });

  it.each([undefined, null, receipt.requestId])('accepts an existing receipt with compatible native request ID %s', async appliedRequestId => {
    const h = harness();
    h.setActive(receipt);
    h.setStatus({ temporaryAccessExpiresAt: receipt.expiresAt, appliedGrantId: receipt.grantId,
      appliedRequestId, shielded: false });
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.applyGrant).not.toHaveBeenCalled();
    expect(h.claimGrant).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it.each(['active', 'claimed'] as const)('rejects a receipt owned by another account from %s', async origin => {
    const h = harness();
    const other = { ...receipt, requesterId: 'user-b' };
    if (origin === 'active') h.setActive(other);
    else h.claimGrant.mockResolvedValueOnce(other);
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.applyGrant).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenLastCalledWith(expect.stringContaining('different account or request'));
  });

  it('rejects a claim response for a different request', async () => {
    const h = harness();
    h.claimGrant.mockResolvedValueOnce({ ...receipt, requestId: 'wrong-request' });
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.applyGrant).not.toHaveBeenCalled();
  });

  it.each(['server', 'device'] as const)('does not apply a receipt expired by the %s clock', async clockSource => {
    const h = harness();
    h.setActive(clockSource === 'server' ? { ...receipt, serverNow: receipt.expiresAt } : receipt);
    if (clockSource === 'device') h.setNow(Date.parse(receipt.expiresAt));
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.applyGrant).not.toHaveBeenCalled();
    expect(h.claimGrant).not.toHaveBeenCalled();
  });

  it('blocks a pending claim result immediately after logout and serializes cleanup', async () => {
    const h = harness();
    const pending = deferred<ScreenTimeGrant | null>();
    h.claimGrant.mockReturnValueOnce(pending.promise);
    await h.sync.setUser('user-a');
    const work = h.sync.sync(approved);
    await vi.waitFor(() => expect(h.claimGrant).toHaveBeenCalled());
    const cleanup = h.sync.setUser(null);
    expect(h.configureAccount).toHaveBeenCalledTimes(1);
    pending.resolve(receipt);
    await Promise.all([work, cleanup]);
    expect(h.applyGrant).not.toHaveBeenCalled();
    expect(h.configureAccount).toHaveBeenLastCalledWith(null);
  });

  it('does not let old account configuration start grant work for a new account', async () => {
    const h = harness();
    const configuring = deferred<ScreenTimeStatus>();
    h.configureAccount.mockReturnValueOnce(configuring.promise);
    const ownerA = h.sync.setUser('user-a');
    await vi.waitFor(() => expect(h.configureAccount).toHaveBeenCalledWith('user-a'));
    const stale = h.sync.sync(approved);
    const ownerB = h.sync.setUser('user-b');
    configuring.resolve(ready);
    await Promise.all([ownerA, stale, ownerB]);
    expect(h.configureAccount.mock.calls.map(([user]) => user)).toEqual(['user-a', 'user-b']);
    expect(h.getActiveGrant).not.toHaveBeenCalled();
    expect(h.applyGrant).not.toHaveBeenCalled();
  });

  it('finishes an entered native call before cleanup and never grants its response to a new owner', async () => {
    const h = harness();
    const native = deferred<ScreenTimeStatus>();
    h.applyGrant.mockReturnValueOnce(native.promise);
    await h.sync.setUser('user-a');
    const work = h.sync.sync(approved);
    await vi.waitFor(() => expect(h.applyGrant).toHaveBeenCalled());
    const cleanup = h.sync.setUser(null);
    const nextOwner = h.sync.setUser('user-b');
    expect(h.configureAccount).toHaveBeenCalledTimes(1);
    native.resolve({ ...ready, temporaryAccessExpiresAt: receipt.expiresAt });
    await Promise.all([work, cleanup, nextOwner]);
    expect(h.configureAccount).toHaveBeenLastCalledWith('user-b');
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.applyGrant).toHaveBeenCalledTimes(1);
  });

  it('coalesces simultaneous foreground, snapshot and interval triggers', async () => {
    const h = harness();
    const pending = deferred<ScreenTimeGrant | null>();
    h.getActiveGrant.mockReturnValueOnce(pending.promise);
    await h.sync.setUser('user-a');
    const first = h.sync.sync(approved);
    const second = h.sync.sync(approved);
    expect(first).toBe(second);
    pending.resolve(null);
    await Promise.all([first, second]);
    expect(h.claimGrant).toHaveBeenCalledTimes(1);
    expect(h.applyGrant).toHaveBeenCalledTimes(1);
  });

  it('retries configuration failure and suppresses duplicate failure notifications', async () => {
    const h = harness();
    h.configureAccount.mockRejectedValueOnce(new Error('Native state unavailable'));
    h.configureAccount.mockRejectedValueOnce(new Error('Native state unavailable'));
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.onError).toHaveBeenCalledTimes(1);
    await h.sync.sync(approved);
    expect(h.configureAccount).toHaveBeenCalledTimes(3);
    expect(h.applyGrant).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenLastCalledWith(null);
  });

  it('checks permission again after the server read before consuming a claim', async () => {
    const h = harness();
    h.getActiveGrant.mockImplementationOnce(async () => {
      h.setStatus({ authorized: false });
      return null;
    });
    await h.sync.setUser('user-a');
    await h.sync.sync(approved);
    expect(h.claimGrant).not.toHaveBeenCalled();
    expect(h.applyGrant).not.toHaveBeenCalled();
  });
});
