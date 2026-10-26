import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { androidAccessStep, canEditDailyLimit, dailyLimitSummary } from '@/domain/daily-limit-controls';
import type { ScreenTimeGrant } from '@/domain/screen-time-grants';
import { createScreenTimeGrantSync } from '@/features/screen-time-grant-sync';

const native = vi.hoisted(() => ({ methods: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => native.methods }));

// Mirror the map returned by Android ScreenTimeEngine.status() before setup.
const initial = {
  engineAvailable: true, authorized: false, authorizationStatus: 'notDetermined',
  shielded: false, blockingEnabled: false, selection: { applications: 0, categories: 0, webDomains: 0 },
  appliedGrantId: null, temporaryAccessExpiresAt: null, reason: 'Accept the disclosure to set up Android app limits.',
  requiresReset: false, mode: 'daily', dailyLimitMinutes: null, dailyLimitReached: false,
  usageMinutesToday: null, usageAccessGranted: false, accessibilityEnabled: false,
  consentGranted: false, settingsChangeAllowedAt: null,
};
const connected = {
  ...initial, authorized: true, authorizationStatus: 'approved', consentGranted: true,
  usageAccessGranted: true, accessibilityEnabled: true, usageMinutesToday: 0, reason: null,
};

beforeEach(() => {
  vi.resetModules();
  native.methods = {};
  for (const key of ['getStatus', 'setAccount', 'setDisclosureAccepted', 'configureDailyLimit', 'setBlockingEnabled',
    'requestDisable', 'cancelDisable', 'clearSelection', 'grantTemporaryAccess', 'openUsageAccessSettings',
    'openAccessibilitySettings', 'presentAppPicker']) native.methods[key] = vi.fn().mockResolvedValue(initial);
  native.methods.requestAuthorization = vi.fn().mockResolvedValue('denied');
});

afterEach(() => { vi.useRealTimers(); });

