import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ACCOUNT_LOAD_TIMEOUT_MS } from '@/lib/account-timeout';

import { claimScreenTimeGrant, getActiveScreenTimeGrant } from './supabase-backend';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ requireSupabase: () => ({ rpc }) }));

const receipt = {
  grantId: '11111111-1111-4111-8111-111111111111',
  requesterId: '22222222-2222-4222-8222-222222222222',
  requestId: '33333333-3333-4333-8333-333333333333',
  source: 'request' as const,
  startedAt: '2026-09-14T12:00:00Z', expiresAt: '2026-09-14T12:15:00Z', serverNow: '2026-09-14T12:01:00Z',
};

beforeEach(() => rpc.mockReset());
afterEach(() => vi.useRealTimers());

describe('server-created Screen Time receipt helpers', () => {
  it('sends only the request identity; never supplies minutes, owner or a client-generated expiry', async () => {
    rpc.mockResolvedValue({ data: receipt, error: null });
    expect(await claimScreenTimeGrant(receipt.requestId)).toEqual(receipt);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('claim_screen_time_grant', { target_request_id: receipt.requestId });
  });

  it('restores the authenticated account’s active grant without a caller-selected account ID', async () => {
    rpc.mockResolvedValue({ data: receipt, error: null });
    expect(await getActiveScreenTimeGrant()).toEqual(receipt);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('get_active_screen_time_grant');
  });

  it.each([claimScreenTimeGrant, getActiveScreenTimeGrant])('accepts no-grant responses and rejects malformed receipts for %s', async load => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await load(receipt.requestId)).toBeNull();
    rpc.mockResolvedValueOnce({ data: { ...receipt, requesterId: undefined }, error: null });
    await expect(load(receipt.requestId)).rejects.toThrow('verified identity');
  });

  it.each([claimScreenTimeGrant, getActiveScreenTimeGrant])('surfaces server errors instead of an apparent successful grant for %s', async load => {
    rpc.mockResolvedValue({ data: receipt, error: { code: 'P0001', message: 'Authentication required' } });
    await expect(load(receipt.requestId)).rejects.toThrow('Authentication required');
  });

  it.each([claimScreenTimeGrant, getActiveScreenTimeGrant])('bounds stalled responses without accepting a late receipt for %s', async load => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<{ data: typeof receipt; error: null }>();
    rpc.mockReturnValueOnce(pending.promise);
    const operation = load(receipt.requestId);
    const rejection = expect(operation).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(ACCOUNT_LOAD_TIMEOUT_MS);
    await rejection;
    pending.resolve({ data: receipt, error: null });
    await expect(operation).rejects.toThrow('took too long');
    rpc.mockResolvedValueOnce({ data: receipt, error: null });
    expect(await getActiveScreenTimeGrant()).toEqual(receipt);
  });
});
