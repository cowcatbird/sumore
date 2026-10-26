import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationSettings } from '@/app/settings';

type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
type Button = { onPress: () => Promise<void>; disabled?: boolean };
const h = vi.hoisted(() => ({
  slots: [] as unknown[], effects: [] as (() => void)[], cursor: 0,
  buttons: new Map<string, Button>(), listeners: new Set<(state: string) => void>(),
  appState: 'active', preview: false, readiness: vi.fn(), enable: vi.fn(), local: vi.fn(),
}));
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = initial;
      return [h.slots[index], (value: unknown) => { h.slots[index] = value; }];
    },
    useRef: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = { current: initial };
      return h.slots[index];
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = h.cursor++;
      const previous = h.slots[index] as Effect | undefined;
      if (!previous || deps?.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        h.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); h.slots[index] = { deps, cleanup }; });
      }
    },
  };
});
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  Pressable: ({ children, accessibilityLabel, ...props }: Button & { children: ReactNode; accessibilityLabel: string }) => {
    h.buttons.set(accessibilityLabel, props); return createElement('button', { disabled: props.disabled }, children);
  },
  StyleSheet: { create: (value: unknown) => value }, ActivityIndicator: () => null,
  Keyboard: { dismiss: vi.fn() },
  AppState: { get currentState() { return h.appState; }, addEventListener: (_: string, listener: (state: string) => void) => {
    h.listeners.add(listener); return { remove: () => h.listeners.delete(listener) };
  } },
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: () => null }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/features/moderation-store', () => ({ useModeration: () => ({ status: null, preview: true }) }));
vi.mock('@/components/community-rules', () => ({ CommunityRulesButton: () => null, CommunityRulesNotice: () => null }));
vi.mock('@/components/settings-action-row', () => ({ SettingsActionRow: () => null }));
vi.mock('@/constants/theme', () => ({ Radius: {}, Space: {}, Type: {}, MaxContentWidth: 640, useAppColors: () => ({}) }));
vi.mock('@/constants/form-layout', () => ({ FormLayout: {}, formControlStyle: {}, formSectionStyle: {} }));
vi.mock('@/features/app-store', () => ({ useApp: () => ({}) }));
vi.mock('@/features/local-art-preview', () => ({ get isLocalArtPreview() { return h.preview; } }));
vi.mock('@/components/app-update-notice', () => ({ AppUpdateNotice: () => null }));
vi.mock('@/components/account-controls', () => ({ AccountControls: () => null }));
vi.mock('@/components/help-feedback-controls', () => ({ HelpFeedbackControls: () => null }));
vi.mock('@/components/local-preview-banner', () => ({ LocalPreviewBanner: () => null }));
vi.mock('@/components/keyboard-form', () => ({ KeyboardForm: () => null, KeyboardTextInput: () => null }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));
vi.mock('@/components/section-heading', () => ({ SectionHeading: () => null }));
vi.mock('@/services/notifications', () => ({
  getNotificationReadiness: h.readiness, registerForPushNotifications: h.enable, scheduleNotificationPreview: h.local,
  notificationStatusLabel: (status: string) => status,
  notificationErrorMessage: () => 'Notifications need an app update.', notificationErrorReadiness: () => 'needs-update',
}));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const render = () => {
  h.cursor = 0; h.buttons.clear();
  const html = renderToStaticMarkup(createElement(NotificationSettings, { ownerId: 'owner' }));
  const effects = h.effects.splice(0); effects.forEach(effect => effect());
  return html;
};
const flush = async () => { for (let i = 0; i < 15; i += 1) await Promise.resolve(); };
const state = (next: string) => { h.appState = next; h.listeners.forEach(listener => listener(next)); };
const unmount = () => { h.slots.forEach(slot => (slot as Effect | undefined)?.cleanup?.()); };
beforeEach(() => {
  unmount(); h.slots = []; h.effects = []; h.cursor = 0; h.listeners.clear(); h.buttons.clear();
  h.appState = 'active'; h.preview = false;
  h.readiness.mockReset().mockResolvedValue('permission-granted'); h.enable.mockReset().mockResolvedValue(undefined); h.local.mockReset().mockResolvedValue(undefined);
});

