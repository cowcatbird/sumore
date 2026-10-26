import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DAILY_LIMIT_OPTIONS } from '@/domain/daily-limit-controls';
import { createDemoLimitState, demoLimitReducer, demoLimitTotal, parseDemoMinutes } from '@/domain/demo-screen-time';
import { LocalPreviewScreenTimeControls } from './local-preview-screen-time-controls';

let demoState = createDemoLimitState();
const appearance = vi.hoisted(() => ({ controls: new Map<string, { disabled?: boolean; style: unknown }>() }));
beforeEach(() => { demoState = createDemoLimitState(); appearance.controls.clear(); });
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/features/local-art-preview', () => ({
  useLocalArtPreview: () => ({ screenTime: demoState, updateScreenTime: vi.fn() }),
}));

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup: (element: ReactNode) => string;
};

vi.mock('@/constants/theme', async importOriginal => {
  const theme = await importOriginal<typeof import('@/constants/theme')>();
  return { ...theme, useAppColors: () => theme.AppColorsLight };
});
vi.mock('@/components/form-sheet', () => ({
  FormSheet: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? children : null,
  ActionButton: ({ label }: { label: string }) => createElement('button', null, label),
}));
vi.mock('@/components/keyboard-form', () => ({ KeyboardTextInput: () => createElement('input') }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const host = ({ children, accessibilityLabel, accessibilityRole, disabled, style, ...props }: {
    children: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; disabled?: boolean;
    style?: unknown;
    'aria-valuemax'?: number; 'aria-valuenow'?: number;
  }) => {
    if (accessibilityLabel && (accessibilityRole === 'button' || accessibilityRole === 'radio')) appearance.controls.set(accessibilityLabel, { disabled, style });
    return createElement('div', { 'aria-label': accessibilityLabel, role: accessibilityRole, 'aria-disabled': disabled,
      'aria-valuemax': props['aria-valuemax'], 'aria-valuenow': props['aria-valuenow'] }, children);
  };
  return {
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    StyleSheet: { create: (styles: unknown) => styles },
    Pressable: host, View: host, Text: host,
  };
});

