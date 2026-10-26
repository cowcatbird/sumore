import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthGate } from './auth-gate';

type Button = { accessibilityLabel?: string; disabled?: boolean; onPress?: () => void; children?: ReactNode };
type Input = { accessibilityLabel: string; value: string; onChangeText: (value: string) => void; onSubmitEditing: () => void };
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, buttons: new Map<string, Button>(), inputs: new Map<string, Input>(),
  ownerId: 'owner-a', displayName: '   ', authenticated: true, ready: true, configured: true, busy: false, profileLoading: false,
  accepted: new Set<string>(), restricted: false, statusError: null as string | null, statusLoading: false,
  appError: null as string | null, accepting: false, update: vi.fn(), signup: vi.fn(), clear: vi.fn(), accept: vi.fn(),
}));
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return '';
}
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [h.slots[index], (next: unknown) => { h.slots[index] = typeof next === 'function' ? next(h.slots[index]) : next; }];
    },
    useRef: (initial: unknown) => { const index = h.cursor++; if (!(index in h.slots)) h.slots[index] = { current: initial }; return h.slots[index]; },
  };
});
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  Pressable: (props: Button) => {
    h.buttons.set(props.accessibilityLabel ?? text(props.children), props); return createElement('button', { disabled: props.disabled }, props.children);
  },
  ActivityIndicator: () => null, Keyboard: { dismiss: vi.fn() }, StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('expo-symbols', () => ({ SymbolView: () => null }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 20, right: 0, bottom: 10, left: 0 }) }));
vi.mock('@/constants/theme', () => ({ useAppColors: () => ({}), Space: { lg: 20, xl: 30 }, Type: {}, Radius: {}, Shadow: {} }));
vi.mock('@/components/account-controls', () => ({
  AccountControls: () => createElement('aside', null, 'Login key · Already have an account? · Delete account'),
  RestoreAccountButton: () => createElement('span', null, 'Restore account'),
}));
vi.mock('@/components/community-rules', () => ({ CommunityRulesNotice: () => h.accepted.has(h.ownerId) && !h.restricted && !h.statusError ? null :
  createElement('section', null, 'Community rules before sharing', createElement('button', { onClick: h.accept }, 'Accept rules')) }));