describe('Settings notification registration lifecycle', () => {
  it('checks readiness without registering or scheduling anything on render', async () => {
    render(); await flush(); expect(render()).toContain('permission-granted');
    expect(h.readiness).toHaveBeenCalledExactlyOnceWith('owner'); expect(h.enable).not.toHaveBeenCalled(); expect(h.local).not.toHaveBeenCalled();
  });
  it('blocks duplicate taps synchronously and disables both controls while saving registration', async () => {
    const save = Promise.withResolvers<void>(); h.enable.mockReturnValue(save.promise);
    render(); await flush(); const button = h.buttons.get('Enable notifications')!;
    const first = button.onPress(); const second = button.onPress();
    render(); expect(h.enable).toHaveBeenCalledOnce(); expect(h.buttons.get('Test on this device')?.disabled).toBe(true);
    expect(h.buttons.get('Enable notifications')?.disabled).toBe(true);
    save.resolve(); await Promise.all([first, second]);
    expect(render()).toContain('This device is registered for friend notifications.');
  });
  it('a stale initial readiness read cannot overwrite successful explicit registration', async () => {
    const read = Promise.withResolvers<string>(); h.readiness.mockReturnValue(read.promise);
    render(); await h.buttons.get('Enable notifications')!.onPress();
    read.resolve('permission-granted'); await flush();
    expect(render()).toContain('registered</span>');
  });
  it('removes a previously registered state on failed Enable and never renders raw SDK errors', async () => {
    h.readiness.mockResolvedValue('registered'); render(); await flush();
    h.enable.mockRejectedValue(new Error('Firebase secret/private-path'));
    await h.buttons.get('Enable notifications')!.onPress();
    const html = render(); expect(html).toContain('needs-update'); expect(html).not.toContain('secret/private-path'); expect(html).not.toContain('registered</span>');
    expect(h.buttons.get('Enable notifications')?.disabled).toBe(false);
  });
  it('the local test does not promote permission-only status or promise remote delivery', async () => {
    render(); await flush(); await h.buttons.get('Test on this device')!.onPress();
    expect(render()).toContain('permission-granted'); expect(render()).toContain('does not test delivery from friends');
    expect(h.enable).not.toHaveBeenCalled();
  });
  it('invalidates registration on background and never reports the late result as success', async () => {
    const save = Promise.withResolvers<void>(); h.enable.mockReturnValue(save.promise);
    render(); await flush(); const pending = h.buttons.get('Enable notifications')!.onPress();
    const current = h.enable.mock.calls[0][1]; expect(current()).toBe(true);
    state('background'); expect(current()).toBe(false); save.resolve(); await pending;
    expect(render()).not.toContain('registered</span>');
    state('active'); await flush(); expect(render()).toContain('permission-granted');
  });
  it('does not cancel the normal iOS permission dialog inactive transition', async () => {
    const save = Promise.withResolvers<void>(); h.enable.mockReturnValue(save.promise);
    render(); await flush(); const pending = h.buttons.get('Enable notifications')!.onPress();
    state('inactive'); expect(h.enable.mock.calls[0][1]()).toBe(true);
    state('active'); save.resolve(); await pending;
    expect(render()).toContain('registered</span>');
  });
  it('cancels owner-scoped operations and removes observers on unmount', async () => {
    const save = Promise.withResolvers<void>(); h.enable.mockReturnValue(save.promise);
    render(); await flush(); const pending = h.buttons.get('Enable notifications')!.onPress();
    unmount(); const before = [...h.slots]; expect(h.enable.mock.calls[0][1]()).toBe(false); expect(h.listeners.size).toBe(0);
    save.resolve(); await pending; expect(h.slots).toEqual(before);
    const source = readFileSync(new URL('../app/settings.tsx', import.meta.url), 'utf8');
    expect(source).toContain('key={`notifications:${profile.id}`}');
  });
  it('refreshes permission status after phone Settings without requesting another token', async () => {
    h.readiness.mockResolvedValueOnce('registered').mockResolvedValue('denied');
    render(); await flush(); state('background'); state('active'); await flush();
    expect(render()).toContain('denied'); expect(h.enable).not.toHaveBeenCalled();
  });
  it('keeps browser artwork preview entirely outside native and remote notification operations', async () => {
    h.preview = true; render();
    await h.buttons.get('Enable notifications')!.onPress(); await h.buttons.get('Test on this device')!.onPress();
    expect(render()).toContain('Nothing was sent');
    for (const api of [h.enable, h.local, h.readiness]) expect(api).not.toHaveBeenCalled();
    expect(h.listeners.size).toBe(0);
  });
});
