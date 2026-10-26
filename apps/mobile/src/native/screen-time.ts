import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import { parseScreenTimeGrant, type ScreenTimeGrant } from '@/domain/screen-time-grants';
import type { ScreenTimeStatus } from '@/types/domain';

type NativeStatus = Partial<Omit<ScreenTimeStatus, 'available' | 'message'>> & {
  engineAvailable?: boolean;
  reason?: string | null;
};
type NativeScreenTimeModule = {
  requestAuthorization(): Promise<string>;
  getStatus(): Promise<NativeStatus>;
  setAccount?(userId: string | null): Promise<NativeStatus>;
  presentAppPicker?(): Promise<NativeStatus>;
  presentAppLimits?(): Promise<NativeStatus>;
  setBlockingEnabled?(enabled: boolean): Promise<NativeStatus>;
  clearSelection?(): Promise<NativeStatus>;
  grantTemporaryAccess?(input: ScreenTimeGrant): Promise<NativeStatus>;
  configureDailyLimit?(minutes: number): Promise<NativeStatus>;
  requestDisable?(): Promise<NativeStatus>;
  cancelDisable?(): Promise<NativeStatus>;
  openUsageAccessSettings?(): Promise<NativeStatus>;
  openAccessibilitySettings?(): Promise<NativeStatus>;
  setDisclosureAccepted?(accepted: boolean): Promise<NativeStatus>;
};

const nativeModule = Platform.OS === 'ios' || Platform.OS === 'android'
  ? requireOptionalNativeModule<NativeScreenTimeModule>('ScreenTimeModule') : null;

// Camp, Screen Time and grant reconciliation can ask at the same moment. Share
// only an in-flight read, never a time-based cache of permissions or limits.
let pendingStatus: Promise<NativeStatus> | null = null;
let statusRevision = 0;

function invalidateStatusRead() {
  statusRevision += 1;
  pendingStatus = null;
}

async function changedStatus(change: () => Promise<NativeStatus>): Promise<ScreenTimeStatus> {
  invalidateStatusRead();
  try { return toStatus(await change()); }
  finally { invalidateStatusRead(); }
}

export function unavailableScreenTimeStatus(message?: string): ScreenTimeStatus {
  return {
    available: false, authorized: false, shielded: false, blockingEnabled: false,
    supportsPanicGrants: false,
    dailyLimitsAvailable: false, mode: 'manual', dailyLimitMinutes: null,
    dailyLimitReached: false, usageMinutesToday: null, settingsChangeAllowedAt: null,
    usageAccessGranted: false, accessibilityEnabled: false, accessibilityServiceConnected: false, consentGranted: false,
    selection: { applications: 0, categories: 0, webDomains: 0 },
    temporaryAccessExpiresAt: null, appliedGrantId: null, authorizationStatus: 'unavailable',
    message: message ?? (Platform.OS === 'ios'
      ? 'App blocking is not available in this installed version. It needs Apple’s Family Controls distribution approval and a new signed iPhone build with the Screen Time extension.'
      : Platform.OS === 'android'
        ? 'App blocking needs the new Android build. Expo Go and older builds cannot block apps.'
        : 'App blocking and unlocking require the installed app on your phone.'),
  };
}

