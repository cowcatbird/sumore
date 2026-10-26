import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScreenTimeStatus } from '@/types/domain';
import { FormSheet } from './form-sheet';
import { DailyTimeProgress, SelectedApps, selectedAppsGridHeight } from './selected-apps';

const m = vi.hoisted(() => ({
  platform: { OS: 'ios' }, manager: vi.fn(), dismiss: vi.fn(),
  close: null as (() => void) | null, press: null as (() => void) | null, disabled: false,
  edges: [] as string[], nativeProps: null as Record<string, unknown> | null,
  styles: [] as { role?: string; style: Record<string, unknown> }[],
}));
vi.mock('react-native', () => {
  const host = ({ children, accessibilityRole, accessibilityLabel, accessibilityValue, style }: {
    children: ReactNode; accessibilityRole?: string; accessibilityLabel?: string; accessibilityValue?: { now: number; max: number };
    style?: Record<string, unknown>;
  }) => {
    if (style) m.styles.push({ role: accessibilityRole, style });
    return createElement('div', { role: accessibilityRole, 'aria-label': accessibilityLabel,
      'aria-valuenow': accessibilityValue?.now, 'aria-valuemax': accessibilityValue?.max }, children);
  };
  return { Platform: m.platform, View: host, Text: host, Keyboard: { dismiss: m.dismiss },
    Modal: ({ children, visible, onRequestClose }: { children: ReactNode; visible: boolean; onRequestClose: () => void }) => {
      m.close = onRequestClose; return visible ? createElement('section', null, children) : null;
    },
    Pressable: ({ children, onPress, disabled }: { children: ReactNode; onPress: () => void; disabled: boolean }) => {
      m.press = onPress; m.disabled = disabled; return createElement('button', { disabled }, children);
    },
  };
});
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  SafeAreaView: ({ children, edges }: { children: ReactNode; edges: string[] }) => { m.edges = edges; return children; },
}));
vi.mock('@/components/keyboard-form', () => ({ KeyboardForm: ({ children }: { children: ReactNode }) => createElement('form', null, children) }));
vi.mock('@/constants/theme', () => ({ Radius: { fold: 16 }, Space: { md: 16, lg: 24 },
  useAppColors: () => ({ ground: '#fff', ink: '#111', inkSoft: '#555', wool: '#eee', woolDeep: '#ddd', seam: '#ccc', ember: '#f80' }) }));