vi.mock('@/features/moderation-store', () => ({
  ModerationProvider: ({ children }: { children: ReactNode }) => createElement('section', { 'data-moderation-owner': h.ownerId }, children),
  useModeration: () => ({ status: { rulesVersion: '2026-10-12', acceptedRulesVersion: h.accepted.has(h.ownerId) ? '2026-10-12' : null,
    restriction: h.restricted ? { reason: 'Paused' } : null }, error: h.statusError, loading: h.statusLoading, accepting: h.accepting }),
}));
vi.mock('@/components/keyboard-form', () => ({
  KeyboardForm: ({ children }: { children: ReactNode }) => createElement('form', null, children),
  KeyboardTextInput: (props: Input) => { h.inputs.set(props.accessibilityLabel, props); return createElement('input', { value: props.value, readOnly: true }); },
}));
vi.mock('@/components/character-sprite', () => ({ BrandLogo: () => null }));
vi.mock('@/components/blanket-band', () => ({ BlanketBand: () => null }));
vi.mock('@/components/welcome-camp', () => ({ WelcomeCamp: () => createElement('div', { 'data-welcome-camp': true }) }));
vi.mock('@/components/app-update-notice', () => ({ AppUpdateNotice: () => null }));
vi.mock('@/components/public-info-links', () => ({ PublicInfoLinks: () => null }));
vi.mock('@/features/app-store', () => ({ useApp: () => ({ busy: h.busy, error: h.appError, isAuthenticated: h.authenticated,
  isConfigured: h.configured, isReady: h.ready, profile: { id: h.ownerId, displayName: h.displayName }, profileLoading: h.profileLoading,
  updateProfile: h.update, continueWithoutEmail: h.signup, clearError: h.clear }) }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function render() {
  h.cursor = 0; h.buttons.clear(); h.inputs.clear();
  return renderToStaticMarkup(createElement(AuthGate, null, createElement('main', null, 'Authenticated app')));
}
function typeName(name: string) { h.inputs.get('Your name')!.onChangeText(name); return render(); }
async function press(label: string) {
  const button = h.buttons.get(label); expect(button, `Missing ${label}`).toBeDefined();
  if (!button!.disabled) button!.onPress?.(); await flush(); return render();
}
beforeEach(() => {
  vi.clearAllMocks(); h.slots = []; h.cursor = 0; h.buttons.clear(); h.inputs.clear(); h.ownerId = 'owner-a'; h.displayName = '   ';
  h.authenticated = true; h.ready = true; h.configured = true; h.busy = false; h.profileLoading = false;
  h.accepted.clear(); h.restricted = false; h.statusError = null; h.appError = null; h.statusLoading = false; h.accepting = false;
  h.update.mockResolvedValue(undefined); h.signup.mockResolvedValue(undefined);
});

describe('Incomplete profile repair with community consent', () => {
  it('welcomes new users without creating an account until a valid name is submitted', async () => {
    h.authenticated = false;
    const html = render();
    expect(html).toContain('Welcome to sumore');
    expect(html).toContain('Less scrolling. More time together.');
    expect(html).toContain('data-welcome-camp');
    expect(html).toContain('Restore account');
    expect(h.buttons.get('Join the camp')!.disabled).toBe(true);
    typeName('   '); await press('Join the camp'); expect(h.signup).not.toHaveBeenCalled();
    typeName('Avery'); await press('Join the camp');
    expect(h.signup).toHaveBeenCalledExactlyOnceWith('Avery');
  });
  it('mounts an account-scoped consent provider and rules before the repair form', () => {
    const html = render(); expect(html).toContain('data-moderation-owner="owner-a"');
    expect(html.indexOf('Community rules before sharing')).toBeLessThan(html.indexOf('Your name'));
    expect(html).toContain('Delete account'); expect(html).not.toContain('Authenticated app');
    typeName('New name'); expect(h.buttons.get('Save profile')!.disabled).toBe(true);
  });
  it('keeps the typed name during acceptance and requires a separate profile-save action', async () => {
    render(); typeName('Avery'); h.accepting = true;
    const pending = render(); expect(pending).toContain('data-moderation-owner="owner-a"');
    expect(h.inputs.get('Your name')!.value).toBe('Avery'); expect(h.update).not.toHaveBeenCalled();
    h.accepting = false; h.accepted.add('owner-a'); render();
    expect(h.inputs.get('Your name')!.value).toBe('Avery'); expect(h.buttons.get('Save profile')!.disabled).toBe(false);
    await press('Save profile'); expect(h.update).toHaveBeenCalledExactlyOnceWith('Avery');
  });
  it('keeps recovery, key access and deletion available when rules cannot load or social sharing is restricted', async () => {
    h.restricted = true; h.accepted.add('owner-a'); render(); typeName('Avery');
    expect(h.buttons.get('Save profile')!.disabled).toBe(true);
    expect(render()).toContain('Login key · Already have an account? · Delete account');
    h.restricted = false; h.statusError = 'Server update required'; render();
    await press('Save profile'); h.inputs.get('Your name')!.onSubmitEditing(); await flush();
    expect(h.update).not.toHaveBeenCalled(); expect(render()).toContain('Delete account');
  });
  it('preserves the same-account name through profile loading and retryable failures', async () => {
    render(); typeName('Avery'); h.profileLoading = true; expect(render()).toContain('Loading your profile');
    h.profileLoading = false; render(); expect(h.inputs.get('Your name')!.value).toBe('Avery');
    h.accepted.add('owner-a'); h.update.mockRejectedValueOnce(new Error('Offline')); render(); await press('Save profile');
    expect(h.inputs.get('Your name')!.value).toBe('Avery');
  });
  it('never carries a retained name across A → B → A, including a late old input callback', () => {
    render(); const oldInput = h.inputs.get('Your name')!; typeName('Private A name');
    h.ownerId = 'owner-b'; h.displayName = ' '; render(); render();
    expect(h.inputs.get('Your name')!.value).toBe(' ');
    oldInput.onChangeText('Late A name'); render(); expect(h.inputs.get('Your name')!.value).toBe(' ');
    typeName('Private B name'); h.ownerId = 'owner-a'; h.displayName = '   '; render(); render();
    expect(h.inputs.get('Your name')!.value).toBe('   ');
  });
  it('does not weaken normal authentication or mount a second provider for a valid profile', () => {
    h.authenticated = false; const signedOut = render(); expect(signedOut).toContain('Join the camp');
    expect(signedOut).not.toContain('data-moderation-owner'); expect(signedOut).not.toContain('Authenticated app');
    h.authenticated = true; h.displayName = 'Avery'; const normal = render();
    expect(normal).toBe('<main>Authenticated app</main>'); expect(normal).not.toContain('data-moderation-owner');
  });
  it('keeps the exceptional provider keyed and does not add a server consent bypass', () => {
    const source = readFileSync(new URL('./auth-gate.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<ModerationProvider key={profile.id}>');
    expect(source).toContain('<CommunityRulesNotice />'); expect(source).toContain('<AccountControls />');
    expect(source).not.toContain('acceptCommunityRules('); expect(source).not.toContain('requireSupabase');
  });
});
