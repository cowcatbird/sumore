import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScreenTimeStatus } from '@/types/domain';
import { ScreenTimeControls } from './screen-time-controls';

type Button = { accessibilityLabel?: string; disabled?: boolean; onPress: () => void; children?: ReactNode;
  style?: (state: { pressed: boolean }) => Record<string, unknown> | (Record<string, unknown> | false)[] };
type EffectSlot = { deps?: readonly unknown[]; cleanup?: () => void };
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, layouts: [] as (() => void)[], effects: [] as (() => void)[],
  buttons: new Map<string, Button>(), profileId: 'owner-a', nativeStatus: {} as ScreenTimeStatus,
  focus: null as (() => void | (() => void)) | null, focusCleanup: null as (() => void) | null,
  appListeners: new Set<(state: string) => void>(), appState: 'active', platform: 'ios', sdkVersion: 36,
  read: vi.fn(), bind: vi.fn(), configure: vi.fn(), disable: vi.fn(), publish: vi.fn(), onStatus: vi.fn(), openAccessibility: vi.fn(), openUsage: vi.fn(), disclosure: vi.fn(), authorize: vi.fn(),
}));

// Executes actual control handlers and effects using the repository's explicit
// SSR/hook-slot pattern. Native and network operations are controllable promises;
// this is lifecycle/concurrency evidence, not a device rendering benchmark.
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const effect = (queue: (() => void)[]) => (callback: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = h.cursor++;
    const previous = h.slots[index] as EffectSlot | undefined;
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      queue.push(() => {
        previous?.cleanup?.();
        const cleanup = callback();
        h.slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
      });
    }
  };
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [h.slots[index], (next: unknown) => { h.slots[index] = typeof next === 'function' ? next(h.slots[index]) : next; }];
    },
    useRef: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = { current: initial };
      return h.slots[index];
    },
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(h.layouts)(callback, deps),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(h.effects)(callback, deps),
  };
});
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  Pressable: (props: Button) => {
    if (props.accessibilityLabel) h.buttons.set(props.accessibilityLabel, props);
    return createElement('button', { disabled: props.disabled }, props.children);
  },
  ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel: string }) => createElement('span', null, accessibilityLabel),
  StyleSheet: { create: (value: unknown) => value }, Platform: { get OS() { return h.platform; }, get Version() { return h.sdkVersion; } },
  AppState: {
    get currentState() { return h.appState; },
    addEventListener: (_: string, listener: (state: string) => void) => {
      h.appListeners.add(listener); return { remove: () => h.appListeners.delete(listener) };
    },
  },
}));
vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
  useFocusEffect: (callback: () => void | (() => void)) => { h.focus = callback; },
}));
vi.mock('@/features/app-store', () => ({ useApp: () => ({ profile: { id: h.profileId } }) }));
vi.mock('@/constants/theme', () => ({
  Radius: { fold: 16, tin: 10 }, Space: { md: 16 }, useAppColors: () => ({ ink: '#fff', inkSoft: '#aaa',
    wool: '#123', woolDeep: '#012', seam: '#345', ember: '#fa6', emberWash: '#321', onFlame: '#111' }),
}));
vi.mock('@/components/section-heading', () => ({ SectionHeading: () => null }));
vi.mock('@/components/help-button', () => ({ HelpButton: () => null }));
vi.mock('@/components/selected-apps', () => ({ SelectedApps: () => null, DailyTimeProgress: () => null }));
vi.mock('@/components/keyboard-form', () => ({ KeyboardTextInput: () => null }));
vi.mock('@/components/form-sheet', () => ({ ActionButton: () => null, FormSheet: () => null }));
vi.mock('@/services/shared-allocation', () => ({ publishDailyAllocation: h.publish }));
vi.mock('@/native/screen-time', () => ({
  getScreenTimeStatus: h.read, configureScreenTimeAccount: h.bind,
  configureDailyScreenTimeLimit: h.configure, requestScreenTimeDisable: h.disable,
  cancelScreenTimeDisable: vi.fn(), clearScreenTimeSelection: vi.fn(), configurePerAppScreenTimeLimits: vi.fn(),
  openScreenTimeAccessibilitySettings: h.openAccessibility, openScreenTimeUsageSettings: h.openUsage, requestScreenTimeAuthorization: h.authorize,
  selectScreenTimeApps: vi.fn(), setScreenTimeBlocking: vi.fn(), setScreenTimeDisclosureAccepted: h.disclosure,
  unavailableScreenTimeStatus: (message: string) => ({
    ...h.nativeStatus, available: false, authorized: false, blockingEnabled: false,
    selection: { applications: 0, categories: 0, webDomains: 0 }, message,
  }),
}));

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function render() {
  h.cursor = 0; h.buttons.clear();
  const html = renderToStaticMarkup(createElement(ScreenTimeControls, { onStatus: h.onStatus }));
  h.layouts.splice(0).forEach(effect => effect());
  h.effects.splice(0).forEach(effect => effect());
  return html;
}
async function focus() {
  h.focusCleanup?.();
  const cleanup = h.focus?.();
  h.focusCleanup = typeof cleanup === 'function' ? cleanup : null;
  await flush(); return render();
}
async function mountReady() { render(); return focus(); }
function press(label: string) {
  const button = h.buttons.get(label);
  expect(button, `Missing button: ${label}`).toBeDefined();
  expect(button!.disabled).not.toBe(true);
  button!.onPress();
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const inactiveStatus = (): ScreenTimeStatus => ({
  available: true, authorized: true, authorizationStatus: 'approved', shielded: false, blockingEnabled: false,
  selection: { applications: 2, categories: 0, webDomains: 0 }, temporaryAccessExpiresAt: null, appliedGrantId: null,
  message: 'Your app choices are saved.', mode: 'daily', dailyLimitsAvailable: true,
  dailyLimitMinutes: 30, dailyLimitReached: false, settingsChangeAllowedAt: null,
});
async function saveConfirmed() {
  press('Save & enable daily limit'); await flush(); return render();
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-28T12:00:00Z')); vi.clearAllMocks();
  h.slots = []; h.cursor = 0; h.layouts = []; h.effects = []; h.buttons.clear();
  h.profileId = 'owner-a'; h.nativeStatus = inactiveStatus(); h.focus = null; h.focusCleanup = null;
  h.appState = 'active'; h.appListeners.clear(); h.platform = 'ios'; h.sdkVersion = 36;
  h.read.mockImplementation(async () => h.nativeStatus);
  h.bind.mockImplementation(async () => h.nativeStatus);
  h.openAccessibility.mockImplementation(async () => h.nativeStatus);
  h.openUsage.mockImplementation(async () => h.nativeStatus);
  h.disclosure.mockImplementation(async (accepted: boolean) => {
    h.nativeStatus = { ...h.nativeStatus, consentGranted: accepted };
    return h.nativeStatus;
  });
  h.authorize.mockImplementation(async () => h.nativeStatus);
  h.configure.mockImplementation(async (minutes: number) => {
    h.nativeStatus = { ...h.nativeStatus, dailyLimitMinutes: minutes, blockingEnabled: true };
    return h.nativeStatus;
  });
  h.disable.mockImplementation(async () => {
    h.nativeStatus = { ...h.nativeStatus, settingsChangeAllowedAt: new Date(Date.now() + 30_000).toISOString() };
    return h.nativeStatus;
  });
  h.publish.mockResolvedValue(undefined);
});
afterEach(() => {
  h.focusCleanup?.();
  for (const slot of h.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as EffectSlot).cleanup?.();
  vi.useRealTimers();
});