function toStatus(raw: NativeStatus): ScreenTimeStatus {
  // Old builds contain an authorization-only stub. Permission alone must not
  // be confused with an entitled, installed restriction engine.
  const dailyLimitsAvailable = !!nativeModule &&
    ['configureDailyLimit', 'requestDisable', 'cancelDisable'].every(key =>
      typeof nativeModule[key as keyof NativeScreenTimeModule] === 'function');
  const androidMethodsAvailable = Platform.OS !== 'android' || (dailyLimitsAvailable && !!nativeModule &&
    ['openUsageAccessSettings', 'openAccessibilitySettings', 'setDisclosureAccepted'].every(key =>
      typeof nativeModule[key as keyof NativeScreenTimeModule] === 'function'));
  const hasEngine = raw.engineAvailable === true && nativeModule && androidMethodsAvailable &&
    ['setAccount', 'presentAppPicker', 'setBlockingEnabled', 'clearSelection', 'grantTemporaryAccess']
      .every(key => typeof nativeModule[key as keyof NativeScreenTimeModule] === 'function');
  if (!hasEngine) return { ...unavailableScreenTimeStatus(typeof raw.reason === 'string' ? raw.reason : undefined), authorized: raw.authorized === true };
  const selection = raw.selection;
  if (!selection || Object.values(selection).length !== 3 ||
    !['applications', 'categories', 'webDomains'].every(key => {
      const count = selection[key as keyof typeof selection];
      return Number.isSafeInteger(count) && count >= 0;
    })) throw new Error('Screen Time returned an incomplete selection status.');
  const daily = raw.mode === 'daily';
  const minutes = raw.dailyLimitMinutes;
  const invalidMinutes = minutes != null && (!Number.isInteger(minutes) || minutes < 1 || minutes > (raw.limitMode === 'perApp' ? 72000 : 1440) ||
    (raw.customLimitAvailable !== true && raw.limitMode !== 'perApp' && (minutes < 15 || minutes > 240 || minutes % 5 !== 0)));
  if ((raw.mode !== undefined && raw.mode !== 'manual' && raw.mode !== 'daily') || invalidMinutes ||
    (raw.limitMode !== undefined && raw.limitMode !== 'shared' && raw.limitMode !== 'perApp') ||
    (raw.limitMode === 'perApp' && typeof nativeModule.presentAppLimits !== 'function') ||
    (daily && (!dailyLimitsAvailable || (raw.blockingEnabled === true && minutes == null) || typeof raw.dailyLimitReached !== 'boolean')) ||
    (raw.usageMinutesToday != null && (!Number.isFinite(raw.usageMinutesToday) || raw.usageMinutesToday < 0)) ||
    (raw.settingsChangeAllowedAt != null && (typeof raw.settingsChangeAllowedAt !== 'string' || !Number.isFinite(Date.parse(raw.settingsChangeAllowedAt))))) {
    throw new Error('Screen Time returned an incomplete daily-limit status.');
  }
  const usageAccessGranted = raw.usageAccessGranted === true;
  const accessibilityEnabled = raw.accessibilityEnabled === true;
  const consentGranted = raw.consentGranted === true;
  // Older native builds do not expose this field. Their authorized flag still
  // includes connection readiness; a new explicit false must never look ready.
  const accessibilityServiceConnected = typeof raw.accessibilityServiceConnected === 'boolean'
    ? raw.accessibilityServiceConnected : undefined;
  const authorized = raw.authorized === true && (Platform.OS !== 'android' ||
    (usageAccessGranted && accessibilityEnabled && accessibilityServiceConnected !== false && consentGranted));
  const requiresReset = raw.requiresReset === true;
  const enabled = authorized && !requiresReset && raw.blockingEnabled === true;
  const temporaryAccessExpiresAt = enabled && !raw.shielded && typeof raw.temporaryAccessExpiresAt === 'string' && Date.parse(raw.temporaryAccessExpiresAt) > Date.now()
    ? raw.temporaryAccessExpiresAt : null;
  const count = selection.applications + selection.categories + selection.webDomains;
  return {
    available: true, authorized, blockingEnabled: enabled, requiresReset,
    supportsPanicGrants: raw.supportsPanicGrants === true,
    dailyLimitsAvailable, mode: daily ? 'daily' : 'manual',
    perAppLimitsAvailable: typeof nativeModule.presentAppLimits === 'function',
    customLimitAvailable: raw.customLimitAvailable === true,
    selectionDisplayAvailable: raw.selectionDisplayAvailable === true,
    reportAvailable: raw.reportAvailable === true,
    limitMode: raw.limitMode === 'perApp' ? 'perApp' : 'shared',
    allocatedMinutes: minutes ?? null,
    dailyLimitMinutes: minutes ?? null, dailyLimitReached: daily && raw.dailyLimitReached === true,
    dailyUsageNote: daily && typeof raw.dailyUsageNote === 'string' ? raw.dailyUsageNote : null,
    usageMinutesToday: Platform.OS === 'ios' ? null : raw.usageMinutesToday ?? null,
    usageAccessGranted, accessibilityEnabled, accessibilityServiceConnected, consentGranted,
    settingsChangeAllowedAt: enabled ? raw.settingsChangeAllowedAt ?? null : null,
    shielded: enabled && raw.shielded === true,
    selection, temporaryAccessExpiresAt,
    appliedGrantId: temporaryAccessExpiresAt && typeof raw.appliedGrantId === 'string' ? raw.appliedGrantId : null,
    appliedRequestId: temporaryAccessExpiresAt && typeof raw.appliedRequestId === 'string' ? raw.appliedRequestId : null,
    authorizationStatus: authorized ? 'approved' : raw.authorizationStatus === 'denied' ? 'denied' : 'notDetermined',
    message: requiresReset ? (raw.reason || 'Screen Time settings could not be read. Clear app selection to reset this device’s settings.')
      : !authorized ? (Platform.OS === 'android' ? (raw.reason || 'Enable Usage Access and Accessibility after reviewing the permissions.') : raw.authorizationStatus === 'denied'
        ? 'Screen Time access is off, so app limits are unavailable. You can keep using the rest of sumore.'
        : 'Screen Time access is needed to choose apps. Tap Continue to review it.')
      : !count ? 'Choose the apps you want to limit.'
        : !enabled ? 'Your app choices are saved.'
          : temporaryAccessExpiresAt ? 'Your extra time is active.'
            : raw.shielded ? 'Your daily limit is reached. Ask your circle for time.'
              : daily && !raw.dailyLimitReached ? `${minutes}-minute limit is on for your apps.`
                : Platform.OS === 'android' && daily && !raw.reason ? 'Your daily limit is reached. Your selected apps will be covered when opened.'
                : (raw.reason || 'The device has not confirmed blocking. Check app permissions.'),
  };
}

