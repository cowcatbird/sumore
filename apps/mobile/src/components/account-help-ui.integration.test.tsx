import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountControls, RestoreAccountButton } from './account-controls';
import { CircleAllocations } from './circle-allocations';
import { HelpFeedbackControls } from './help-feedback-controls';

type Button = { label: string; disabled?: boolean; onPress: () => void };
type Input = { accessibilityLabel: string; value: string; onChangeText: (value: string) => void; secureTextEntry?: boolean };
type EffectSlot = { deps?: readonly unknown[]; cleanup?: () => void };
// Small explicit SSR/handler harness. Executes the real component callbacks
// against service spies; it does not claim native layout or renderer coverage.
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
  buttons: new Map<string, Button>(), inputs: new Map<string, Input>(),
  pressables: new Map<string, { role?: string; style: Record<string, unknown> }>(),
  forms: new Map<string, { onClose: () => void; busy?: boolean }>(),
  listeners: new Set<(state: string) => void>(), focus: null as (() => void | (() => void)) | null,
  focusCleanup: null as (() => void) | null, preview: true,
  getKey: vi.fn(), createKey: vi.fn(), removeAccount: vi.fn(), restore: vi.fn(),
  getLimits: vi.fn(), saveLimits: vi.fn(), getStatus: vi.fn(), publish: vi.fn(),
  send: vi.fn(), copy: vi.fn(), tour: vi.fn(), dismiss: vi.fn(), uuid: vi.fn(),
}));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
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
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = h.cursor++;
      const previous = h.slots[index] as EffectSlot | undefined;
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        h.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); h.slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }; });
      }
    },
  };
});
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  Pressable: ({ children, accessibilityLabel, accessibilityRole, style, ...props }: Omit<Button, 'label'> & {
    children: ReactNode; accessibilityLabel: string; accessibilityRole?: string;
    style: Record<string, unknown> | ((state: { pressed: boolean }) => Record<string, unknown>);
  }) => {
    h.buttons.set(accessibilityLabel, { ...props, label: accessibilityLabel });
    h.pressables.set(accessibilityLabel, { role: accessibilityRole, style: typeof style === 'function' ? style({ pressed: false }) : style });
    return createElement('button', { 'aria-label': accessibilityLabel, disabled: props.disabled }, children);
  },
  AppState: { addEventListener: (_: string, listener: (state: string) => void) => {
    h.listeners.add(listener); return { remove: () => h.listeners.delete(listener) };
  } }, Keyboard: { dismiss: h.dismiss },
}));
vi.mock('@/components/form-sheet', () => ({
  ActionButton: (props: Button) => { h.buttons.set(props.label, props); return createElement('button', { disabled: props.disabled }, props.label); },
  FormSheet: ({ visible, title, children, ...props }: { visible: boolean; title: string; children: ReactNode; onClose: () => void; busy?: boolean }) => {
    if (!visible) return null;
    h.forms.set(title, props); return createElement('section', null, children);
  },
}));
vi.mock('@/components/settings-action-row', () => ({
  SettingsActionRow: (props: Button) => { h.buttons.set(props.label, props); return createElement('button', { disabled: props.disabled }, props.label); },
}));
vi.mock('@/components/keyboard-form', () => ({ KeyboardTextInput: (props: Input) => {
  h.inputs.set(props.accessibilityLabel, props); return createElement('input', { 'aria-label': props.accessibilityLabel, type: props.secureTextEntry ? 'password' : 'text' });
} }));
vi.mock('@/components/section-heading', () => ({ SectionHeading: ({ title }: { title: string }) => createElement('h2', null, title) }));
vi.mock('@/components/app-tour', () => ({ useAppTour: () => ({ openTour: h.tour }) }));
vi.mock('@/constants/theme', () => ({ Radius: { fold: 10 }, Space: { xs: 8, sm: 12, md: 16 }, Type: { control: { fontSize: 15 }, bodySmall: { fontSize: 13 } }, useAppColors: () => ({ ink: '#111', inkSoft: '#555', wool: '#eee', seam: '#ccc', ember: '#b54118' }) }));
vi.mock('@/features/app-store', () => ({ useApp: () => ({ profile: { id: 'fixture-self', displayName: 'You' }, friends: [{ id: 'fixture-friend', displayName: 'Friend' }] }) }));
vi.mock('@/features/local-art-preview', () => ({ get isLocalArtPreview() { return h.preview; } }));
vi.mock('@/services/account-access', () => ({
  getLoginKey: h.getKey, createLoginKey: h.createKey, deleteAccount: h.removeAccount, restoreAccount: h.restore,
  normalizeLoginKey: (value: string) => value.startsWith('SUMORE-') ? value : null,
  getCircleAppLimits: h.getLimits, setSharedAppLimits: h.saveLimits,
}));
vi.mock('@/services/feedback', () => ({
  openProblemReportEmail: h.send, FEEDBACK_ADDRESS: 'cowcatbird.dev@gmail.com',
  problemReportEmail: (message: string) => ({ subject: '[Report a problem] sumore', body: message.trim() }),
}));
vi.mock('@/services/shared-allocation', () => ({ publishDailyAllocation: h.publish }));
vi.mock('@/native/screen-time', () => ({ getScreenTimeStatus: h.getStatus }));
vi.mock('expo-clipboard', () => ({ setStringAsync: h.copy }));
vi.mock('expo-crypto', () => ({ randomUUID: h.uuid }));
vi.mock('expo-router', () => ({ useFocusEffect: (callback: () => void | (() => void)) => { h.focus = callback; } }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const flush = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };
let Component: ComponentType;
function render(component = Component) {
  Component = component; h.cursor = 0; h.buttons.clear(); h.inputs.clear(); h.forms.clear(); h.pressables.clear();
  const html = renderToStaticMarkup(createElement(Component));
  h.effects.splice(0).forEach(effect => effect());
  return html;
}
async function press(label: string) {
  const button = h.buttons.get(label);
  expect(button, `Missing ${label}`).toBeDefined();
  if (!button!.disabled) button!.onPress();
  await flush(); return render();
}
function input(label: string, value: string) {
  expect(h.inputs.has(label), `Missing ${label}`).toBe(true);
  h.inputs.get(label)!.onChangeText(value); return render();
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  h.slots = []; h.cursor = 0; h.effects = []; h.preview = true; h.listeners.clear(); h.focus = null; h.focusCleanup = null;
  h.getKey.mockResolvedValue({ key: 'SUMORE-SYNTHETIC-TEST-ONLY', hasKey: true });
  h.createKey.mockResolvedValue('SUMORE-SYNTHETIC-TEST-ONLY');
  h.removeAccount.mockResolvedValue(undefined); h.copy.mockResolvedValue(undefined);
  h.restore.mockResolvedValue({ previousKeyRevoked: true, keySaved: true });
  h.send.mockResolvedValue('opened'); h.uuid.mockReturnValue('fixture-report-id');
});
afterEach(() => {
  h.focusCleanup?.();
  for (const slot of h.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as EffectSlot).cleanup?.();
  vi.useRealTimers();
});