describe('Screen Time local-save critical path', () => {
  it('shows a separate Accessibility disclosure before either permission and supports decline and retry', async () => {
    h.platform = 'android';
    h.nativeStatus = { ...inactiveStatus(), authorized: false, consentGranted: false,
      usageAccessGranted: false, accessibilityEnabled: false, accessibilityServiceConnected: false };
    const html = await mountReady();
    expect(html).toContain('How sumore uses Accessibility');
    expect(html).toContain('app IDs and window-change events');
    expect(html).not.toContain('How sumore uses Usage Access');
    expect(h.buttons.has('Agree & open Usage Access')).toBe(false);
    expect(h.buttons.has('Open Accessibility settings')).toBe(false);
    expect(h.disclosure).not.toHaveBeenCalled();
    press('Not now'); await flush();
    expect(render()).toContain('App blocking stays off.');
    expect(h.disclosure).toHaveBeenLastCalledWith(false);
    expect(h.openUsage).not.toHaveBeenCalled();
    expect(h.openAccessibility).not.toHaveBeenCalled();
    expect(h.buttons.has('Agree & continue')).toBe(false);
    press('Review Accessibility access');
    expect(render()).toContain('How sumore uses Accessibility');
    press('Agree & continue'); await flush();
    const usageHtml = render();
    expect(h.disclosure).toHaveBeenLastCalledWith(true);
    expect(usageHtml).not.toContain('How sumore uses Accessibility');
    expect(usageHtml).toContain('How sumore uses Usage Access');
    expect(usageHtml).toContain('App IDs and detailed usage stay on this phone');
    expect(h.openUsage).not.toHaveBeenCalled();
    expect(h.openAccessibility).not.toHaveBeenCalled();
  });

  it('opens Usage Access only on explicit consent and offers a separate decline and retry', async () => {
    h.platform = 'android';
    h.nativeStatus = { ...inactiveStatus(), authorized: false, consentGranted: true,
      usageAccessGranted: false, accessibilityEnabled: false, accessibilityServiceConnected: false };
    await mountReady();
    press('Not now');
    expect(render()).toContain('You can keep using the rest of sumore.');
    expect(h.buttons.has('Agree & open Usage Access')).toBe(false);
    vi.advanceTimersByTime(30_000); await flush();
    h.appListeners.forEach(listener => listener('active')); await flush();
    expect(h.openUsage).not.toHaveBeenCalled();
    expect(h.openAccessibility).not.toHaveBeenCalled();
    render(); press('Review Usage Access'); render();
    press('Agree & open Usage Access'); await flush();
    expect(h.openUsage).toHaveBeenCalledTimes(1);
    expect(h.openAccessibility).not.toHaveBeenCalled();
    // Returning without permission remains on the same disclosure, not a loop
    // that automatically relaunches Settings.
    expect(render()).toContain('How sumore uses Usage Access');
    h.nativeStatus = { ...h.nativeStatus, usageAccessGranted: true };
    h.appListeners.forEach(listener => listener('active')); await flush();
    expect(render()).not.toContain('How sumore uses Usage Access');
    press('Open Accessibility settings'); await flush();
    expect(h.openAccessibility).toHaveBeenCalledTimes(1);
  });

  it('uses a neutral Continue button and never requests permission from focus or polling', async () => {
    h.nativeStatus = { ...inactiveStatus(), authorized: false, authorizationStatus: 'notDetermined',
      message: 'Screen Time access is needed to choose apps. Tap Continue to review it.' };
    const html = await mountReady();
    expect(h.buttons.has('Continue')).toBe(true);
    expect(html).not.toContain('Allow Screen Time');
    expect(h.buttons.has('Choose apps')).toBe(false);
    expect(h.buttons.has('Save & enable daily limit')).toBe(false);
    vi.advanceTimersByTime(30_000); await flush();
    h.appListeners.forEach(listener => listener('active')); await flush();
    expect(h.authorize).not.toHaveBeenCalled();
    press('Continue'); await flush();
    expect(h.authorize).toHaveBeenCalledTimes(1);
    expect(render()).not.toContain('Updating daily limit');
  });

  it('accepts a declined request without an error or automatic retry', async () => {
    h.nativeStatus = { ...inactiveStatus(), authorized: false, authorizationStatus: 'notDetermined', message: 'Screen Time access is needed.' };
    h.authorize.mockImplementation(async () => {
      h.nativeStatus = { ...h.nativeStatus, authorizationStatus: 'denied',
        message: 'Screen Time access is off, so app limits are unavailable. You can keep using the rest of sumore.' };
      return h.nativeStatus;
    });
    await mountReady(); press('Continue'); await flush();
    const html = render();
    expect(html).toContain('You can keep using the rest of sumore.');
    expect(html).not.toContain('Updating daily limit');
    expect(html).not.toContain('Could not update');
    expect(h.buttons.get('Continue')!.disabled).toBe(false);
    expect(h.buttons.has('Save & enable daily limit')).toBe(false);
    vi.advanceTimersByTime(30_000); await flush();
    h.appListeners.forEach(listener => listener('active')); await flush();
    expect(h.authorize).toHaveBeenCalledTimes(1);
    expect(h.onStatus.mock.calls.every(([status]) => status.authorized === false && status.blockingEnabled === false)).toBe(true);
  });

  it('shows app selection only after the user explicitly approves access', async () => {
    h.nativeStatus = { ...inactiveStatus(), authorized: false, authorizationStatus: 'notDetermined',
      selection: { applications: 0, categories: 0, webDomains: 0 } };
    h.authorize.mockImplementation(async () => {
      h.nativeStatus = { ...h.nativeStatus, authorized: true, authorizationStatus: 'approved' };
      return h.nativeStatus;
    });
    await mountReady(); press('Continue'); await flush(); render();
    expect(h.authorize).toHaveBeenCalledTimes(1);
    expect(h.buttons.has('Continue')).toBe(false);
    expect(h.buttons.has('Choose apps')).toBe(true);
    expect(h.nativeStatus.blockingEnabled).toBe(false);
  });

  it('shows reconnect guidance instead of claiming Accessibility is on after a service disconnect', async () => {
    h.platform = 'android';
    h.nativeStatus = { ...inactiveStatus(), authorized: false, usageAccessGranted: true, consentGranted: true,
      accessibilityEnabled: true, accessibilityServiceConnected: false, message: 'Android has not connected the Accessibility service.' };
    const html = await mountReady();
    expect(html).toContain('Accessibility: not connected');
    expect(html).not.toContain('Accessibility: on');
    expect(html).toContain('off and back on');
    expect(html).not.toContain('Restricted setting');
    expect(h.buttons.has('Save & enable daily limit')).toBe(false);
    press('Reopen Accessibility settings'); await flush();
    expect(h.openAccessibility).toHaveBeenCalledTimes(1);
    expect(render()).toContain('Accessibility: not connected');

    h.nativeStatus = { ...h.nativeStatus, authorized: true, accessibilityServiceConnected: true };
    h.appListeners.forEach(listener => listener('active')); await flush();
    expect(render()).toContain('Accessibility: on');
    expect(h.buttons.has('Save & enable daily limit')).toBe(true);
  });

  it('limits Restricted settings guidance to the relevant Android permission step', async () => {
    h.platform = 'android';
    h.nativeStatus = { ...inactiveStatus(), authorized: false, consentGranted: true,
      usageAccessGranted: true, accessibilityEnabled: false, accessibilityServiceConnected: false };
    expect(await mountReady()).toContain('Restricted setting');
    expect(h.buttons.has('Open Accessibility settings')).toBe(true);
    h.sdkVersion = 32;
    expect(render()).not.toContain('Restricted setting');
    h.sdkVersion = 36; h.nativeStatus = { ...h.nativeStatus, usageAccessGranted: false };
    h.appListeners.forEach(listener => listener('active')); await flush();
    expect(render()).not.toContain('Restricted setting');
    h.platform = 'ios';
    expect(render()).not.toContain('Restricted setting');
  });

  it('keeps form and preset touch targets readable with distinct selected and pressed states', async () => {
    await mountReady();
    const save = h.buttons.get('Save & enable daily limit')!;
    expect(save.style!({ pressed: false })).toMatchObject({ minHeight: 50, borderRadius: 16, backgroundColor: '#fa6', opacity: 1 });
    expect(save.style!({ pressed: true })).toMatchObject({ opacity: 0.78 });
    const selected = h.buttons.get('30 minutes per day across your selected apps')!;
    const chip = Object.assign({}, ...(selected.style!({ pressed: false }) as unknown[]).filter(Boolean));
    expect(chip).toMatchObject({ minHeight: 44, minWidth: 56, flexGrow: 1, backgroundColor: '#321', borderColor: '#fa6' });
    expect(selected.disabled).toBe(false);
  });
  it.each(['inactive', 'background'])('skips native polling while %s and resumes on the active event', async state => {
    h.appState = state;
    await mountReady();
    vi.advanceTimersByTime(30_000); await flush();
    expect(h.read).not.toHaveBeenCalled();

    h.appState = 'active';
    h.appListeners.forEach(listener => listener('active'));
    await flush();
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(render()).toContain('Your daily limit is off.');
    vi.advanceTimersByTime(3_000); await flush();
    expect(h.read).toHaveBeenCalledTimes(2);

    h.appState = state;
    h.appListeners.forEach(listener => listener(state));
    vi.advanceTimersByTime(30_000); await flush();
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('releases busy only after local confirmation, without waiting 20s for Circle upload', async () => {
    const native = deferred<ScreenTimeStatus>();
    const upload = deferred<void>();
    h.configure.mockReturnValue(native.promise); h.publish.mockReturnValue(upload.promise);
    await mountReady();
    press('Save & enable daily limit'); await flush();
    expect(render()).toContain('Updating daily limit');
    expect(h.publish).not.toHaveBeenCalled();
    h.nativeStatus = { ...inactiveStatus(), blockingEnabled: true };
    native.resolve(h.nativeStatus); await flush();
    const saved = render();
    expect(saved).toContain('Your daily limit is active.');
    expect(saved).not.toContain('Updating daily limit');
    expect(h.buttons.get('Stop or change limit')!.disabled).toBe(false);
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(h.nativeStatus, 'owner-a');
    vi.advanceTimersByTime(20_000); await flush();
    expect(render()).not.toContain('Updating daily limit');
    expect(h.buttons.get('Ask for time')!.disabled).toBe(false);
    upload.resolve(); await flush();
  });

  it('surfaces a late current-upload failure without undoing confirmed device settings', async () => {
    const upload = deferred<void>(); h.publish.mockReturnValue(upload.promise);
    await mountReady(); await saveConfirmed();
    upload.reject(new Error('Synthetic offline failure')); await flush();
    const html = render();
    expect(html).toContain('Phone settings saved. Your Circle allocation could not sync; try again when connected.');
    expect(html).toContain('Your daily limit is active.');
    expect(html).not.toContain('Updating daily limit');
  });

  it('does not overwrite a newer operation with an older upload failure', async () => {
    const oldUpload = deferred<void>(); h.publish.mockReturnValueOnce(oldUpload.promise).mockResolvedValue(undefined);
    await mountReady(); await saveConfirmed();
    press('Stop or change limit'); await flush(); render();
    expect(h.disable).toHaveBeenCalledTimes(1);
    expect(h.publish).toHaveBeenCalledTimes(2);
    oldUpload.reject(new Error('Old upload failure')); await flush();
    const html = render();
    expect(html).not.toContain('could not sync');
    expect(html).toContain('Confirm in 30s');
  });

  it('ignores late upload errors after the owner changes', async () => {
    const upload = deferred<void>(); h.publish.mockReturnValue(upload.promise);
    await mountReady(); await saveConfirmed();
    h.profileId = 'owner-b'; h.nativeStatus = inactiveStatus(); render(); await focus();
    upload.reject(new Error('Previous owner upload failed')); await flush();
    const html = render();
    expect(html).not.toContain('could not sync');
    expect(html).not.toContain('Your daily limit is active.');
    expect(h.buttons.get('Save & enable daily limit')!.disabled).toBe(false);
  });

  it('recovers controls after A → B → A even while the first A operation is pending', async () => {
    const previousSave = deferred<ScreenTimeStatus>();
    h.configure.mockReturnValueOnce(previousSave.promise);
    await mountReady();
    press('Save & enable daily limit'); await flush();
    expect(render()).toContain('Updating daily limit');
    h.profileId = 'owner-b'; render(); await focus();
    h.profileId = 'owner-a'; render();
    const returned = await focus();
    expect(returned).not.toContain('Updating daily limit');
    expect(h.buttons.get('Save & enable daily limit')!.disabled).toBe(false);
    // Returning to A can start a fresh operation; an older generation must
    // neither leave busy stuck nor overwrite that newer confirmed result.
    expect(await saveConfirmed()).toContain('Your daily limit is active.');
    expect(h.publish).toHaveBeenCalledTimes(1);
    previousSave.reject(new Error('Old A operation failed')); await flush();
    const html = render();
    expect(html).toContain('Your daily limit is active.');
    expect(html).not.toContain('Old A operation failed');
    expect(html).not.toContain('Updating daily limit');
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it('does not invent a successful save when the native operation rejects', async () => {
    h.configure.mockRejectedValue(new Error('Native device save failed'));
    await mountReady(); const html = await saveConfirmed();
    expect(html).toContain('Native device save failed');
    expect(html).not.toContain('Your daily limit is active.');
    expect(html).not.toContain('Updating daily limit');
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.onStatus.mock.calls.every(([status]) => status.blockingEnabled === false)).toBe(true);
    expect(h.buttons.get('Save & enable daily limit')!.disabled).toBe(false);
  });

  it('does not publish or claim success for an unconfirmed native response', async () => {
    h.configure.mockResolvedValue({ ...inactiveStatus(), dailyLimitMinutes: 45, blockingEnabled: true });
    await mountReady(); const html = await saveConfirmed();
    expect(html).toContain('The daily limit was not confirmed. Try saving again.');
    expect(html).not.toContain('Your daily limit is active.');
    expect(h.publish).not.toHaveBeenCalled();
    expect(h.onStatus.mock.calls.every(([status]) => status.blockingEnabled === false)).toBe(true);
  });
});
