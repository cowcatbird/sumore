import { beforeEach, describe, expect, it, vi } from 'vitest';

const environment = vi.hoisted(() => ({
  os: 'ios',
  modulePresent: false,
  getStatus: vi.fn(),
  engineMethods: {} as Record<string, ReturnType<typeof vi.fn>>,
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock('react-native', () => ({ Platform: { get OS() { return environment.os; } } }));
vi.mock('expo-modules-core', () => ({
  requireOptionalNativeModule: environment.requireOptionalNativeModule,
}));

beforeEach(() => {
  vi.resetModules();
  environment.os = 'ios';
  environment.modulePresent = false;
  environment.getStatus.mockReset();
  environment.engineMethods = {};
  environment.requireOptionalNativeModule.mockReset().mockImplementation(() =>
    environment.modulePresent ? { getStatus: environment.getStatus, ...environment.engineMethods } : null,
  );
});

describe('truthful Screen Time beta status', () => {
  it('does not claim that installing an iPhone build alone enables app blocking', async () => {
    const { getScreenTimeStatus } = await import('./screen-time');
    const status = await getScreenTimeStatus();
    expect(status).toMatchObject({ available: false, authorized: false, shielded: false });
    expect(status.message).toContain('not available in this installed version');
    expect(status.message).toContain('Family Controls distribution approval');
    expect(status.message).toContain('new signed iPhone build');
  });

  it('keeps blocking unavailable even if the native stub reports authorization or a shield', async () => {
    environment.modulePresent = true;
    environment.getStatus.mockResolvedValue({ authorized: true, shielded: true });
    const { getScreenTimeStatus } = await import('./screen-time');
    const status = await getScreenTimeStatus();
    // Preserve permission information without confusing it with enforcement.
    expect(status).toMatchObject({ available: false, authorized: true, shielded: false });
    expect(status.message).toContain('not available in this installed version');
    expect(status.message).not.toContain('access is ready');
  });

  it('still explains the limitation when the native permission-status call fails', async () => {
    environment.modulePresent = true;
    environment.getStatus.mockRejectedValue(new Error('Unavailable entitlement'));
    const { getScreenTimeStatus } = await import('./screen-time');
    const status = await getScreenTimeStatus();
    expect(status).toMatchObject({ available: false, authorized: false, shielded: false });
    expect(status.message).toContain('Previously enabled restrictions may still be active');
  });

  it('looks up Android support but does not claim an older build can block', async () => {
    environment.os = 'android';
    environment.modulePresent = false;
    const { getScreenTimeStatus } = await import('./screen-time');
    const status = await getScreenTimeStatus();
    expect(status).toMatchObject({ available: false, authorized: false, shielded: false });
    expect(status.message).toContain('new Android build');
    expect(environment.requireOptionalNativeModule).toHaveBeenCalledWith('ScreenTimeModule');
  });

  it('explains that a web preview cannot restrict phone apps', async () => {
    environment.os = 'web';
    environment.modulePresent = true;
    const { getScreenTimeStatus } = await import('./screen-time');
    const status = await getScreenTimeStatus();
    expect(status).toMatchObject({ available: false, authorized: false, shielded: false });
    expect(status.message).toBe('App blocking and unlocking require the installed app on your phone.');
    expect(environment.requireOptionalNativeModule).not.toHaveBeenCalled();
  });
});

function installDailyEngine(android = false) {
  installEngine();
  const dailyStatus = {
    ...ready, mode: 'daily', dailyLimitMinutes: 30, dailyLimitReached: true,
    usageMinutesToday: null, settingsChangeAllowedAt: null,
    usageAccessGranted: true, accessibilityEnabled: true, consentGranted: true,
  };
  for (const method of ['configureDailyLimit', 'requestDisable', 'cancelDisable',
    ...(android ? ['openUsageAccessSettings', 'openAccessibilitySettings', 'setDisclosureAccepted'] : [])]) {
    environment.engineMethods[method] = vi.fn().mockResolvedValue(dailyStatus);
  }
  environment.getStatus.mockResolvedValue(dailyStatus);
  return dailyStatus;
}

describe('daily-limit native capabilities', () => {
  it('keeps old iOS manual engines usable without advertising daily limits', async () => {
    installEngine();
    const api = await import('./screen-time');
    expect(await api.getScreenTimeStatus()).toMatchObject({ available: true, dailyLimitsAvailable: false, mode: 'manual' });
    await expect(api.configureDailyScreenTimeLimit(30)).rejects.toThrow('new installed app');
  });

  it('requires the complete Android permission API', async () => {
    environment.os = 'android';
    installDailyEngine();
    const api = await import('./screen-time');
    expect((await api.getScreenTimeStatus()).available).toBe(false);
  });

  it('supports a consented, authorized Android daily engine', async () => {
    environment.os = 'android';
    const status = installDailyEngine(true);
    environment.getStatus.mockResolvedValue({ ...status, usageMinutesToday: 32.5 });
    const api = await import('./screen-time');
    expect(await api.getScreenTimeStatus()).toMatchObject({ available: true, dailyLimitsAvailable: true, authorized: true, shielded: true, dailyLimitReached: true, usageMinutesToday: 32.5 });
  });

  it('allows first-run Android setup before a budget or permissions exist', async () => {
    environment.os = 'android';
    const status = installDailyEngine(true);
    environment.getStatus.mockResolvedValue({ ...status, dailyLimitMinutes: null, dailyLimitReached: false,
      blockingEnabled: false, shielded: false, authorized: false, consentGranted: false,
      usageAccessGranted: false, accessibilityEnabled: false, reason: 'Accept the disclosure first.' });
    const api = await import('./screen-time');
    expect(await api.getScreenTimeStatus()).toMatchObject({ available: true, dailyLimitsAvailable: true,
      dailyLimitMinutes: null, authorized: false, message: 'Accept the disclosure first.' });
    await api.setScreenTimeDisclosureAccepted(true);
    expect(environment.engineMethods.setDisclosureAccepted).toHaveBeenCalledWith(true);
  });

  it.each(['usageAccessGranted', 'accessibilityEnabled', 'accessibilityServiceConnected', 'consentGranted'])('never reports Android enforcement without %s', async field => {
    environment.os = 'android';
    const status = installDailyEngine(true);
    environment.getStatus.mockResolvedValue({ ...status, [field]: false });
    const api = await import('./screen-time');
    expect(await api.getScreenTimeStatus()).toMatchObject({ available: true, authorized: false, shielded: false, blockingEnabled: false });
  });

  it('preserves Android service connection status without fabricating it for older native builds', async () => {
    environment.os = 'android';
    const status = installDailyEngine(true);
    const api = await import('./screen-time');
    expect((await api.getScreenTimeStatus()).accessibilityServiceConnected).toBeUndefined();
    environment.getStatus.mockResolvedValue({ ...status, accessibilityServiceConnected: true });
    expect(await api.getScreenTimeStatus()).toMatchObject({ accessibilityServiceConnected: true, authorized: true });
    environment.getStatus.mockResolvedValue({ ...status, accessibilityServiceConnected: false });
    expect(await api.getScreenTimeStatus()).toMatchObject({ accessibilityServiceConnected: false, authorized: false, blockingEnabled: false });
  });

  it.each([
    { dailyLimitMinutes: 0 }, { dailyLimitMinutes: 31 }, { dailyLimitMinutes: 245 },
    { dailyLimitMinutes: null }, { dailyLimitReached: undefined }, { mode: 'other' },
    { usageMinutesToday: -1 }, { usageMinutesToday: Infinity }, { settingsChangeAllowedAt: 'tomorrow' },
  ])('fails closed on malformed daily status: %j', async override => {
    const status = installDailyEngine();
    environment.getStatus.mockResolvedValue({ ...status, ...override });
    const api = await import('./screen-time');
    expect((await api.getScreenTimeStatus()).available).toBe(false);
  });

  it('does not invent iOS usage or say below-limit apps are blocked', async () => {
    const status = installDailyEngine();
    environment.getStatus.mockResolvedValue({ ...status, dailyLimitReached: false, shielded: false, usageMinutesToday: 8 });
    const api = await import('./screen-time');
    expect(await api.getScreenTimeStatus()).toMatchObject({ blockingEnabled: true, shielded: false, usageMinutesToday: null, message: '30-minute limit is on for your apps.' });
  });

  it('does not mistake an Android overlay being hidden inside sumore for a permission failure', async () => {
    environment.os = 'android';
    const status = installDailyEngine(true);
    environment.getStatus.mockResolvedValue({ ...status, shielded: false });
    const api = await import('./screen-time');
    expect(await api.getScreenTimeStatus()).toMatchObject({ dailyLimitReached: true, shielded: false,
      message: 'Your daily limit is reached. Your selected apps will be covered when opened.' });
    environment.getStatus.mockResolvedValue({ ...status, shielded: false, reason: 'Android could not display the app-limit screen.' });
    expect((await api.getScreenTimeStatus()).message).toBe('Android could not display the app-limit screen.');
  });

  it('configures atomically, starts/cancels native stop confirmation, and propagates failures', async () => {
    installDailyEngine();
    const api = await import('./screen-time');
    await api.configureDailyScreenTimeLimit(30);
    expect(environment.engineMethods.configureDailyLimit).toHaveBeenCalledExactlyOnceWith(30);
    expect(environment.engineMethods.setBlockingEnabled).not.toHaveBeenCalled();
    await api.requestScreenTimeDisable();
    await api.cancelScreenTimeDisable();
    expect(environment.engineMethods.requestDisable).toHaveBeenCalledOnce();
    expect(environment.engineMethods.cancelDisable).toHaveBeenCalledOnce();
    environment.engineMethods.requestDisable.mockRejectedValue(new Error('Native failure'));
    await expect(api.requestScreenTimeDisable()).rejects.toThrow('Native failure');
  });

  it.each([0, -1, 1441, 30.5, NaN])('rejects invalid %s-minute budgets before native setup', async minutes => {
    installDailyEngine();
    const api = await import('./screen-time');
    await expect(api.configureDailyScreenTimeLimit(minutes)).rejects.toThrow('Choose 1 to 1,440');
    expect(environment.engineMethods.configureDailyLimit).not.toHaveBeenCalled();
  });

  it('keeps custom/per-app views unavailable on old binaries and does not call missing APIs', async () => {
    installDailyEngine();
    const api = await import('./screen-time');
    expect(await api.getScreenTimeStatus()).toMatchObject({ selectionDisplayAvailable: false, customLimitAvailable: false, perAppLimitsAvailable: false });
    await expect(api.configureDailyScreenTimeLimit(17)).rejects.toThrow('new installed app');
    await expect(api.configurePerAppScreenTimeLimits()).rejects.toThrow('new installed app');
    expect(environment.engineMethods.configureDailyLimit).not.toHaveBeenCalled();
  });

  it('allows exact custom minutes and summed per-app totals only with new native capabilities', async () => {
    const status = installDailyEngine();
    const custom = { ...status, customLimitAvailable: true, selectionDisplayAvailable: true, dailyLimitMinutes: 17 };
    environment.getStatus.mockResolvedValue(custom);
    environment.engineMethods.configureDailyLimit.mockResolvedValue(custom);
    const perApp = { ...custom, limitMode: 'perApp', dailyLimitMinutes: 72000 };
    environment.engineMethods.presentAppLimits = vi.fn().mockResolvedValue(perApp);
    const api = await import('./screen-time');
    expect(await api.configureDailyScreenTimeLimit(17)).toMatchObject({ available: true, customLimitAvailable: true, dailyLimitMinutes: 17 });
    expect(await api.configurePerAppScreenTimeLimits()).toMatchObject({ available: true, perAppLimitsAvailable: true, limitMode: 'perApp', dailyLimitMinutes: 72000 });
    environment.getStatus.mockResolvedValue({ ...perApp, dailyLimitMinutes: 72001 });
    expect((await api.getScreenTimeStatus()).available).toBe(false);
  });

  it('passes Android settings and consent through the installed module', async () => {
    environment.os = 'android';
    installDailyEngine(true);
    const api = await import('./screen-time');
    await api.setScreenTimeDisclosureAccepted(true);
    await api.openScreenTimeUsageSettings();
    await api.openScreenTimeAccessibilitySettings();
    await api.setScreenTimeDisclosureAccepted(false);
    expect(environment.engineMethods.setDisclosureAccepted.mock.calls).toEqual([[true], [false]]);
    expect(environment.engineMethods.openUsageAccessSettings).toHaveBeenCalledOnce();
    expect(environment.engineMethods.openAccessibilitySettings).toHaveBeenCalledOnce();
  });
});

const ready = {
  engineAvailable: true, authorized: true, authorizationStatus: 'approved',
  shielded: true, blockingEnabled: true,
  selection: { applications: 2, categories: 0, webDomains: 0 },
  temporaryAccessExpiresAt: null, appliedGrantId: null,
};

function installEngine() {
  environment.modulePresent = true;
  for (const method of ['requestAuthorization', 'setAccount', 'presentAppPicker', 'setBlockingEnabled', 'clearSelection', 'grantTemporaryAccess']) {
    environment.engineMethods[method] = vi.fn().mockResolvedValue(ready);
  }
  environment.getStatus.mockResolvedValue(ready);
}

describe('Screen Time read coalescing without stale restriction caching', () => {
  it('shares simultaneous reads but fetches again on the next poll', async () => {
    installEngine();
    const pending = Promise.withResolvers<typeof ready>();
    environment.getStatus.mockReturnValueOnce(pending.promise);
    const api = await import('./screen-time');
    const reads = Array.from({ length: 8 }, () => api.getScreenTimeStatus());
    await Promise.resolve();
    expect(environment.getStatus).toHaveBeenCalledTimes(1);
    pending.resolve(ready);
    expect((await Promise.all(reads)).every(status => status.shielded)).toBe(true);
    await api.getScreenTimeStatus();
    expect(environment.getStatus).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed reads', async () => {
    installEngine();
    environment.getStatus.mockRejectedValueOnce(new Error('Busy'));
    const api = await import('./screen-time');
    expect((await Promise.all([api.getScreenTimeStatus(), api.getScreenTimeStatus()])).every(status => !status.available)).toBe(true);
    expect(environment.getStatus).toHaveBeenCalledTimes(1);
    expect((await api.getScreenTimeStatus()).available).toBe(true);
    expect(environment.getStatus).toHaveBeenCalledTimes(2);
  });

  it('rejects a late pre-account-change result and reads fresh native truth', async () => {
    installEngine();
    const pending = Promise.withResolvers<typeof ready>();
    const cleared = { ...ready, blockingEnabled: false, shielded: false,
      selection: { applications: 0, categories: 0, webDomains: 0 } };
    environment.getStatus.mockReturnValueOnce(pending.promise).mockResolvedValue(cleared);
    environment.engineMethods.setAccount.mockResolvedValue(cleared);
    const api = await import('./screen-time');
    const oldRead = api.getScreenTimeStatus();
    await Promise.resolve();
    await api.configureScreenTimeAccount(null);
    pending.resolve(ready);
    expect(await oldRead).toMatchObject({ blockingEnabled: false, selection: cleared.selection });
    expect(environment.getStatus).toHaveBeenCalledTimes(2);
  });

  it('invalidates reads started during a failed native change as well', async () => {
    installEngine();
    const change = Promise.withResolvers<typeof ready>();
    const pending = Promise.withResolvers<typeof ready>();
    environment.engineMethods.setAccount.mockReturnValue(change.promise);
    environment.getStatus.mockReturnValueOnce(pending.promise).mockResolvedValue({ ...ready, authorized: false });
    const api = await import('./screen-time');
    const mutation = api.configureScreenTimeAccount(null);
    const failure = expect(mutation).rejects.toThrow('Native failure');
    const during = api.getScreenTimeStatus();
    await Promise.resolve();
    change.reject(new Error('Native failure'));
    await failure;
    pending.resolve(ready);
    expect(await during).toMatchObject({ authorized: false, shielded: false });
    expect(environment.getStatus).toHaveBeenCalledTimes(2);
  });

  it('uses a single capability read for a custom limit', async () => {
    const daily = installDailyEngine();
    environment.getStatus.mockResolvedValue({ ...daily, customLimitAvailable: true });
    const api = await import('./screen-time');
    await api.configureDailyScreenTimeLimit(17);
    expect(environment.getStatus).toHaveBeenCalledTimes(1);
    expect(environment.engineMethods.configureDailyLimit).toHaveBeenCalledExactlyOnceWith(17);
  });
});

describe('entitled Screen Time adapter', () => {
  it('requires both a complete engine API and the native availability gate', async () => {
    installEngine();
    environment.getStatus.mockResolvedValue({ ...ready, engineAvailable: false });
    const api = await import('./screen-time');
    expect((await api.getScreenTimeStatus()).available).toBe(false);
    await expect(api.selectScreenTimeApps()).rejects.toThrow('not available');
    expect(environment.engineMethods.presentAppPicker).not.toHaveBeenCalled();
  });
  it('does not mistake a partially upgraded module for a ready engine', async () => {
    environment.modulePresent = true;
    environment.getStatus.mockResolvedValue(ready);
    const api = await import('./screen-time');
    expect((await api.getScreenTimeStatus()).available).toBe(false);
  });
  it('reads configured shielding and selection counts from native status', async () => {
    installEngine();
    const api = await import('./screen-time');
    expect(await api.getScreenTimeStatus()).toMatchObject({ available: true, authorized: true, shielded: true, blockingEnabled: true, selection: ready.selection });
  });
  it('keeps saved iOS choices visible while authorization is temporarily undetermined', async () => {
    const saved = installDailyEngine();
    environment.getStatus
      .mockResolvedValueOnce({ ...saved, authorized: false, authorizationStatus: 'notDetermined' })
      .mockResolvedValueOnce({ ...saved, authorized: false, authorizationStatus: 'notDetermined' })
      .mockResolvedValueOnce(saved);
    const api = await import('./screen-time');
    for (let poll = 0; poll < 2; poll++) {
      expect(await api.getScreenTimeStatus()).toMatchObject({
        available: true, authorized: false, authorizationStatus: 'notDetermined',
        selection: saved.selection, dailyLimitMinutes: 30,
        // Saved choices are not evidence of current permission or enforcement.
        blockingEnabled: false, shielded: false,
      });
    }
    expect(await api.getScreenTimeStatus()).toMatchObject({
      authorized: true, selection: saved.selection, dailyLimitMinutes: 30,
      blockingEnabled: true, shielded: true,
    });
    for (const method of Object.values(environment.engineMethods)) expect(method).not.toHaveBeenCalled();
  });
  it('recovers after a failed status read without clearing the saved iOS choices', async () => {
    installEngine();
    environment.getStatus.mockRejectedValueOnce(new Error('Settings are busy')).mockResolvedValueOnce(ready);
    const api = await import('./screen-time');
    expect((await api.getScreenTimeStatus()).available).toBe(false);
    expect(await api.getScreenTimeStatus()).toMatchObject({ available: true, selection: ready.selection });
    for (const method of Object.values(environment.engineMethods)) expect(method).not.toHaveBeenCalled();
  });
  it('fails closed on malformed selection counts', async () => {
    installEngine();
    environment.getStatus.mockResolvedValue({ ...ready, selection: { applications: -1, categories: 0, webDomains: 0 } });
    const api = await import('./screen-time');
    expect((await api.getScreenTimeStatus()).available).toBe(false);
  });
  it('does not report a shield when permission was revoked', async () => {
    installEngine();
    environment.getStatus.mockResolvedValue({ ...ready, authorized: false, authorizationStatus: 'denied' });
    const api = await import('./screen-time');
    expect(await api.getScreenTimeStatus()).toMatchObject({ available: true, authorized: false, shielded: false, blockingEnabled: false });
  });
  it('explains declined Screen Time access without repeating the first request copy', async () => {
    installEngine();
    environment.getStatus.mockResolvedValue({ ...ready, authorized: false, authorizationStatus: 'denied' });
    const api = await import('./screen-time');
    expect((await api.getScreenTimeStatus()).message).toBe('Screen Time access is off, so app limits are unavailable. You can keep using the rest of sumore.');
    environment.getStatus.mockResolvedValue({ ...ready, authorized: false, authorizationStatus: 'notDetermined' });
    expect((await api.getScreenTimeStatus()).message).toBe('Screen Time access is needed to choose apps. Tap Continue to review it.');
  });
  it.each(['denied', 'notDetermined'] as const)('reads actual status after an authorization request ends with %s', async authorizationStatus => {
    installEngine();
    const declined = { ...ready, authorized: false, authorizationStatus };
    environment.getStatus.mockResolvedValue(declined);
    environment.engineMethods.requestAuthorization.mockResolvedValue(authorizationStatus);
    const api = await import('./screen-time');
    expect(await api.requestScreenTimeAuthorization()).toMatchObject({
      available: true, authorized: false, authorizationStatus, blockingEnabled: false, shielded: false,
    });
    expect(environment.engineMethods.requestAuthorization).toHaveBeenCalledTimes(1);
    expect(environment.getStatus).toHaveBeenCalledTimes(2);
  });
  it('preserves genuine authorization failures instead of treating them as consent', async () => {
    installEngine();
    environment.engineMethods.requestAuthorization.mockRejectedValue(new Error('Screen Time is restricted on this device.'));
    const api = await import('./screen-time');
    await expect(api.requestScreenTimeAuthorization()).rejects.toThrow('Screen Time is restricted on this device.');
    expect(environment.engineMethods.requestAuthorization).toHaveBeenCalledTimes(1);
  });
  it('passes explicit disable and clear operations to native without inventing success', async () => {
    installEngine();
    const api = await import('./screen-time');
    await api.setScreenTimeBlocking(false);
    await api.clearScreenTimeSelection();
    expect(environment.engineMethods.setBlockingEnabled).toHaveBeenCalledWith(false);
    expect(environment.engineMethods.clearSelection).toHaveBeenCalledOnce();
    environment.engineMethods.setBlockingEnabled.mockRejectedValue(new Error('Native failure'));
    await expect(api.setScreenTimeBlocking(true)).rejects.toThrow('Native failure');
  });
  it('preserves the native failure reason and allows explicit recovery for corrupt settings', async () => {
    installEngine();
    environment.getStatus.mockResolvedValue({ ...ready, requiresReset: true, reason: 'Clear selection to recover damaged settings.' });
    const api = await import('./screen-time');
    expect(await api.getScreenTimeStatus()).toMatchObject({ available: true, requiresReset: true, blockingEnabled: false, shielded: false, message: 'Clear selection to recover damaged settings.' });
    await api.clearScreenTimeSelection();
    expect(environment.engineMethods.clearSelection).toHaveBeenCalledOnce();
  });
  it.each([
    { authorized: false }, { blockingEnabled: false }, { shielded: true },
    { temporaryAccessExpiresAt: '2000-01-01T12:00:00Z' },
  ])('does not show a stale or unconfirmed approved break: %j', async (override) => {
    installEngine();
    environment.getStatus.mockResolvedValue({ ...ready, shielded: false, temporaryAccessExpiresAt: '2099-01-01T12:00:00Z', appliedGrantId: 'a-grant', ...override });
    const api = await import('./screen-time');
    expect(await api.getScreenTimeStatus()).toMatchObject({ temporaryAccessExpiresAt: null, appliedGrantId: null });
  });
  it('binds and clears the native account explicitly', async () => {
    installEngine();
    const api = await import('./screen-time');
    await api.configureScreenTimeAccount('11111111-1111-4111-8111-111111111111');
    await api.configureScreenTimeAccount(null);
    expect(environment.engineMethods.setAccount.mock.calls).toEqual([['11111111-1111-4111-8111-111111111111'], [null]]);
  });
  it('rejects expired or arbitrary-minute grants before native access', async () => {
    installEngine();
    const api = await import('./screen-time');
    const grant = {
      grantId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', source: 'request' as const, requesterId: '33333333-3333-4333-8333-333333333333',
      startedAt: '2026-09-14T12:00:00Z', expiresAt: '2026-09-14T12:15:00Z', serverNow: '2026-09-14T12:16:00Z',
    };
    await expect(api.applyScreenTimeGrant(grant)).rejects.toThrow('already ended');
    await expect(api.applyScreenTimeGrant({ ...grant, expiresAt: '2026-09-14T12:10:00Z' })).rejects.toThrow('unsupported time window');
    expect(environment.engineMethods.grantTemporaryAccess).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'])('forwards a panic receipt with its null request ID on %s', async os => {
    environment.os = os;
    const status = installDailyEngine(os === 'android');
    const grant = {
      grantId: '11111111-1111-4111-8111-111111111111', requestId: null, source: 'panic' as const,
      requesterId: '33333333-3333-4333-8333-333333333333',
      startedAt: '2099-01-01T12:00:00Z', expiresAt: '2099-01-01T12:15:00Z', serverNow: '2099-01-01T12:00:01Z',
    };
    environment.getStatus.mockResolvedValue({ ...status, supportsPanicGrants: true });
    environment.engineMethods.grantTemporaryAccess.mockResolvedValue({
      ...status, supportsPanicGrants: true, shielded: false,
      appliedGrantId: grant.grantId, appliedRequestId: null, temporaryAccessExpiresAt: grant.expiresAt,
    });
    const api = await import('./screen-time');
    expect(await api.applyScreenTimeGrant(grant)).toMatchObject({
      supportsPanicGrants: true, shielded: false, appliedGrantId: grant.grantId,
      appliedRequestId: null, temporaryAccessExpiresAt: grant.expiresAt,
    });
    expect(environment.engineMethods.grantTemporaryAccess).toHaveBeenCalledExactlyOnceWith(grant);
  });

  it.each([undefined, false, 'true'])('blocks panic on a binary without explicit support (%s)', async supportsPanicGrants => {
    installEngine();
    environment.getStatus.mockResolvedValue({ ...ready, supportsPanicGrants });
    const api = await import('./screen-time');
    expect((await api.getScreenTimeStatus()).supportsPanicGrants).toBe(false);
    await expect(api.applyScreenTimeGrant({
      grantId: '11111111-1111-4111-8111-111111111111', requestId: null, source: 'panic',
      requesterId: '33333333-3333-4333-8333-333333333333',
      startedAt: '2099-01-01T12:00:00Z', expiresAt: '2099-01-01T12:15:00Z', serverNow: '2099-01-01T12:00:01Z',
    })).rejects.toThrow('updated installed app');
    expect(environment.engineMethods.grantTemporaryAccess).not.toHaveBeenCalled();
  });
});