describe('account and feedback UI service boundaries', () => {
  it('never invokes account creation, recovery, or deletion services from the demo controls', async () => {
    render(AccountControls);
    const keyScreen = await press('Login key · tap to view');
    expect(keyScreen).toContain('Login keys are unavailable in this browser');
    expect(keyScreen).not.toContain('NOT A REAL LOGIN KEY');
    expect(h.buttons.has('Copy login key')).toBe(false);
    h.forms.get('Your private login key')!.onClose(); render();
    await press('Delete account');
    expect(h.buttons.get('Permanently delete account')!.disabled).toBe(true);
    await press('Permanently delete account');
    input('Type DELETE to confirm account deletion', 'DELETE');
    expect(await press('Permanently delete account')).toContain('Nothing was deleted');
    h.forms.get('Delete account?')!.onClose(); render();
    await press('Already have an account?');
    input('Private login key', 'demo-entered-key');
    expect(await press('Restore account')).toContain('Account recovery is unavailable in this browser');
    for (const service of [h.getKey, h.createKey, h.restore, h.removeAccount]) expect(service).not.toHaveBeenCalled();
  });

  it('requires exact DELETE confirmation, prevents double submissions, and clears confirmation on close', async () => {
    h.preview = false; render(AccountControls); await press('Delete account');
    for (const value of ['', 'delete', 'DELETE ', 'DELET']) {
      input('Type DELETE to confirm account deletion', value);
      expect(h.buttons.get('Permanently delete account')!.disabled).toBe(true);
      await press('Permanently delete account');
    }
    expect(h.removeAccount).not.toHaveBeenCalled();
    input('Type DELETE to confirm account deletion', 'DELETE');
    const pending = Promise.withResolvers<void>(); h.removeAccount.mockReturnValueOnce(pending.promise);
    const submit = h.buttons.get('Permanently delete account')!.onPress;
    submit(); submit(); await flush(); render();
    expect(h.removeAccount).toHaveBeenCalledTimes(1);
    expect(h.forms.get('Delete account?')!.busy).toBe(true);
    pending.resolve(); await flush(); render();
    h.forms.get('Delete account?')!.onClose(); render(); await press('Delete account');
    expect(h.inputs.get('Type DELETE to confirm account deletion')!.value).toBe('');
  });

  it('keeps recovery entry masked and discards the draft when dismissed', async () => {
    h.preview = false; render(RestoreAccountButton); await press('Already have an account?');
    input('Private login key', 'SUMORE-SYNTHETIC-TEST-ONLY');
    expect(h.inputs.get('Private login key')!.secureTextEntry).toBe(true);
    h.forms.get('Restore your account')!.onClose(); render(); await press('Already have an account?');
    expect(h.inputs.get('Private login key')!.value).toBe('');
    expect(h.restore).not.toHaveBeenCalled();
  });

  it('hides a shown login key when backgrounded', async () => {
    h.preview = false; render(AccountControls); await press('Login key · tap to view');
    expect(h.slots).toContain('SUMORE-SYNTHETIC-TEST-ONLY');
    h.listeners.forEach(listener => listener('background')); render();
    expect(h.slots).not.toContain('SUMORE-SYNTHETIC-TEST-ONLY');
    expect(h.forms.size).toBe(0);
  });

  it.each([true, false])('discards late key reads after backgrounding (hasKey=%s)', async hasKey => {
    h.preview = false;
    const gate = Promise.withResolvers<{ key: string | null; hasKey: boolean }>();
    h.getKey.mockReturnValueOnce(gate.promise);
    render(AccountControls); await press('Login key · tap to view');
    h.listeners.forEach(listener => listener('background')); render();
    gate.resolve({ key: hasKey ? 'SUMORE-SYNTHETIC-TEST-ONLY' : null, hasKey });
    await flush(); render();
    expect(h.slots).not.toContain('SUMORE-SYNTHETIC-TEST-ONLY');
    expect(h.forms.size).toBe(0);
    expect(h.createKey).not.toHaveBeenCalled();
  });

  it('never opens an email app or sends feedback in demo mode', async () => {
    render(HelpFeedbackControls); await press('Report a problem');
    input('Describe the problem', 'A synthetic demo issue.');
    expect(await press('Open email')).toContain('No email was sent');
    expect(h.send).not.toHaveBeenCalled(); expect(h.uuid).not.toHaveBeenCalled();
    await press('App tour'); expect(h.tour).toHaveBeenCalledTimes(1);
  });

  it('retains the draft after failure and opening an email app, without claiming delivery', async () => {
    h.preview = false; h.send.mockRejectedValueOnce(new Error('Could not open an email app'));
    render(HelpFeedbackControls); await press('Report a problem');
    input('Describe the problem', 'short'); expect(h.buttons.get('Open email')!.disabled).toBe(true);
    input('Describe the problem', '  A synthetic issue with the screen.  ');
    expect(await press('Open email')).toContain('Could not open an email app');
    expect(h.inputs.get('Describe the problem')!.value).toContain('synthetic issue');
    const html = await press('Open email');
    expect(html).toContain('Finish sending in your email app');
    expect(html).not.toContain('Report sent');
    expect(h.inputs.get('Describe the problem')!.value).toContain('synthetic issue');
    expect(h.uuid).not.toHaveBeenCalled();
    expect(h.send.mock.calls).toEqual(Array(2).fill(['  A synthetic issue with the screen.  ']));
  });

  it.each(['cancelled', 'saved', 'accepted'])('retains the report after composer result %s and closing/reopening the sheet', async result => {
    h.preview = false; h.send.mockResolvedValue(result);
    render(HelpFeedbackControls); await press('Report a problem');
    input('Describe the problem', 'A synthetic issue.'); await press('Open email');
    h.forms.get('Report a problem')!.onClose(); render(); await press('Report a problem');
    expect(h.inputs.get('Describe the problem')!.value).toBe('A synthetic issue.');
  });

  it('copies only after explicit action and blocks duplicate composer launches', async () => {
    h.preview = false;
    render(HelpFeedbackControls); await press('Report a problem');
    input('Describe the problem', 'A synthetic issue.');
    expect(h.copy).not.toHaveBeenCalled();
    expect(await press('Copy report')).toContain('Copied. Paste into an email');
    expect(h.copy).toHaveBeenCalledExactlyOnceWith('To: cowcatbird.dev@gmail.com\nSubject: [Report a problem] sumore\n\nA synthetic issue.');
    const pending = Promise.withResolvers<string>(); h.send.mockReturnValueOnce(pending.promise);
    const open = h.buttons.get('Open email')!.onPress;
    open(); open(); await flush(); render();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.forms.get('Report a problem')!.busy).toBe(true);
    pending.resolve('opened'); await flush(); render();
  });

  it('shows allocations with one secondary sharing action and retains the privacy explanation in its form', async () => {
    render(CircleAllocations); h.focusCleanup = h.focus?.() || null; await flush();
    const html = render();
    for (const text of ['Daily allocations', 'You', '45 min/day', 'Friend', '30 min/day', 'Social feed · 30 min', 'Videos · 15 min', 'Labels shared by this camper']) expect(html).toContain(text);
    expect([...h.buttons.keys()]).toEqual(['Share optional app labels']);
    const action = h.pressables.get('Share optional app labels');
    expect(action?.role).toBe('button');
    expect(action?.style.minHeight).toBeGreaterThanOrEqual(44);
    expect(action?.style.height).toBeUndefined();
    expect(action?.style.backgroundColor).toBeUndefined();
    expect(action?.style.borderWidth).toBeUndefined();
    expect(await press('Share optional app labels')).toContain('Optional names you type, not your phone’s private app list. Your circle can see these labels and times.');
    expect(h.inputs.get('App label 1')?.value).toBe('Social feed');
    expect(h.buttons.has('Save for circle')).toBe(true);
  });

  it('keeps unshared people distinct from a zero-minute allocation in the compact list', async () => {
    h.preview = false;
    const status = { available: true, mode: 'daily', blockingEnabled: false, dailyLimitMinutes: 45 };
    h.getStatus.mockResolvedValue(status);
    h.publish.mockResolvedValue(undefined);
    h.getLimits.mockResolvedValue([{ userId: 'fixture-self', totalDailyMinutes: 0, apps: null, updatedAt: '2026-09-30T12:00:00Z' }]);
    render(CircleAllocations); h.focusCleanup = h.focus?.() || null; await flush();
    const html = render();
    expect(html).toContain('0 min/day');
    expect(html).toContain('Not shared yet');
    expect(html).not.toContain('Labels shared by this camper');
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(status, 'fixture-self');
    expect(h.getLimits).toHaveBeenCalledTimes(1);
    expect(h.saveLimits).not.toHaveBeenCalled();
  });

  it('loads and saves optional demo labels without native status, publication, or server calls', async () => {
    render(CircleAllocations); h.focusCleanup = h.focus?.() || null; await flush(); render();
    await press('Share optional app labels');
    await press('Hide all app labels'); await press('Add app label');
    input('App label 1', 'Reader'); input('Minutes for app label 1', '46');
    expect(await press('Save for circle')).toContain('cannot total more than your daily allowance');
    input('Minutes for app label 1', '15.5');
    expect(await press('Save for circle')).toContain('Use whole minutes');
    input('Minutes for app label 1', '15');
    expect(await press('Save for circle')).toContain('Saved in this browser. Nothing was shared online.');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(render()).toContain('Reader');
    h.focusCleanup?.(); h.focusCleanup = h.focus?.() || null; await flush();
    expect(render()).toContain('Reader');
    for (const service of [h.getStatus, h.getLimits, h.saveLimits, h.publish]) expect(service).not.toHaveBeenCalled();
  });

  it('keeps secret-bearing account state separate from shared app snapshots and browser storage', () => {
    const controls = readFileSync(new URL('./account-controls.tsx', import.meta.url), 'utf8');
    const store = readFileSync(new URL('../features/app-store.tsx', import.meta.url), 'utf8');
    const service = readFileSync(new URL('../services/account-access.ts', import.meta.url), 'utf8');
    expect(controls).toContain('<AccountPanel key={profile.id} />');
    expect(controls).not.toMatch(/localStorage\.|AsyncStorage\.|console\./);
    expect(store).not.toMatch(/loginKey\s*:|privateKey\s*:/);
    expect(service).toContain('WHEN_UNLOCKED_THIS_DEVICE_ONLY');
    expect(service).not.toMatch(/localStorage\.|AsyncStorage\.|console\./);
  });
});
