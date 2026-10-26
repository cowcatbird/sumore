/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { ScreenTimeStatus } from '@/types/domain';
import { ANDROID_ACCESS_DISCLOSURE, ANDROID_USAGE_DISCLOSURE, DAILY_LIMIT_OPTIONS, DEFAULT_DAILY_LIMIT, PER_APP_LIMIT_EXPLANATION, androidAccessibilityGuidance, androidAccessibilityStatusLabel, androidAccessStep, canEditDailyLimit, dailyLimitAmountLabel, dailyLimitSummary, demoScreenTimeSetupReadiness, reportedUsageLabel, screenTimeSetupReadiness, stopSecondsRemaining, validDailyLimit } from './daily-limit-controls';

const ready: ScreenTimeStatus = {
  available: true, dailyLimitsAvailable: true, authorized: true, shielded: false, blockingEnabled: false,
  selection: { applications: 2, categories: 0, webDomains: 0 }, mode: 'daily', dailyLimitMinutes: 30, dailyLimitReached: false,
  usageMinutesToday: null, usageAccessGranted: true, accessibilityEnabled: true, consentGranted: true,
  temporaryAccessExpiresAt: null, appliedGrantId: null, authorizationStatus: 'approved', message: 'Native status',
};

describe('daily limit setup controls', () => {
  it('offers personal-limit presets with a 30-minute default and validates native bounds', () => {
    expect(DEFAULT_DAILY_LIMIT).toBe(30);
    expect(DAILY_LIMIT_OPTIONS).toEqual([15, 30, 45, 60, 90, 120, 180, 240]);
    expect(DAILY_LIMIT_OPTIONS.every(validDailyLimit)).toBe(true);
    expect(validDailyLimit(35)).toBe(true);
    for (const value of [1, 14, 16, 245, 1440]) expect(validDailyLimit(value)).toBe(true);
    for (const value of [undefined, null, 0, 30.5, 1441, Number.NaN, Infinity, '30']) expect(validDailyLimit(value)).toBe(false);
  });

  it('requires disclosure before either Android permission, even if OS access already exists', () => {
    expect(androidAccessStep({ ...ready, consentGranted: false })).toBe('disclosure');
    expect(androidAccessStep({ ...ready, consentGranted: undefined })).toBe('disclosure');
    expect(androidAccessStep({ ...ready, usageAccessGranted: false })).toBe('usage');
    expect(androidAccessStep({ ...ready, accessibilityEnabled: false })).toBe('accessibility');
    expect(androidAccessStep(ready)).toBe('ready');
    for (const phrase of ['Accessibility', 'app IDs and window-change events', 'when their limits are reached', 'does not read screen content', 'stays on this phone', 'not sent to your circle or our servers', 'turn off this service']) expect(ANDROID_ACCESS_DISCLOSURE).toContain(phrase);
    expect(ANDROID_ACCESS_DISCLOSURE).not.toContain('Usage Access');
    expect(ANDROID_USAGE_DISCLOSURE).toContain('app IDs and time spent in apps');
    expect(ANDROID_USAGE_DISCLOSURE).toContain('App IDs and detailed usage stay on this phone');
    expect(ANDROID_USAGE_DISCLOSURE).not.toContain('Accessibility');
  });

  it.each([
    { available: false }, { dailyLimitsAvailable: false }, { dailyLimitsAvailable: undefined }, { authorized: false },
    { blockingEnabled: true }, { requiresReset: true }, { consentGranted: false }, { usageAccessGranted: false }, { accessibilityEnabled: false }, { accessibilityServiceConnected: false },
  ])('forbids Android selection/budget edits while active, unsupported or missing access: %o', change => {
    expect(canEditDailyLimit({ ...ready, ...change }, 'android')).toBe(false);
  });

  it('does not require Android permissions on iOS but still requires explicit Screen Time authorization', () => {
    expect(canEditDailyLimit({ ...ready, consentGranted: undefined, usageAccessGranted: undefined, accessibilityEnabled: undefined }, 'ios')).toBe(true);
    expect(canEditDailyLimit({ ...ready, authorized: false }, 'ios')).toBe(false);
  });

  it('distinguishes a configured Accessibility switch from a running service', () => {
    const disconnected = { ...ready, authorized: false, accessibilityServiceConnected: false };
    expect(androidAccessibilityStatusLabel(disconnected)).toBe('not connected');
    expect(androidAccessibilityGuidance(disconnected, 33)).toContain('off and back on');
    expect(androidAccessibilityGuidance(disconnected, 33)).toContain('check that your daily limit is enabled');
    expect(androidAccessibilityStatusLabel({ ...ready, authorized: false })).toBe('needs attention');
    expect(androidAccessibilityStatusLabel({ ...ready, accessibilityEnabled: false })).toBe('needed');
    expect(androidAccessibilityStatusLabel(ready)).toBe('on');
    expect(androidAccessibilityGuidance(ready, 33)).toBeNull();
  });

  it('shows conditional sideload troubleshooting only at the Android 13+ Accessibility step', () => {
    const needsAccessibility = { ...ready, authorized: false, accessibilityEnabled: false };
    for (const version of [33, 34, '36']) {
      expect(androidAccessibilityGuidance(needsAccessibility, version)).toContain('If Android shows “Restricted setting”');
      expect(androidAccessibilityGuidance(needsAccessibility, version)).toContain('only if you trust this install');
    }
    for (const version of [24, 32, 'unknown']) expect(androidAccessibilityGuidance(needsAccessibility, version)).toBeNull();
    expect(androidAccessibilityGuidance({ ...needsAccessibility, consentGranted: false }, 33)).toBeNull();
    expect(androidAccessibilityGuidance({ ...needsAccessibility, usageAccessGranted: false }, 33)).toBeNull();
  });

  it('never fabricates a usage meter when native returns null or malformed data', () => {
    for (const usageMinutesToday of [null, undefined, Number.NaN, Infinity, -1]) expect(reportedUsageLabel({ ...ready, usageMinutesToday })).toBeNull();
    expect(reportedUsageLabel({ ...ready, usageMinutesToday: 12.4 })).toBe('12 of 30 min used in your apps today');
    expect(reportedUsageLabel({ ...ready, usageMinutesToday: 42 })).toBe('42 of 30 min used in your apps today');
  });

  it('uses only a real native stop deadline and rounds up the countdown', () => {
    const now = Date.parse('2026-09-15T12:00:00Z');
    for (const deadline of [null, undefined, '', 'not a date']) expect(stopSecondsRemaining(deadline, now)).toBeNull();
    expect(stopSecondsRemaining('2026-09-15T12:00:30Z', now)).toBe(30);
    expect(stopSecondsRemaining('2026-09-15T12:00:30Z', now + 29_999)).toBe(1);
    expect(stopSecondsRemaining('2026-09-15T12:00:30Z', now + 30_000)).toBe(0);
  });

  it('distinguishes active budgets, confirmed shields, approved breaks, and old manual mode', () => {
    expect(dailyLimitSummary({ ...ready, blockingEnabled: true })).toBe('Your daily limit is active.');
    expect(dailyLimitSummary({ ...ready, blockingEnabled: true, dailyLimitReached: true })).toBe(ready.message);
    expect(dailyLimitSummary({ ...ready, blockingEnabled: true, dailyLimitReached: true, shielded: true })).toContain('Your apps are blocked');
    expect(dailyLimitSummary({ ...ready, blockingEnabled: true, temporaryAccessExpiresAt: '2026-09-15T12:15:00Z' })).toBe('Extra time is active.');
    expect(dailyLimitSummary({ ...ready, blockingEnabled: true, mode: 'manual' })).toContain('Block-now mode');
    expect(dailyLimitSummary({ ...ready, requiresReset: true })).toBe(ready.message);
  });

  it('keeps explicit enable/stop/recovery controls and a consistent neutral section heading', () => {
    const ui = readFileSync(new URL('../components/screen-time-controls.tsx', import.meta.url), 'utf8');
    expect(ui).toContain('<SectionHeading title="Daily app limit"');
    expect(ui).not.toContain('BlanketBand');
    expect(ui).toContain('Save & enable daily limit');
    expect(ui).toContain('label="Confirm stop" busy={busy} run={run} action={() => setScreenTimeBlocking(false)} disabled={stopSeconds > 0}');
    expect(ui).toContain('label="Keep limit" busy={busy} run={run} action={cancelScreenTimeDisable}');
    expect(ui).not.toContain('setScreenTimeBlocking(true)');
    expect(ui).toContain('Recovery also stops blocking.');
    expect(ui).toContain('status.dailyUsageNote');
    expect(ui).toContain('generation.current === expectedGeneration');
    expect(ui).toContain('operation.current === expectedOperation');
  });

  it('makes the personal combined-app limit clear in both setup and active states', () => {
    const ui = readFileSync(new URL('../components/screen-time-controls.tsx', import.meta.url), 'utf8');
    expect(ui).toContain("Your daily limit: {dailyLimitAmountLabel(budget, 'shared')}");
    expect(ui).toContain('Your daily limit: {dailyLimitAmountLabel(status.dailyLimitMinutes, status.limitMode)}');
    expect(ui.match(/Total across your selected apps\./g)).toHaveLength(1);
    expect(ui).toContain('minutes per day across your selected apps');
    // The internal mode is named "shared"; visible copy must not imply that
    // friends share the same phone allowance.
    expect(ui).not.toMatch(/(?:>Shared (?:budget|limit)|['"]Shared (?:budget|limit)['"])/i);
    expect(ui).toContain('Your limit totals time across your selected apps, not your circle.');
    expect(dailyLimitSummary(ready)).toBe('Your daily limit is off.');
  });

  it('keeps the native service failure visible and offers recovery when Android permissions look enabled', () => {
    const disconnected = { ...ready, authorized: false, message: 'Accessibility is enabled but the service is not connected.' };
    expect(androidAccessStep(disconnected)).toBe('ready');
    expect(canEditDailyLimit(disconnected, 'android')).toBe(false);
    expect(dailyLimitSummary(disconnected)).toBe(disconnected.message);
    const ui = readFileSync(new URL('../components/screen-time-controls.tsx', import.meta.url), 'utf8');
    expect(ui).toContain('accessStep === \'ready\' && !status.authorized');
    expect(ui).toContain('label="Reopen Accessibility settings" busy={busy} run={run} action={openScreenTimeAccessibilitySettings}');
  });

  it('does not stack slow native reads from interval and foreground refreshes', () => {
    const ui = readFileSync(new URL('../components/screen-time-controls.tsx', import.meta.url), 'utf8');
    const focus = ui.slice(ui.indexOf('  useFocusEffect('), ui.indexOf('  useEffect('));
    expect(focus).toContain('let refreshing = false;');
    expect(focus).toContain("if (!active || submitting.current || refreshing || (AppState.currentState && AppState.currentState !== 'active')) return;");
    expect(focus.indexOf('refreshing = true;')).toBeLessThan(focus.indexOf('getScreenTimeStatus()'));
    expect(focus.match(/getScreenTimeStatus\(\)/g)).toHaveLength(1);
    expect(focus).toMatch(/\.finally\(\(\) => \{\s*refreshing = false;\s*\}\)/);
    expect(focus).toContain('active && owner.current === userId && generation.current === expectedGeneration && operation.current === expectedOperation');
    expect(focus).toContain("if (value === 'active') refresh()");
    expect(focus).toContain('setInterval(refresh, 3_000)');
    expect(focus).toContain('active = false; sub.remove(); clearInterval(timer);');
  });
});

describe('current-device setup readiness', () => {
  const active = { ...ready, blockingEnabled: true };
  const completed = (value: ReturnType<typeof screenTimeSetupReadiness>) => value.steps.filter(step => step.complete).map(step => step.id);

  it('starts with checking, not a fabricated success or failure', () => {
    const state = screenTimeSetupReadiness(active, 'ios', true);
    expect(state.title).toBe('Checking setup…');
    expect(completed(state)).toEqual([]);
    expect(state.warning).toBeNull();
  });

  it('shows selection and permission as ready while the allowance still needs enabling', () => {
    const state = screenTimeSetupReadiness(ready, 'ios');
    expect(completed(state)).toEqual(['access', 'apps']);
    expect(state.summary).toContain('Enable a daily limit');
  });

  it('requires selections and a valid enabled daily limit, not block-now mode or stale saved minutes', () => {
    for (const change of [{ blockingEnabled: false }, { mode: 'manual' as const }, { dailyLimitMinutes: null }, { dailyLimitMinutes: 0 },
      { dailyLimitMinutes: Number.NaN }, { dailyLimitMinutes: 72001 }, { selection: { applications: 0, categories: 0, webDomains: 0 } }]) {
      expect(completed(screenTimeSetupReadiness({ ...active, ...change }, 'ios'))).not.toContain('limit');
    }
    expect(completed(screenTimeSetupReadiness({ ...active, dailyLimitMinutes: 72000, limitMode: 'perApp' }, 'ios'))).toContain('limit');
    for (const selection of [{ applications: 0, categories: 1, webDomains: 0 }, { applications: 0, categories: 0, webDomains: 1 }]) {
      expect(completed(screenTimeSetupReadiness({ ...active, selection }, 'ios'))).toEqual(['access', 'apps', 'limit']);
    }
  });

  it('does not confuse under-budget monitoring with active blocking', () => {
    const state = screenTimeSetupReadiness(active, 'ios');
    expect(completed(state)).toEqual(['access', 'apps', 'limit']);
    expect(state.title).toBe('Daily limit enabled');
    expect(state.summary).toContain('Apps stay available until their limits are reached.');
    expect(state.summary).toContain('Enabled does not mean blocked right now.');
    expect(state.warning).toBeNull();
    expect(screenTimeSetupReadiness({ ...active, dailyLimitReached: true }, 'android').summary).toContain('not currently confirmed');
    expect(screenTimeSetupReadiness({ ...active, shielded: true }, 'ios').summary).toContain('your selected apps are blocked');
    expect(screenTimeSetupReadiness({ ...active, shielded: true, limitMode: 'perApp' }, 'android').summary).toContain('Other apps keep their own allowance');
    expect(screenTimeSetupReadiness({ ...active, temporaryAccessExpiresAt: '2026-09-29T12:30:00Z' }, 'ios').title).toBe('Extra time is active');
  });

  it.each([{ authorized: false }, { consentGranted: false }, { usageAccessGranted: false }, { accessibilityEnabled: false }])('removes the ready state when Android access is missing: %o', change => {
    const state = screenTimeSetupReadiness({ ...active, ...change }, 'android');
    expect(completed(state)).toEqual(['apps']);
    expect(state.warning).toContain('cannot be relied on until access is restored');
    expect(state.steps[2].detail).toContain('setup needs attention');
  });

  it('handles revoked iOS authorization and rechecks a previously complete setup from current state', () => {
    expect(completed(screenTimeSetupReadiness(active, 'ios'))).toHaveLength(3);
    expect(completed(screenTimeSetupReadiness({ ...active, authorized: false }, 'ios'))).toEqual(['apps']);
    expect(completed(screenTimeSetupReadiness({ ...active, consentGranted: undefined, usageAccessGranted: undefined, accessibilityEnabled: undefined }, 'ios'))).toHaveLength(3);
  });

  it('does not trust stale selection/enabled flags when native settings need reset or are unavailable', () => {
    for (const change of [{ available: false }, { requiresReset: true }]) {
      const state = screenTimeSetupReadiness({ ...active, ...change }, 'ios');
      expect(completed(state)).toEqual([]);
      expect(state.warning).toBeTruthy();
      expect(state.title).not.toBe('Daily limit enabled');
    }
    expect(screenTimeSetupReadiness({ ...ready, dailyLimitsAvailable: false }, 'ios').warning).toContain('Update the app');
    expect(screenTimeSetupReadiness({ ...active, requiresReset: true }, 'ios').warning).toContain('Reset the damaged settings');
  });

  it('labels independent allowances as combined without suggesting time can be borrowed', () => {
    expect(dailyLimitAmountLabel(90, 'perApp')).toBe('90 min combined');
    expect(dailyLimitAmountLabel(90, 'shared')).toBe('90 min');
    expect(PER_APP_LIMIT_EXPLANATION).toContain('Unused minutes cannot be borrowed');
    expect(reportedUsageLabel({ ...active, limitMode: 'perApp', dailyLimitMinutes: 90, usageMinutesToday: 10 })).toBe('10 min used across apps · 90 min combined allowance');
  });

  it('keeps demo checklist completion separate from real permission/enforcement claims', () => {
    const empty = demoScreenTimeSetupReadiness(0, false);
    expect(empty.title).toBe('Daily limit setup');
    expect(completed(empty)).toEqual([]);
    expect(empty.summary).toBe('App blocking and usage tracking are unavailable in this browser.');
    expect(completed(demoScreenTimeSetupReadiness(3, false))).toEqual(['apps']);
    expect(demoScreenTimeSetupReadiness(3, true).steps[1].detail).toBe('Your allowance is set.');
    expect(completed(demoScreenTimeSetupReadiness(0, true))).not.toContain('limit');
  });
});