export async function getScreenTimeStatus(): Promise<ScreenTimeStatus> {
  if (!nativeModule) return unavailableScreenTimeStatus();
  const revision = statusRevision;
  let request: Promise<NativeStatus> | null = null;
  try {
    request = pendingStatus ??= Promise.resolve().then(() => nativeModule.getStatus());
    const raw = await request;
    // A concurrent edit/account switch makes the older result observationally
    // stale. Read again rather than returning the pre-change restriction state.
    if (revision !== statusRevision) return getScreenTimeStatus();
    return toStatus(raw);
  }
  catch {
    if (revision !== statusRevision) return getScreenTimeStatus();
    return unavailableScreenTimeStatus('Screen Time status could not be read. Previously enabled restrictions may still be active. Reopen sumore or manage its permissions in phone Settings.');
  }
  finally { if (pendingStatus === request) pendingStatus = null; }
}

async function requireEngine() {
  const status = await getScreenTimeStatus();
  if (!nativeModule || !status.available) throw new Error(status.message);
  return nativeModule;
}

export async function configureScreenTimeAccount(userId: string | null): Promise<ScreenTimeStatus> {
  if (!nativeModule?.setAccount) return getScreenTimeStatus();
  return changedStatus(() => nativeModule.setAccount!(userId));
}

export async function requestScreenTimeAuthorization(): Promise<ScreenTimeStatus> {
  const engine = await requireEngine();
  return changedStatus(async () => {
    await engine.requestAuthorization();
    return engine.getStatus();
  });
}

export async function selectScreenTimeApps(): Promise<ScreenTimeStatus> {
  const engine = await requireEngine();
  return changedStatus(() => engine.presentAppPicker!());
}

export async function setScreenTimeBlocking(enabled: boolean): Promise<ScreenTimeStatus> {
  const engine = await requireEngine();
  return changedStatus(() => engine.setBlockingEnabled!(enabled));
}

export async function clearScreenTimeSelection(): Promise<ScreenTimeStatus> {
  const engine = await requireEngine();
  return changedStatus(() => engine.clearSelection!());
}

async function requireDailyEngine() {
  const status = await getScreenTimeStatus();
  if (!nativeModule || !status.available || !status.dailyLimitsAvailable) {
    throw new Error('Daily limits need the new installed app build.');
  }
  return { engine: nativeModule, status };
}

export async function configureDailyScreenTimeLimit(minutes: number): Promise<ScreenTimeStatus> {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error('Choose 1 to 1,440 whole minutes.');
  }
  const { engine, status } = await requireDailyEngine();
  if ((minutes < 15 || minutes > 240 || minutes % 5 !== 0) && status.customLimitAvailable !== true) {
    throw new Error('Custom time needs the new installed app build.');
  }
  return changedStatus(() => engine.configureDailyLimit!(minutes));
}

export async function configurePerAppScreenTimeLimits(): Promise<ScreenTimeStatus> {
  const { engine } = await requireDailyEngine();
  if (!engine.presentAppLimits) throw new Error('Separate app limits need the new installed app build.');
  return changedStatus(() => engine.presentAppLimits!());
}

export async function requestScreenTimeDisable(): Promise<ScreenTimeStatus> {
  const { engine } = await requireDailyEngine();
  return changedStatus(() => engine.requestDisable!());
}

export async function cancelScreenTimeDisable(): Promise<ScreenTimeStatus> {
  const { engine } = await requireDailyEngine();
  return changedStatus(() => engine.cancelDisable!());
}

async function requireAndroidEngine() {
  if (Platform.OS !== 'android') throw new Error('These permissions are only needed on Android.');
  return requireDailyEngine();
}

export async function openScreenTimeUsageSettings(): Promise<ScreenTimeStatus> {
  const { engine } = await requireAndroidEngine();
  return changedStatus(() => engine.openUsageAccessSettings!());
}

export async function openScreenTimeAccessibilitySettings(): Promise<ScreenTimeStatus> {
  const { engine } = await requireAndroidEngine();
  return changedStatus(() => engine.openAccessibilitySettings!());
}

export async function setScreenTimeDisclosureAccepted(accepted: boolean): Promise<ScreenTimeStatus> {
  const { engine } = await requireAndroidEngine();
  return changedStatus(() => engine.setDisclosureAccepted!(accepted));
}

export async function applyScreenTimeGrant(receipt: ScreenTimeGrant): Promise<ScreenTimeStatus> {
  const grant = parseScreenTimeGrant(receipt);
  if (Date.parse(grant.expiresAt) <= Date.parse(grant.serverNow)) throw new Error('This approved time has already ended.');
  const engine = await requireEngine();
  if (grant.source === 'panic' && (await getScreenTimeStatus()).supportsPanicGrants !== true) {
    throw new Error('Panic access needs the updated installed app. No apps were unlocked.');
  }
  return changedStatus(() => engine.grantTemporaryAccess!(grant));
}
