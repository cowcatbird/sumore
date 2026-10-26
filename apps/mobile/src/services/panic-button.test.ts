import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createScreenTimeGrantSync } from '@/features/screen-time-grant-sync';
import { ACCOUNT_LOAD_TIMEOUT_MS } from '@/lib/account-timeout';
import type { ScreenTimeStatus } from '@/types/domain';

import { getActiveScreenTimeGrant, triggerPanicButton } from './supabase-backend';

const { rpc, clientOverride } = vi.hoisted(() => ({ rpc: vi.fn(), clientOverride: { current: null as SupabaseClient | null } }));
vi.mock('@/lib/supabase', () => ({ requireSupabase: () => clientOverride.current ?? { rpc } }));

const receipt = {
  grantId: '11111111-1111-4111-8111-111111111111',
  requesterId: '22222222-2222-4222-8222-222222222222',
  requestId: null, source: 'panic' as const,
  startedAt: '2026-10-12T12:00:00Z', expiresAt: '2026-10-12T12:15:00Z', serverNow: '2026-10-12T12:00:00Z',
};
const shop = {
  id: 'circle', name: 'Circle', balance: 0, unlocked: [], background: 'forest',
  localDate: '2026-10-12', timeZone: 'UTC', askedToday: true, eligibleToday: false,
  dayStartedAt: '2026-10-12T00:00:00Z', nextAwardAt: '2026-10-13T00:00:00Z',
};

beforeEach(() => { rpc.mockReset(); clientOverride.current = null; });
afterEach(() => vi.useRealTimers());

describe('panic grant network boundary', () => {
  it('submits one charge and preserves the fixed receipt and updated wallet', async () => {
    rpc.mockResolvedValueOnce({ data: { grant: receipt, shop }, error: null });
    expect(await triggerPanicButton(receipt.requesterId)).toEqual({ grant: receipt, shop });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('use_panic_button', { expected_user_id: receipt.requesterId });
  });

  it.each(['', ' ', 'not-a-uuid', ` ${receipt.requesterId}`, null, undefined])('rejects an invalid confirmation owner before submitting: %s', async owner => {
    await expect(triggerPanicButton(owner as string)).rejects.toThrow('Sign in again');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a valid receipt belonging to a different account', async () => {
    rpc.mockResolvedValueOnce({ data: { grant: { ...receipt, requesterId: '33333333-3333-4333-8333-333333333333' }, shop }, error: null });
    await expect(triggerPanicButton(receipt.requesterId)).rejects.toThrow('different account');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('preserves the confirmation owner when auth switches while the SDK resolves its token', async () => {
    const tokenRequested = Promise.withResolvers<void>();
    const resumeToken = Promise.withResolvers<void>();
    let authenticatedUser = receipt.requesterId;
    const otherUser = '33333333-3333-4333-8333-333333333333';
    const requests: { authorization: string | null; body: unknown }[] = [];
    clientOverride.current = createClient('https://panic-test.invalid', 'test-key', {
      accessToken: async () => {
        tokenRequested.resolve();
        await resumeToken.promise;
        return authenticatedUser;
      },
      global: { fetch: async (_input, init) => {
        requests.push({ authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
        // The SQL boundary rejects an owner mismatch before touching the wallet.
        return new Response(JSON.stringify({ message: 'Your account changed.', code: 'P0001', details: null, hint: null }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      } },
    });
    const operation = triggerPanicButton(receipt.requesterId);
    const rejected = expect(operation).rejects.toThrow('account changed');
    await tokenRequested.promise;
    authenticatedUser = otherUser;
    resumeToken.resolve();
    await rejected;
    expect(requests).toEqual([{ authorization: `Bearer ${otherUser}`, body: { expected_user_id: receipt.requesterId } }]);
  });

  it('bounds a stalled write without retrying it or accepting a late response', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<{ data: { grant: typeof receipt; shop: typeof shop }; error: null }>();
    rpc.mockReturnValueOnce(pending.promise);
    const operation = triggerPanicButton(receipt.requesterId);
    const rejection = expect(operation).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(ACCOUNT_LOAD_TIMEOUT_MS);
    await rejection;
    expect(rpc).toHaveBeenCalledExactlyOnceWith('use_panic_button', { expected_user_id: receipt.requesterId });
    pending.resolve({ data: { grant: receipt, shop }, error: null });
    await expect(operation).rejects.toThrow('took too long');
    rpc.mockResolvedValueOnce({ data: receipt, error: null });
    expect(await getActiveScreenTimeGrant()).toEqual(receipt);
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['use_panic_button', 'get_active_screen_time_grant']);
  });

  it('releases queued native account cleanup when a panic write stalls', async () => {
    vi.useFakeTimers();
    rpc.mockReturnValueOnce(new Promise(() => undefined));
    const ready: ScreenTimeStatus = {
      available: true, supportsPanicGrants: true, authorized: true, blockingEnabled: true, shielded: true,
      mode: 'daily', dailyLimitReached: true, selection: { applications: 1, categories: 0, webDomains: 0 },
      temporaryAccessExpiresAt: null, appliedGrantId: null, authorizationStatus: 'approved', message: '',
    };
    const configureAccount = vi.fn(async (_owner: string | null) => ready);
    const applyGrant = vi.fn(async () => ready);
    const sync = createScreenTimeGrantSync({
      configureAccount, getStatus: async () => ready, applyGrant,
      claimGrant: async () => null, getActiveGrant: async () => null,
      triggerPanic: async expectedUser => (await triggerPanicButton(expectedUser)).grant,
      onError: vi.fn(), now: () => Date.parse(receipt.serverNow),
    });
    await sync.setUser(receipt.requesterId);
    const press = sync.pressPanicButton(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('use_panic_button', { expected_user_id: receipt.requesterId });
    const cleanup = sync.setUser(null);
    expect(configureAccount).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ACCOUNT_LOAD_TIMEOUT_MS);
    await Promise.all([press, cleanup]);
    expect(configureAccount).toHaveBeenLastCalledWith(null);
    expect(applyGrant).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
