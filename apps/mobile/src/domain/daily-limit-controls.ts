import type { ScreenTimeStatus } from '@/types/domain';

export const DAILY_LIMIT_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 240] as const;
export const DEFAULT_DAILY_LIMIT = 30;
export const PER_APP_LIMIT_EXPLANATION = 'Each app keeps its own allowance. Unused minutes cannot be borrowed by another app.';

// Keep Accessibility separate from other sensitive-data disclosures. Consent
// must precede either native settings action; Usage Access gets its own step.
export const ANDROID_ACCESS_DISCLOSURE = 'sumore uses Android Accessibility to detect the app currently on screen from app IDs and window-change events, then cover only your selected apps when their limits are reached. It does not read screen content, typing, messages, or passwords. This information stays on this phone and is not sent to your circle or our servers. You can turn off this service in Android Settings.';
export const ANDROID_USAGE_DISCLOSURE = 'Usage Access lets sumore read app IDs and time spent in apps to calculate your daily allowance, including earlier use today. App IDs and detailed usage stay on this phone; your circle only sees the total allowance and any app labels you choose to share. You can revoke Usage Access in Android Settings.';

export function validDailyLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1440;
}

export function remainingDailyTime(status: ScreenTimeStatus): { remaining: number; total: number; fraction: number } | null {
  const total = status.dailyLimitMinutes;
  const used = status.usageMinutesToday;
  if (!status.blockingEnabled || status.mode !== 'daily' || typeof total !== 'number' || !Number.isInteger(total) || total < 1 || total > 72000 ||
    typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  const remaining = Math.max(0, total - used);
  return { remaining, total, fraction: remaining / total };
}

export function androidAccessStep(status: ScreenTimeStatus): 'disclosure' | 'usage' | 'accessibility' | 'ready' {
  if (status.consentGranted !== true) return 'disclosure';
  if (status.usageAccessGranted !== true) return 'usage';
  if (status.accessibilityEnabled !== true) return 'accessibility';
  return 'ready';
}

export function androidAccessibilityStatusLabel(status: ScreenTimeStatus): string {
  if (!status.accessibilityEnabled) return 'needed';
  if (status.accessibilityServiceConnected === false) return 'not connected';
  return status.authorized ? 'on' : 'needs attention';
}

export function androidAccessibilityGuidance(status: ScreenTimeStatus, sdkVersion: number | string): string | null {
  if (!status.consentGranted || !status.usageAccessGranted) return null;
  if (!status.accessibilityEnabled) {
    return Number(sdkVersion) >= 33
      ? 'If Android shows “Restricted setting” for an APK you installed, open Settings → Apps → sumore → ⋮ → Allow restricted settings, only if you trust this install. Then return to Accessibility and enable sumore app limits.'
      : null;
  }
  if (status.accessibilityServiceConnected === false) {
    return 'The Accessibility switch is enabled, but its service is not connected. Turn sumore app limits off and back on in Accessibility settings, then return here and check that your daily limit is enabled.';
  }
  return status.authorized ? null
    : 'Accessibility is enabled in Settings, but blocking is not confirmed. Check sumore app limits in Accessibility settings, then return here to check your daily limit.';
}

export function screenTimeAccessReady(status: ScreenTimeStatus, platform: string): boolean {
  return status.available && !status.requiresReset && status.authorized &&
    (platform !== 'android' || (androidAccessStep(status) === 'ready' && status.accessibilityServiceConnected !== false));
}

export function dailyLimitAmountLabel(minutes: number, mode: ScreenTimeStatus['limitMode']): string {
  return `${minutes} min${mode === 'perApp' ? ' combined' : ''}`;
}

export type ScreenTimeSetupReadiness = {
  title: string;
  summary: string;
  warning: string | null;
  steps: { id: 'access' | 'apps' | 'limit'; label: string; complete: boolean; detail: string }[];
};

export function demoScreenTimeSetupReadiness(selectedApps: number, enabled: boolean): ScreenTimeSetupReadiness {
  return {
    title: 'Daily limit setup', summary: 'App blocking and usage tracking are unavailable in this browser.', warning: null,
    steps: [
      { id: 'apps', label: 'Choose apps', complete: selectedApps > 0, detail: selectedApps > 0 ? 'Your choices are ready.' : 'Choose apps below.' },
      { id: 'limit', label: 'Set a daily allowance', complete: selectedApps > 0 && enabled,
        detail: selectedApps > 0 && enabled ? 'Your allowance is set.' : 'Set your allowance below.' },
    ],
  };
}

/** Derived from the current phone snapshot, never from a remembered setup flag. */
export function screenTimeSetupReadiness(status: ScreenTimeStatus, platform: string, checking = false): ScreenTimeSetupReadiness {
  const usable = !checking && status.available && !status.requiresReset;
  const access = usable && screenTimeAccessReady(status, platform);
  const selected = usable && status.selection.applications + status.selection.categories + status.selection.webDomains > 0;
  const configured = usable && status.blockingEnabled && status.mode === 'daily' &&
    Number.isInteger(status.dailyLimitMinutes) && status.dailyLimitMinutes! > 0 && status.dailyLimitMinutes! <= 72000;
  const enabled = access && selected && configured;
  const result: ScreenTimeSetupReadiness = {
    title: 'Daily limit setup', summary: 'Complete these steps on this phone.', warning: null,
    steps: [
      { id: 'access', label: 'App access', complete: access,
        detail: access ? 'Permission confirmed on this phone.' : checking ? 'Checking phone access…' : 'Needed to limit apps on this phone.' },
      { id: 'apps', label: 'Choose apps', complete: selected,
        detail: selected ? 'App choices are saved on this phone.' : checking ? 'Checking saved choices…' : 'Select the apps you want to limit.' },
      { id: 'limit', label: 'Enable a daily limit', complete: enabled,
        detail: enabled ? 'Daily limit is enabled.' : configured ? 'A limit is saved, but setup needs attention.' : 'Save and enable your allowance below.' },
    ],
  };
  if (checking) return { ...result, title: 'Checking setup…', summary: 'Waiting for this phone’s current settings.' };
  if (!status.available) return { ...result, warning: 'Screen Time is unavailable here. Use a supported installed app on your phone; this screen cannot confirm protection.' };
  if (status.requiresReset) return { ...result, warning: 'Saved Screen Time settings need recovery. Reset the damaged settings below, then choose your apps and enable a limit again.' };
  if (!access) return { ...result, warning: status.blockingEnabled
    ? 'App access is missing or interrupted. Your saved limit cannot be relied on until access is restored below.'
    : 'sumore needs app access before it can limit your apps. See the steps below.' };
  if (status.dailyLimitsAvailable !== true && !configured) return { ...result, warning: 'Daily limits are unavailable in this installed app. Update the app before finishing setup.' };
  if (!selected) return { ...result, warning: status.blockingEnabled ? 'No apps are selected. Choose apps and enable a limit before relying on protection.' : null };
  if (!configured) return { ...result, summary: status.mode === 'manual' && status.blockingEnabled
    ? 'Block-now mode is on. Switch to a daily limit below to finish setup.' : 'Your app choices are saved. Enable a daily limit to finish setup.' };
  if (status.temporaryAccessExpiresAt) return { ...result, title: 'Extra time is active', summary: 'Your daily limit is saved. Blocking resumes when the approved extra time ends.' };
  if (status.shielded) return { ...result, title: 'Daily limit enabled', summary: status.limitMode === 'perApp'
    ? 'Your phone reports blocking for a selected app. Other apps keep their own allowance.'
    : 'Your phone reports that your selected apps are blocked.' };
  return { ...result, title: 'Daily limit enabled', summary: status.dailyLimitReached
    ? 'A limit has been reached. A blocking screen is not currently confirmed; it should appear when a limited app is opened.'
    : 'Apps stay available until their limits are reached. Enabled does not mean blocked right now.' };
}

export function canEditDailyLimit(status: ScreenTimeStatus, platform: string): boolean {
  return screenTimeAccessReady(status, platform) && status.dailyLimitsAvailable === true && !status.blockingEnabled;
}

/** A local clock only updates the label; native code must enforce this deadline. */
export function stopSecondsRemaining(allowedAt: string | null | undefined, now: number): number | null {
  if (!allowedAt || !Number.isFinite(Date.parse(allowedAt))) return null;
  return Math.max(0, Math.ceil((Date.parse(allowedAt) - now) / 1000));
}

export function reportedUsageLabel(status: ScreenTimeStatus): string | null {
  if (typeof status.dailyLimitMinutes !== 'number' || !Number.isInteger(status.dailyLimitMinutes) || status.dailyLimitMinutes < 1 || status.dailyLimitMinutes > 72000 || typeof status.usageMinutesToday !== 'number' ||
    !Number.isFinite(status.usageMinutesToday) || status.usageMinutesToday < 0) return null;
  return status.limitMode === 'perApp'
    ? `${Math.floor(status.usageMinutesToday)} min used across apps · ${dailyLimitAmountLabel(status.dailyLimitMinutes, status.limitMode)} allowance`
    : `${Math.floor(status.usageMinutesToday)} of ${status.dailyLimitMinutes} min used in your apps today`;
}

export function dailyLimitSummary(status: ScreenTimeStatus): string {
  if (!status.available || status.requiresReset) return status.message;
  if (!status.authorized) return status.message || 'Permission needed.';
  if (!status.blockingEnabled) return 'Your daily limit is off.';
  if (status.temporaryAccessExpiresAt) return 'Extra time is active.';
  if (status.mode !== 'daily') return 'Block-now mode is active.';
  if (status.dailyLimitReached) return status.limitMode === 'perApp' ? 'An app reached its limit. Other apps keep their remaining time.' : status.shielded ? 'Daily limit reached. Your apps are blocked.' : status.message;
  return status.shielded ? status.message : 'Your daily limit is active.';
}
