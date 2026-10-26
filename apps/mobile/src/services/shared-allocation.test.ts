import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenTimeStatus } from '@/types/domain';

const h = vi.hoisted(() => ({ user: 'owner-a', save: vi.fn(), session: vi.fn() }));
vi.mock('@/services/account-access', () => ({ setSharedDailyTotal: h.save }));
vi.mock('@/lib/supabase', () => ({ requireSupabase: () => ({ auth: { getSession: h.session } }) }));
const status = (minutes: number, patch: Partial<ScreenTimeStatus> = {}): ScreenTimeStatus => ({
  available: true, authorized: true, authorizationStatus: 'approved', blockingEnabled: true, mode: 'daily', dailyLimitMinutes: minutes,
  shielded: false, temporaryAccessExpiresAt: null, appliedGrantId: null,
  selection: { applications: 1, categories: 0, webDomains: 0 }, message: '', ...patch,
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); h.user = 'owner-a';
  h.session.mockImplementation(async () => ({ data: { session: { user: { id: h.user } } } }));
  h.save.mockResolvedValue(undefined);
});

describe('optional Circle allocation uploads', () => {
  it('coalesces simultaneous identical uploads without permanently caching them', async () => {
    const { publishDailyAllocation: publish } = await import('./shared-allocation');
    const pending = Promise.withResolvers<void>(); h.save.mockReturnValueOnce(pending.promise);
    const calls = [publish(status(30), h.user), publish(status(30), h.user)];
    await flush(); expect(h.save).toHaveBeenCalledTimes(1);
    pending.resolve(); await Promise.all(calls);
    await publish(status(30), h.user);
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it('serializes slow saves so newer settings always publish last, including A → B → A', async () => {
    const { publishDailyAllocation: publish } = await import('./shared-allocation');
    const pending = Promise.withResolvers<void>(); h.save.mockReturnValueOnce(pending.promise);
    const calls = [publish(status(30), h.user), publish(status(60), h.user), publish(status(30), h.user)];
    await flush(); expect(h.save.mock.calls).toEqual([[30, 'owner-a']]);
    pending.resolve(); await Promise.all(calls);
    expect(h.save.mock.calls).toEqual([[30, 'owner-a'], [60, 'owner-a'], [30, 'owner-a']]);
  });

  it('checks ownership again when queued work starts after an account switch', async () => {
    const { publishDailyAllocation: publish } = await import('./shared-allocation');
    const pending = Promise.withResolvers<void>(); h.save.mockReturnValueOnce(pending.promise);
    const first = publish(status(30), h.user);
    const stale = publish(status(60), h.user);
    await flush(); h.user = 'owner-b';
    const nextOwner = publish(status(15), h.user);
    pending.resolve(); await Promise.all([first, stale, nextOwner]);
    expect(h.save.mock.calls).toEqual([[30, 'owner-a'], [15, 'owner-b']]);
  });

  it('surfaces errors without poisoning later uploads or exposing selections', async () => {
    const { publishDailyAllocation: publish } = await import('./shared-allocation');
    h.save.mockRejectedValueOnce(new Error('Offline'));
    const failed = publish(status(30), h.user);
    const next = publish(status(60), h.user);
    await expect(failed).rejects.toThrow('Offline'); await next;
    expect(h.save.mock.calls).toEqual([[30, 'owner-a'], [60, 'owner-a']]);
  });

  it('skips unavailable/damaged state and publishes zero for a confirmed disabled limit', async () => {
    const { publishDailyAllocation: publish } = await import('./shared-allocation');
    await publish(status(30, { available: false }), h.user);
    await publish(status(30, { requiresReset: true }), h.user);
    await publish(status(30, { blockingEnabled: false }), h.user);
    expect(h.save).toHaveBeenCalledExactlyOnceWith(0, 'owner-a');
  });
});