describe('Android status maps through native adapter and setup helpers', () => {
  it('keeps the initial no-budget and no-permission state available for consent', async () => {
    const api = await import('./screen-time');
    const status = await api.getScreenTimeStatus();
    expect(status).toMatchObject({ available: true, dailyLimitsAvailable: true, dailyLimitMinutes: null, authorized: false });
    expect(androidAccessStep(status)).toBe('disclosure');
    expect(canEditDailyLimit(status, 'android')).toBe(false);
    expect(dailyLimitSummary(status)).toBe(initial.reason);
  });

  it.each([
    ['openScreenTimeUsageSettings', 'openUsageAccessSettings', { ...initial, consentGranted: true }, 'usage'],
    ['openScreenTimeAccessibilitySettings', 'openAccessibilitySettings', { ...initial, consentGranted: true, usageAccessGranted: true }, 'accessibility'],
  ] as const)('consumes one %s response without treating navigation as a permission grant', async (apiName, nativeName, response, step) => {
    native.methods.getStatus.mockResolvedValue(response);
    native.methods[nativeName].mockResolvedValue(response);
    const api = await import('./screen-time');
    const status = await api[apiName]();
    expect(native.methods[nativeName]).toHaveBeenCalledExactlyOnceWith();
    expect(status).toMatchObject({ available: true, authorized: false, blockingEnabled: false });
    expect(androidAccessStep(status)).toBe(step);
    expect(canEditDailyLimit(status, 'android')).toBe(false);
  });

  it('recovers after returning from Android settings and reading the connected service', async () => {
    native.methods.getStatus.mockResolvedValue(connected);
    const api = await import('./screen-time');
    const status = await api.getScreenTimeStatus();
    expect(androidAccessStep(status)).toBe('ready');
    expect(canEditDailyLimit(status, 'android')).toBe(true);
    expect(status.dailyLimitMinutes).toBeNull();
  });

  it.each([
    'Android has not connected the Accessibility service.',
    'Android usage history is unavailable. Unlock the phone and retry.',
    'Android could not display the app-limit screen.',
  ])('preserves recoverable native failure: %s', async reason => {
    native.methods.getStatus.mockResolvedValue({ ...connected, authorized: false, reason, blockingEnabled: true, dailyLimitMinutes: 30 });
    const api = await import('./screen-time');
    const status = await api.getScreenTimeStatus();
    expect(status).toMatchObject({ available: true, authorized: false, shielded: false, blockingEnabled: false });
    expect(androidAccessStep(status)).toBe('ready');
    expect(canEditDailyLimit(status, 'android')).toBe(false);
    expect(dailyLimitSummary(status)).toBe(reason);
  });

  it('leaves corrupted storage available for explicit clear, without auto-binding or clearing in the adapter', async () => {
    const corrupt = { ...initial, requiresReset: true, reason: 'App-limit settings could not be read. Clear your selection to start again.' };
    native.methods.getStatus.mockResolvedValue(corrupt);
    const api = await import('./screen-time');
    const status = await api.getScreenTimeStatus();
    expect(status).toMatchObject({ available: true, requiresReset: true, dailyLimitMinutes: null });
    expect(dailyLimitSummary(status)).toBe(corrupt.reason);
    expect(canEditDailyLimit(status, 'android')).toBe(false);
    expect(native.methods.clearSelection).not.toHaveBeenCalled();
    expect(native.methods.setAccount).not.toHaveBeenCalled();
    expect(await api.clearScreenTimeSelection()).toMatchObject({ available: true, requiresReset: false });
    expect(native.methods.clearSelection).toHaveBeenCalledExactlyOnceWith();
  });

  it('propagates an interrupted picker and allows a later retry to return selection counts', async () => {
    native.methods.getStatus.mockResolvedValue(connected);
    native.methods.presentAppPicker.mockRejectedValueOnce(new Error('App picker was interrupted. Reopen it.'))
      .mockResolvedValueOnce({ ...connected, selection: { applications: 2, categories: 0, webDomains: 0 } });
    const api = await import('./screen-time');
    await expect(api.selectScreenTimeApps()).rejects.toThrow('App picker was interrupted');
    expect(await api.selectScreenTimeApps()).toMatchObject({ selection: { applications: 2 }, blockingEnabled: false });
    expect(native.methods.presentAppPicker).toHaveBeenCalledTimes(2);
  });

  it('retries an Android approval failure with the exact server expiry and confirms the native receipt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T05:51:50Z'));
    const receipt: ScreenTimeGrant = {
      grantId: '22222222-2222-4222-8222-222222222222',
      requesterId: '11111111-1111-4111-8111-111111111111',
      requestId: '33333333-3333-4333-8333-333333333333', source: 'request' as const,
      startedAt: '2026-09-17T05:51:48.116656+00:00',
      expiresAt: '2026-09-17T06:06:48.116656+00:00',
      serverNow: '2026-09-17T05:51:49.116656+00:00',
    };
    const blocked = { ...connected, blockingEnabled: true, shielded: true,
      dailyLimitMinutes: 15, dailyLimitReached: true, usageMinutesToday: 15,
      selection: { applications: 1, categories: 0, webDomains: 0 } };
    native.methods.getStatus.mockResolvedValue(blocked);
    native.methods.setAccount.mockResolvedValue(blocked);
    native.methods.grantTemporaryAccess.mockRejectedValueOnce(new Error('Approval could not be applied.'))
      .mockImplementation(async grant => {
        const unlocked = { ...blocked, shielded: false,
          temporaryAccessExpiresAt: grant.expiresAt, appliedGrantId: grant.grantId };
        native.methods.getStatus.mockResolvedValue(unlocked);
        return unlocked;
      });
    let active: ScreenTimeGrant | null = null;
    const claimGrant = vi.fn(async () => { active = receipt; return receipt; });
    const onError = vi.fn();
    const api = await import('./screen-time');
    const sync = createScreenTimeGrantSync({
      configureAccount: api.configureScreenTimeAccount, getStatus: api.getScreenTimeStatus,
      applyGrant: api.applyScreenTimeGrant, claimGrant, getActiveGrant: async () => active, onError,
    });
    await sync.setUser(receipt.requesterId);
    await sync.sync({ id: receipt.requestId!, status: 'approved', minutes: 15, decidedAt: receipt.startedAt });
    expect(onError).toHaveBeenLastCalledWith('Screen Time: Approval could not be applied.');
    expect(await api.getScreenTimeStatus()).toMatchObject({ shielded: true, temporaryAccessExpiresAt: null });

    // The retry occurs later, but never starts a fresh 15-minute timer or claim.
    vi.setSystemTime(new Date('2026-09-17T05:52:50Z'));
    await sync.sync();
    expect(claimGrant).toHaveBeenCalledExactlyOnceWith(receipt.requestId);
    expect(native.methods.grantTemporaryAccess.mock.calls).toEqual([[receipt], [receipt]]);
    expect(onError).toHaveBeenLastCalledWith(null);
    expect(await api.getScreenTimeStatus()).toMatchObject({
      shielded: false, temporaryAccessExpiresAt: receipt.expiresAt, appliedGrantId: receipt.grantId,
    });
    await sync.sync();
    expect(native.methods.grantTemporaryAccess).toHaveBeenCalledTimes(2);
  });
});
