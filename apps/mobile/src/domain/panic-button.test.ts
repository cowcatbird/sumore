import { describe, expect, it } from 'vitest';
import { createDemoLimitState } from '@/domain/demo-screen-time';
import type { ScreenTimeStatus } from '@/types/domain';
import { panicButtonBlockReason, previewPanicButtonBlockReason } from './panic-button';

const ready: ScreenTimeStatus = {
  available: true, supportsPanicGrants: true, authorized: true, blockingEnabled: true,
  shielded: true, mode: 'daily', dailyLimitReached: true,
  selection: { applications: 1, categories: 0, webDomains: 0 },
  temporaryAccessExpiresAt: null, appliedGrantId: null, authorizationStatus: 'approved', message: '',
};

describe('panic spending eligibility', () => {
  it.each([0, 1, 5])('allows a compatible phone with an exhausted allowance and %s s’mores', balance => {
    expect(panicButtonBlockReason(ready, balance)).toBeNull();
    expect(panicButtonBlockReason({ ...ready, mode: 'manual' }, balance)).toBeNull();
  });
  it.each([
    { available: false }, { supportsPanicGrants: undefined }, { supportsPanicGrants: false },
    { authorized: false }, { blockingEnabled: false }, { requiresReset: true },
    { selection: { applications: 0, categories: 0, webDomains: 0 } },
    { dailyLimitReached: false }, { dailyLimitReached: undefined },
    { temporaryAccessExpiresAt: '2026-10-12T12:15:00Z' },
  ])('blocks unusable or already-active native state: %j', partial => {
    expect(panicButtonBlockReason({ ...ready, ...partial }, 5)).not.toBeNull();
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('blocks an invalid or unavailable wallet (%s)', balance => {
    expect(panicButtonBlockReason(ready, balance)).not.toBeNull();
    expect(previewPanicButtonBlockReason({ ...createDemoLimitState(), apps: ['Games'], enabled: true, used: 30 }, balance)).not.toBeNull();
  });
  it('allows selected categories and websites, not just individual apps', () => {
    expect(panicButtonBlockReason({ ...ready, selection: { applications: 0, categories: 1, webDomains: 0 } }, 1)).toBeNull();
  });
  it('keeps preview eligibility tied to the simulated allowance', () => {
    const blank = createDemoLimitState();
    const exhausted = { ...blank, apps: ['Social feed' as const], enabled: true, used: blank.minutes };
    expect(previewPanicButtonBlockReason(blank, 10)).not.toBeNull();
    expect(previewPanicButtonBlockReason({ ...exhausted, used: 0 }, 10)).not.toBeNull();
    expect(previewPanicButtonBlockReason(exhausted, 0)).toBeNull();
    expect(previewPanicButtonBlockReason(exhausted, 1)).toBeNull();
    expect(previewPanicButtonBlockReason({ ...exhausted, approvedMinutes: 15 }, 1)).not.toBeNull();
  });
});
