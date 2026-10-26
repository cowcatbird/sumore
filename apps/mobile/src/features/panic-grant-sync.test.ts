import { describe, expect, it, vi } from 'vitest';
import type { ScreenTimeGrant } from '@/domain/screen-time-grants';
import type { ScreenTimeStatus } from '@/types/domain';
import { createScreenTimeGrantSync } from './screen-time-grant-sync';

const clock = Date.parse('2026-10-12T12:00:00Z');
const receipt: ScreenTimeGrant = {
  grantId: '11111111-1111-4111-8111-111111111111', requesterId: '22222222-2222-4222-8222-222222222222',
  source: 'panic', requestId: null,
  startedAt: '2026-10-12T12:00:00Z', expiresAt: '2026-10-12T12:15:00Z', serverNow: '2026-10-12T12:00:00Z',
};
const ready: ScreenTimeStatus = {
  available: true, authorized: true, supportsPanicGrants: true, blockingEnabled: true, shielded: true,
  mode: 'daily', dailyLimitReached: true, selection: { applications: 1, categories: 0, webDomains: 0 },
  temporaryAccessExpiresAt: null, appliedGrantId: null, authorizationStatus: 'approved', message: '',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function harness() {
  let status = { ...ready };
  let active: ScreenTimeGrant | null = null;
  const configureAccount = vi.fn(async () => status);
  const getStatus = vi.fn(async () => status);
  const applyGrant = vi.fn(async (grant: ScreenTimeGrant) => {
    status = { ...status, shielded: false, appliedGrantId: grant.grantId, appliedRequestId: grant.requestId,
      temporaryAccessExpiresAt: grant.expiresAt };
    return status;
  });
  const triggerPanic = vi.fn(async (_expectedUser: string) => { active = receipt; return receipt; });
  const getActiveGrant = vi.fn(async () => active);
  const claimGrant = vi.fn(async () => null);
  const onError = vi.fn();
  const sync = createScreenTimeGrantSync({ configureAccount, getStatus, applyGrant, claimGrant, triggerPanic,
    getActiveGrant, onError, now: () => clock });
  return { sync, configureAccount, getStatus, applyGrant, triggerPanic, getActiveGrant, claimGrant, onError,
    setActive: (next: ScreenTimeGrant | null) => { active = next; },
    setStatus: (partial: Partial<ScreenTimeStatus>) => { status = { ...status, ...partial }; } };
}

describe('panic grant delivery', () => {
  it.each([0, 1, 5])('waits for native confirmation of the exact 15-minute receipt with %s s’mores', async balance => {
    const h = harness();
    await h.sync.setUser(receipt.requesterId);
    await h.sync.pressPanicButton(balance);
    expect(h.triggerPanic).toHaveBeenCalledExactlyOnceWith(receipt.requesterId);
    expect(h.applyGrant).toHaveBeenCalledExactlyOnceWith(receipt);
    expect(h.claimGrant).not.toHaveBeenCalled();
    expect((await h.getStatus()).temporaryAccessExpiresAt).toBe(receipt.expiresAt);
  });
  it.each([
    { available: false }, { authorized: false }, { blockingEnabled: false },
    { supportsPanicGrants: undefined }, { requiresReset: true }, { dailyLimitReached: false },
    { selection: { applications: 0, categories: 0, webDomains: 0 } },
    { temporaryAccessExpiresAt: receipt.expiresAt },
  ])('does not charge when fresh native preflight fails: %j', partial => {
    const h = harness();
    h.setStatus(partial);
    return h.sync.setUser(receipt.requesterId).then(async () => {
      await expect(h.sync.pressPanicButton(2)).rejects.toThrow();
      expect(h.triggerPanic).not.toHaveBeenCalled();
      expect(h.applyGrant).not.toHaveBeenCalled();
    });
  });
  it('does not submit when the wallet is unavailable', async () => {
    const h = harness();
    await h.sync.setUser(receipt.requesterId);
    await expect(h.sync.pressPanicButton(NaN)).rejects.toThrow('balance is unavailable');
    expect(h.triggerPanic).not.toHaveBeenCalled();
  });
  it('rechecks permissions after the server read and before spending', async () => {
    const h = harness();
    h.getActiveGrant.mockImplementationOnce(async () => { h.setStatus({ authorized: false }); return null; });
    await h.sync.setUser(receipt.requesterId);
    await expect(h.sync.pressPanicButton(2)).rejects.toThrow('Panic access needs Screen Time access');
    expect(h.triggerPanic).not.toHaveBeenCalled();
  });
  it('coalesces double taps and rejects another purchase while extra time runs', async () => {
    const h = harness();
    await h.sync.setUser(receipt.requesterId);
    const first = h.sync.pressPanicButton(3);
    const duplicate = h.sync.pressPanicButton(3);
    expect(duplicate).toBe(first);
    await Promise.all([first, duplicate]);
    await expect(h.sync.pressPanicButton(3)).rejects.toThrow('already running');
    expect(h.triggerPanic).toHaveBeenCalledTimes(1);
  });
  it('restores an existing server receipt without spending again', async () => {
    const h = harness();
    h.setActive(receipt);
    await h.sync.setUser(receipt.requesterId);
    await h.sync.pressPanicButton(0);
    expect(h.triggerPanic).not.toHaveBeenCalled();
    expect(h.applyGrant).toHaveBeenCalledExactlyOnceWith(receipt);
  });
  it('recovers a lost write response using a read, not another charge', async () => {
    const h = harness();
    h.triggerPanic.mockImplementationOnce(async () => { h.setActive(receipt); throw new Error('lost response'); });
    await h.sync.setUser(receipt.requesterId);
    await h.sync.pressPanicButton(1);
    expect(h.triggerPanic).toHaveBeenCalledTimes(1);
    expect(h.applyGrant).toHaveBeenCalledExactlyOnceWith(receipt);
  });
  it('reports an uncertain server outcome without retrying the write', async () => {
    const h = harness();
    h.triggerPanic.mockRejectedValueOnce(new Error('offline'));
    await h.sync.setUser(receipt.requesterId);
    await expect(h.sync.pressPanicButton(1)).rejects.toThrow('Could not confirm panic access');
    expect(h.triggerPanic).toHaveBeenCalledTimes(1);
    expect(h.applyGrant).not.toHaveBeenCalled();
  });
  it('reports native failure and later restores the original deadline without another charge', async () => {
    const h = harness();
    h.applyGrant.mockRejectedValueOnce(new Error('monitor unavailable'));
    await h.sync.setUser(receipt.requesterId);
    await expect(h.sync.pressPanicButton(1)).rejects.toThrow('not confirmed the unlock');
    await h.sync.sync();
    expect(h.triggerPanic).toHaveBeenCalledTimes(1);
    expect(h.applyGrant).toHaveBeenNthCalledWith(2, receipt);
  });
  it('does not report success if native omits the receipt acknowledgement', async () => {
    const h = harness();
    h.applyGrant.mockResolvedValueOnce(ready);
    await h.sync.setUser(receipt.requesterId);
    await expect(h.sync.pressPanicButton(1)).rejects.toThrow('not confirmed the unlock');
  });
  it('rejects the wrong account receipt without passing it to native', async () => {
    const h = harness();
    h.triggerPanic.mockResolvedValueOnce({ ...receipt, requesterId: 'another-user' });
    await h.sync.setUser(receipt.requesterId);
    await expect(h.sync.pressPanicButton(1)).rejects.toThrow('not confirmed the unlock');
    expect(h.applyGrant).not.toHaveBeenCalled();
  });
  it('does not spend after an account switch during preflight', async () => {
    const h = harness();
    const pending = deferred<ScreenTimeGrant | null>();
    h.getActiveGrant.mockReturnValueOnce(pending.promise);
    await h.sync.setUser(receipt.requesterId);
    const press = h.sync.pressPanicButton(1);
    await vi.waitFor(() => expect(h.getActiveGrant).toHaveBeenCalled());
    const switched = h.sync.setUser('another-user');
    pending.resolve(null);
    await Promise.all([press, switched]);
    expect(h.triggerPanic).not.toHaveBeenCalled();
  });
  it('does not apply an in-flight paid receipt to a different account', async () => {
    const h = harness();
    const pending = deferred<ScreenTimeGrant>();
    h.triggerPanic.mockReturnValueOnce(pending.promise);
    await h.sync.setUser(receipt.requesterId);
    const press = h.sync.pressPanicButton(1);
    await vi.waitFor(() => expect(h.triggerPanic).toHaveBeenCalled());
    const switched = h.sync.setUser('another-user');
    pending.resolve(receipt);
    await Promise.all([press, switched]);
    expect(h.triggerPanic).toHaveBeenCalledExactlyOnceWith(receipt.requesterId);
    expect(h.applyGrant).not.toHaveBeenCalled();
  });
  it('serializes two accounts while preserving each confirmation owner', async () => {
    const h = harness();
    const pending = deferred<ScreenTimeGrant>();
    const otherUser = '33333333-3333-4333-8333-333333333333';
    const otherReceipt = { ...receipt, requesterId: otherUser, grantId: '44444444-4444-4444-8444-444444444444' };
    h.triggerPanic.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(otherReceipt);
    await h.sync.setUser(receipt.requesterId);
    const first = h.sync.pressPanicButton(1);
    await vi.waitFor(() => expect(h.triggerPanic).toHaveBeenCalledTimes(1));
    const switched = h.sync.setUser(otherUser);
    const second = h.sync.pressPanicButton(0);
    expect(h.triggerPanic).toHaveBeenCalledExactlyOnceWith(receipt.requesterId);
    pending.resolve(receipt);
    await Promise.all([first, switched, second]);
    expect(h.triggerPanic.mock.calls).toEqual([[receipt.requesterId], [otherUser]]);
    expect(h.applyGrant).toHaveBeenCalledExactlyOnceWith(otherReceipt);
  });
});