vi.mock('expo-modules-core', () => ({ requireNativeViewManager: m.manager }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const render = (node: ReactNode) => renderToStaticMarkup(node);
const status = (patch: Partial<ScreenTimeStatus> = {}): ScreenTimeStatus => ({
  available: true, authorized: true, authorizationStatus: 'approved', shielded: false, blockingEnabled: true,
  selection: { applications: 2, categories: 0, webDomains: 0 }, temporaryAccessExpiresAt: null, appliedGrantId: null,
  message: '', mode: 'daily', dailyLimitMinutes: 30, usageMinutesToday: 10,
  consentGranted: true, usageAccessGranted: true, accessibilityEnabled: true, ...patch,
});
beforeEach(() => {
  vi.clearAllMocks(); m.platform.OS = 'ios'; m.nativeProps = null; m.styles = [];
  m.manager.mockReturnValue((props: Record<string, unknown>) => { m.nativeProps = props; return createElement('div', { 'data-native-selection': true }); });
});

describe('shared keyboard sheet', () => {
  it('closes with keyboard dismissal through the visible button and system back', () => {
    const onClose = vi.fn();
    expect(render(createElement(FormSheet, { title: 'Form', visible: true, onClose }, 'Field'))).toContain('<form>Field</form>');
    expect(m.edges).toEqual(['top', 'bottom', 'left', 'right']);
    expect(m.disabled).toBe(false);
    m.press!(); m.close!();
    expect(m.dismiss).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('blocks every close path while a form operation is in flight', () => {
    const onClose = vi.fn();
    render(createElement(FormSheet, { title: 'Form', visible: true, busy: true, onClose }));
    expect(m.disabled).toBe(true);
    m.press!(); m.close!();
    expect(m.dismiss).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });
});

describe('selected app and remaining-time rendering', () => {
  it('never loads native UI for browser previews, older binaries, or empty selections', () => {
    render(createElement(SelectedApps, { status: status(), refreshKey: 1 }));
    m.platform.OS = 'web';
    expect(render(createElement(SelectedApps, { status: status({ selectionDisplayAvailable: true }), refreshKey: 1 }))).toContain('Update the installed app');
    m.platform.OS = 'ios';
    expect(render(createElement(SelectedApps, { status: status({ selectionDisplayAvailable: true, selection: { applications: 0, categories: 0, webDomains: 0 } }), refreshKey: 1 }))).toBe('');
    expect(m.manager).not.toHaveBeenCalled();
  });
  it('passes only layout and refresh props, never app identities, to a supported native view', () => {
    render(createElement(SelectedApps, { status: status({ selectionDisplayAvailable: true, reportAvailable: true }), refreshKey: 42 }));
    expect(m.manager).toHaveBeenCalledExactlyOnceWith('ScreenTimeModule');
    expect(m.nativeProps).toEqual({ refreshKey: 42, style: { width: '100%', height: 236 } });
  });
  it('shows no fabricated bar when usage is unknown and avoids duplicating the iOS native report', () => {
    const unavailable = render(createElement(DailyTimeProgress, { status: status({ usageMinutesToday: null }) }));
    expect(unavailable).toContain('Time left isn’t available');
    expect(unavailable).not.toContain('progressbar');
    expect(render(createElement(DailyTimeProgress, { status: status({ reportAvailable: true }) }))).toBe('');
    expect(render(createElement(DailyTimeProgress, { status: status({ blockingEnabled: false }) }))).toBe('');
  });
  it('uses one combined Android bar, floors remaining at zero, and distinguishes approved extra time', () => {
    m.platform.OS = 'android';
    const html = render(createElement(DailyTimeProgress, { status: status({ limitMode: 'perApp', dailyLimitMinutes: 50,
      usageMinutesToday: 70, temporaryAccessExpiresAt: '2026-09-22T12:00:00Z' }) }));
    expect(html.match(/role="progressbar"/g)).toHaveLength(1);
    expect(html).toContain('aria-valuenow="0"'); expect(html).toContain('aria-valuemax="50"');
    expect(html).toContain('Extra time is separate');
    expect(html).toContain('50 min combined');
    expect(html).toContain('not one pool of time');
    expect(html).toContain('An app can be blocked while another still has time');
  });
  it('grows the native grid with the selection instead of reserving a fixed block', () => {
    // The regression this guards: a one-app selection used to be handed a
    // 360pt box, leaving most of the card empty under a single icon.
    const one = selectedAppsGridHeight(1, 295, false);
    const three = selectedAppsGridHeight(3, 295, false);
    const four = selectedAppsGridHeight(4, 295, false);
    expect(one).toBe(120);
    expect(three).toBe(one);
    expect(four).toBeGreaterThan(three);
    expect(selectedAppsGridHeight(1, 295, true)).toBe(one + 116);
    // A narrow card fits fewer columns, so the same count needs more rows.
    expect(selectedAppsGridHeight(3, 100, false)).toBeGreaterThan(three);
    // Before the first layout pass the grid still renders at a phone's width.
    expect(selectedAppsGridHeight(1, 0, false)).toBe(one);
  });
  it('matches the iOS grid geometry for mixed selections at column boundaries', () => {
    const swift = readFileSync(new URL('../../modules/screen-time/ios/ScreenTimeSelectionView.swift', import.meta.url), 'utf8');
    const dimension = (name: string) => {
      const value = swift.match(new RegExp(`static let ${name}: CGFloat = (\\d+)`));
      expect(value, `Missing native dimension ${name}`).not.toBeNull();
      return Number(value![1]);
    };
    const minimumColumn = dimension('minimumColumn');
    const columnSpacing = dimension('columnSpacing');
    for (const width of [100, 187, 188, 287, 288, 295, 375, 768]) {
      const columns = Math.max(1, Math.floor((width + columnSpacing) / (minimumColumn + columnSpacing)));
      for (const count of [1, 3, 4, 12]) {
        const rows = Math.ceil(count / columns);
        const expected = dimension('verticalPadding') * 2 + rows * dimension('minimumTileHeight')
          + (rows - 1) * dimension('rowSpacing');
        expect(selectedAppsGridHeight(count, width, false)).toBe(expected);
        expect(selectedAppsGridHeight(count, width, true)).toBe(expected + dimension('stackSpacing') + dimension('reportHeight'));
      }
    }
    // Apps, categories and websites all occupy the same kind of native tile.
    render(createElement(SelectedApps, { status: status({ selectionDisplayAvailable: true,
      selection: { applications: 1, categories: 2, webDomains: 1 } }), refreshKey: 9 }));
    expect(m.nativeProps).toEqual({ refreshKey: 9, style: { width: '100%', height: 240 } });
  });
  it('does not change the Android grid reservation for the iOS label fix', () => {
    m.platform.OS = 'android';
    expect(selectedAppsGridHeight(1, 295, false)).toBe(98);
    expect(selectedAppsGridHeight(3, 295, false)).toBe(98);
    expect(selectedAppsGridHeight(4, 295, false)).toBe(196);
  });
  it('keeps individual allowance guidance next to the untouched native app tiles', () => {
    const html = render(createElement(SelectedApps, { status: status({ selectionDisplayAvailable: true, limitMode: 'perApp' }), refreshKey: 4 }));
    expect(html).toContain('Individual daily allowances are shown under each app');
    expect(html).toContain('Unused minutes cannot be borrowed by another app');
    expect(m.nativeProps).toEqual({ refreshKey: 4, style: { width: '100%', height: 120 } });
  });
  it('does not display stale remaining time or claim protection after lost access or a reset failure', () => {
    m.platform.OS = 'android';
    for (const patch of [{ authorized: false }, { usageAccessGranted: false }, { accessibilityEnabled: false }, { requiresReset: true }, { available: false }]) {
      const html = render(createElement(DailyTimeProgress, { status: status(patch) }));
      expect(html).toContain('Remaining time cannot be confirmed');
      expect(html).not.toContain('progressbar');
      expect(html).not.toContain('saved limits still apply');
    }
  });
  it('adds themed panels and a clear numeric hierarchy without changing progress', () => {
    render(createElement(SelectedApps, { status: status({ selectionDisplayAvailable: true }), refreshKey: 7 }));
    expect(m.nativeProps).toEqual({ refreshKey: 7, style: { width: '100%', height: 120 } });
    expect(m.styles).toContainEqual(expect.objectContaining({ style: expect.objectContaining({ padding: 16, borderRadius: 16, borderColor: '#ccc', backgroundColor: '#ddd' }) }));
    m.platform.OS = 'android';
    const html = render(createElement(DailyTimeProgress, { status: status() }));
    expect(html).toContain('20 of 30 min left today');
    expect(html).toContain('aria-valuenow="20" aria-valuemax="30"');
    expect(m.styles).toContainEqual(expect.objectContaining({ style: expect.objectContaining({ fontSize: 24, fontVariant: ['tabular-nums'] }) }));
    expect(m.styles.find(node => node.role === 'progressbar')?.style).toMatchObject({ height: 10, borderRadius: 5, overflow: 'hidden' });
  });
});
