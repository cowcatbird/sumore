import { describe, expect, it } from 'vitest';
import { remainingDailyTime } from './daily-limit-controls';
import { approvalMessage } from './approval-presentation';
import type { ScreenTimeStatus } from '@/types/domain';

const now = Date.parse('2026-09-22T10:00:00Z');
const status: ScreenTimeStatus = {
  available: true, authorized: true, shielded: false, blockingEnabled: true,
  mode: 'daily', dailyLimitMinutes: 45, dailyLimitReached: true, usageMinutesToday: 30,
  selection: { applications: 2, categories: 0, webDomains: 0 },
  temporaryAccessExpiresAt: null, appliedGrantId: null, authorizationStatus: 'approved', message: '',
};
const decision = { id: 'request-a', minutes: 15, status: 'approved', decidedAt: '2026-09-22T10:00:00Z' } as const;

describe('remaining-time and approval presentation', () => {
  it('uses one aggregate capped remaining meter for shared and per-app policies', () => {
    for (const limitMode of ['shared', 'perApp'] as const) expect(remainingDailyTime({ ...status, limitMode })).toEqual({ remaining: 15, total: 45, fraction: 1 / 3 });
    expect(remainingDailyTime({ ...status, usageMinutesToday: 50 })).toEqual({ remaining: 0, total: 45, fraction: 0 });
    expect(remainingDailyTime({ ...status, limitMode: 'perApp', dailyLimitMinutes: 72000, usageMinutesToday: 72000 })?.remaining).toBe(0);
  });
  it('does not invent progress when there is no usage or active policy', () => {
    for (const change of [{ usageMinutesToday: null }, { usageMinutesToday: NaN }, { usageMinutesToday: -1 }, { blockingEnabled: false }, { dailyLimitMinutes: 0 }, { dailyLimitMinutes: 72001 }]) expect(remainingDailyTime({ ...status, ...change })).toBeNull();
  });
  it('claims unlock only for this request with a live native receipt', () => {
    const active = { ...status, appliedGrantId: 'grant-a', appliedRequestId: 'request-a', temporaryAccessExpiresAt: '2026-09-22T10:15:00Z' };
    expect(approvalMessage(decision, active, now)).toContain('15 extra minutes unlocked.');
    for (const change of [{ appliedRequestId: 'other' }, { shielded: true }, { appliedGrantId: null }, { temporaryAccessExpiresAt: '2026-09-22T09:59:00Z' }]) expect(approvalMessage(decision, { ...active, ...change }, now)).not.toContain('unlocked');
  });
  it('does not demand a second confirmation and explains suspended-app limits', () => {
    expect(approvalMessage(decision, status, now)).toContain('Unused extra time applies automatically');
    expect(approvalMessage(decision, { ...status, dailyLimitReached: false }, now)).toContain('Open sumore when your limit is reached');
    expect(approvalMessage(decision, { ...status, authorized: false }, now)).toContain('Enable your app limit');
    expect(approvalMessage(decision, { ...status, available: false }, now)).toContain('installed app');
    expect(approvalMessage({ ...decision, status: 'denied' }, status, now)).toBe('Request declined.');
  });
});