describe('local daily-limit preview', () => {
  it('matches the native control sizes while preserving disabled controls and pressed feedback', () => {
    renderToStaticMarkup(createElement(LocalPreviewScreenTimeControls));
    const styleOf = (label: string, pressed: boolean) => {
      const control = appearance.controls.get(label)!;
      const styles = (control.style as (state: { pressed: boolean }) => unknown[])({ pressed });
      return Object.assign({}, ...styles.filter(Boolean));
    };
    expect(styleOf('Choose apps', false)).toMatchObject({ minHeight: 50, borderRadius: 16, opacity: 1 });
    expect(styleOf('Choose apps', true)).toMatchObject({ opacity: 0.78 });
    expect(styleOf('Set allowance', true)).toMatchObject({ opacity: 0.5 });
    expect(appearance.controls.get('Set allowance')?.disabled).toBe(true);
    expect(styleOf('30 minute daily allowance', false)).toMatchObject({ minHeight: 44, minWidth: 56, flexGrow: 1 });
  });
  it('clearly disclaims enforcement and initially requires demo app selection', () => {
    const html = renderToStaticMarkup(createElement(LocalPreviewScreenTimeControls));
    expect(html.match(/App blocking and usage tracking are unavailable in this browser\./g)).toHaveLength(1);
    expect(html).toContain('Daily allowance is not set.');
    expect(html).toContain('aria-label="Set allowance" role="button" aria-disabled="true"');
    expect(html).toContain('Choose apps');
    expect(html).toContain('Reset allowance');
    for (const minutes of DAILY_LIMIT_OPTIONS) expect(html).toContain(`${minutes} minute daily allowance`);
    expect(html).not.toMatch(/\b(?:demo|sample|simulated?|simulation|preview|tester|beta|practice|example)\b/i);
    expect(html).not.toMatch(/apps are blocked|usage (?:measured|tracked)|Permission confirmed/i);
  });

  it('uses shared local state and pure limit rules, never services or native app access', () => {
    const source = readFileSync(new URL('./local-preview-screen-time-controls.tsx', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
    expect(imports).toEqual(['react', 'expo-router', 'react-native', '@/components/form-sheet', '@/components/keyboard-form', '@/components/section-heading', '@/components/screen-time-setup-checklist', '@/constants/theme', '@/constants/form-layout', '@/domain/daily-limit-controls', '@/domain/demo-screen-time', '@/features/local-art-preview']);
    expect(source).toContain('const state = preview.screenTime');
    expect(source).toContain('const dispatch = preview.updateScreenTime');
    expect(source).not.toContain('useReducer');
    expect(source).not.toMatch(/\b(?:fetch|setTimeout|setInterval|useEffect|localStorage|AsyncStorage|SecureStore)\b/);
    expect(source).not.toMatch(/wallet|appearance|supabase|requestAuthorization|requireNativeModule|requireNativeViewManager/);
    expect(source.match(/accessibilityRole="progressbar"/g)).toHaveLength(1);
    expect(source).toContain('Remaining allowance');
    expect(source).toContain('Selected apps');
    expect(source).toContain('accessibilityElementsHidden');
    expect(source).toContain('<FormSheet');
    expect(source).toContain('<KeyboardTextInput');
  });

  it('renders approved time in the same remaining-time bar and locks asking until exhausted', () => {
    demoState = demoLimitReducer(demoState, { type: 'toggle', app: 'Social feed' });
    demoState = demoLimitReducer(demoState, { type: 'minutes', minutes: 5 });
    demoState = demoLimitReducer(demoState, { type: 'enable' });
    demoState = demoLimitReducer(demoState, { type: 'simulate' });
    const exhausted = renderToStaticMarkup(createElement(LocalPreviewScreenTimeControls));
    expect(exhausted).toContain('aria-label="Ask for time" role="button" aria-disabled="false"');
    expect(exhausted).toContain('aria-valuenow="0"');

    demoState = demoLimitReducer(demoState, { type: 'grant', minutes: 15 });
    const approved = renderToStaticMarkup(createElement(LocalPreviewScreenTimeControls));
    expect(approved).toContain('Includes 15 approved extra minutes.');
    expect(approved).toContain('Allowance: 15 of 20 min left');
    expect(approved).toContain('Advance 5 minutes');
    expect(approved).not.toMatch(/\b(?:demo|sample|simulated?|simulation|preview|tester|beta|practice|example)\b/i);
    expect(approved).toContain('aria-valuemax="20" aria-valuenow="15"');
    expect(approved).toContain('aria-label="Ask for time" role="button" aria-disabled="true"');
    // A fresh screen render/remount consumes the provider's balance, not a
    // new component-local reducer that would forget the approval.
    expect(renderToStaticMarkup(createElement(LocalPreviewScreenTimeControls))).toBe(approved);
    expect(demoState.used).toBe(5);
    expect(demoState.approvedMinutes).toBe(15);

    for (let count = 0; count < 3; count++) demoState = demoLimitReducer(demoState, { type: 'simulate' });
    const used = renderToStaticMarkup(createElement(LocalPreviewScreenTimeControls));
    expect(used).toContain('aria-valuenow="0"');
    expect(used).toContain('aria-label="Ask for time" role="button" aria-disabled="false"');
  });

  it('labels the combined per-app total while keeping each allowance and simulation caveat visible', () => {
    for (const app of ['Social feed', 'Short videos', 'Games'] as const) demoState = demoLimitReducer(demoState, { type: 'toggle', app });
    demoState = demoLimitReducer(demoState, { type: 'perApp', allocations: { 'Social feed': 15, 'Short videos': 30, Games: 45 } });
    const html = renderToStaticMarkup(createElement(LocalPreviewScreenTimeControls));
    expect(html).toContain('90 min combined');
    for (const minutes of [15, 30, 45]) expect(html).toContain(`${minutes} min per day`);
    expect(html).toContain('Unused minutes cannot be borrowed by another app');
    expect(html.match(/App blocking and usage tracking are unavailable in this browser\./g)).toHaveLength(1);
    expect(html).toContain('Your allowance is set.');
    expect(html).not.toMatch(/\b(?:demo|sample|simulated?|simulation|preview|tester|beta|practice|example)\b/i);
  });

  it.each(['', '0', '-1', '1441', '2.5', '1e2', ' 15', '15 ', 'NaN', 'Infinity'])('rejects invalid custom minutes %j', text => {
    expect(parseDemoMinutes(text)).toBeNull();
  });

  it('shows only the configured base total when preparing to restart the demo limit', () => {
    demoState = demoLimitReducer(demoState, { type: 'toggle', app: 'Social feed' });
    demoState = demoLimitReducer(demoState, { type: 'minutes', minutes: 5 });
    demoState = demoLimitReducer(demoState, { type: 'enable' });
    demoState = demoLimitReducer(demoState, { type: 'simulate' });
    demoState = demoLimitReducer(demoState, { type: 'grant', minutes: 15 });
    demoState = demoLimitReducer(demoState, { type: 'stop' });
    const html = renderToStaticMarkup(createElement(LocalPreviewScreenTimeControls));
    expect(html).toContain('Daily total: 5 min');
    expect(html).not.toContain('Daily total: 20 min');
    expect(html).not.toContain('Includes 15 approved extra minutes.');
  });

  it.each(['1', '17', '30', '239', '1440'])('accepts whole custom minutes %s', text => {
    expect(parseDemoMinutes(text)).toBe(Number(text));
  });

  it('requires an app, enables custom shared minutes, and clamps simulated usage at zero remaining', () => {
    const initial = createDemoLimitState();
    expect(demoLimitReducer(initial, { type: 'enable' })).toEqual(initial);
    expect(demoLimitReducer(initial, { type: 'simulate' })).toEqual(initial);
    let state = demoLimitReducer(initial, { type: 'toggle', app: 'Social feed' });
    state = demoLimitReducer(state, { type: 'minutes', minutes: 7 });
    state = demoLimitReducer(state, { type: 'enable' });
    expect(demoLimitTotal(state)).toBe(7);
    state = demoLimitReducer(state, { type: 'simulate' });
    expect(state.used).toBe(5);
    expect(demoLimitReducer(state, { type: 'enable' })).toEqual(state);
    state = demoLimitReducer(state, { type: 'simulate' });
    state = demoLimitReducer(state, { type: 'simulate' });
    expect(demoLimitTotal(state) - state.used).toBe(0);
    expect(demoLimitReducer(state, { type: 'minutes', minutes: 30 })).toEqual(state);
    expect(demoLimitReducer(state, { type: 'toggle', app: 'Games' })).toEqual(state);
  });

  it('validates every selected app and combines separate allocations into one simulated budget', () => {
    let state = createDemoLimitState();
    for (const app of ['Social feed', 'Short videos', 'Games'] as const) state = demoLimitReducer(state, { type: 'toggle', app });
    expect(demoLimitReducer(state, { type: 'perApp', allocations: { 'Social feed': 17 } })).toEqual(state);
    expect(demoLimitReducer(state, { type: 'perApp', allocations: { 'Social feed': 17, 'Short videos': 0, Games: 1440 } })).toEqual(state);
    state = demoLimitReducer(state, { type: 'perApp', allocations: { 'Social feed': 17, 'Short videos': 1, Games: 1440 } });
    expect(state.mode).toBe('perApp');
    expect(state.enabled).toBe(true);
    expect(demoLimitTotal(state)).toBe(1458);
    state = demoLimitReducer(state, { type: 'simulate' });
    expect(demoLimitTotal(state) - state.used).toBe(1453);
    state = demoLimitReducer(state, { type: 'stop' });
    expect(state.allocations.Games).toBe(1440);
    state = demoLimitReducer(state, { type: 'toggle', app: 'Games' });
    expect(demoLimitTotal(state)).toBe(18);
    expect(demoLimitReducer(state, { type: 'reset' })).toEqual(createDemoLimitState());
  });

  it('keeps unselected app budgets valid and resets only the demo state', () => {
    let state = demoLimitReducer(createDemoLimitState(), { type: 'toggle', app: 'Social feed' });
    state = demoLimitReducer(state, { type: 'perApp', allocations: { 'Social feed': 8, Games: undefined } });
    expect(state.allocations.Games).toBe(30);
    expect(demoLimitReducer(state, { type: 'reset' })).toEqual(createDemoLimitState());
    expect(Object.keys(state).sort()).toEqual(['allocations', 'approvedMinutes', 'apps', 'choosing', 'enabled', 'minutes', 'mode', 'used']);
  });
});
