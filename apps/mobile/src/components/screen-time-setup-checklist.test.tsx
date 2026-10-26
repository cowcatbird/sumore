import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { demoScreenTimeSetupReadiness, screenTimeSetupReadiness } from '@/domain/daily-limit-controls';
import type { ScreenTimeStatus } from '@/types/domain';
import { ScreenTimeSetupChecklist } from './screen-time-setup-checklist';

const recorded = vi.hoisted(() => ({ styles: [] as Record<string, unknown>[] }));
vi.mock('react-native', () => {
  const host = ({ children, accessibilityLabel, accessibilityRole, style }: { children: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; style?: Record<string, unknown> }) => {
    if (style) recorded.styles.push(style);
    return createElement('div', { 'aria-label': accessibilityLabel, role: accessibilityRole }, children);
  };
  return { View: host, Text: host };
});
vi.mock('@/constants/theme', () => ({ Radius: { fold: 16, tin: 10 }, Space: { md: 16 },
  useAppColors: () => ({ ink: '#fff', inkSoft: '#ccc', wool: '#123', woolDeep: '#012', seam: '#345', ember: '#fa6', emberWash: '#321', emberLow: '#b52', scarlet: '#c43' }) }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const status: ScreenTimeStatus = {
  available: true, authorized: true, authorizationStatus: 'approved', blockingEnabled: true, shielded: false,
  selection: { applications: 2, categories: 0, webDomains: 0 }, mode: 'daily', dailyLimitMinutes: 90,
  temporaryAccessExpiresAt: null, appliedGrantId: null, message: '', dailyLimitsAvailable: true,
};
beforeEach(() => { recorded.styles = []; });

describe('Screen Time setup checklist rendering', () => {
  it('announces individually completed steps without claiming active shields', () => {
    const html = renderToStaticMarkup(createElement(ScreenTimeSetupChecklist, { readiness: screenTimeSetupReadiness(status, 'ios') }));
    for (const step of ['App access', 'Choose apps', 'Enable a daily limit']) expect(html).toContain(`${step}: complete.`);
    expect(html).toContain('Enabled does not mean blocked right now.');
    expect(html).not.toContain('role="alert"');
  });
  it('announces an actionable warning and removes permission/limit completion after revocation', () => {
    const html = renderToStaticMarkup(createElement(ScreenTimeSetupChecklist, { readiness: screenTimeSetupReadiness({ ...status, authorized: false }, 'ios') }));
    expect(html).toContain('App access: needed.');
    expect(html).toContain('Enable a daily limit: needed.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('access is restored below');
  });
  it('makes the demo checklist explicitly about simulation', () => {
    const html = renderToStaticMarkup(createElement(ScreenTimeSetupChecklist, { readiness: demoScreenTimeSetupReadiness(3, true) }));
    expect(html).toContain('Daily limit setup');
    expect(html).toContain('App blocking and usage tracking are unavailable in this browser.');
    expect(html).toContain('Your allowance is set.');
    expect(html).not.toMatch(/\b(?:demo|sample|simulated?|simulation|preview|tester|beta|practice|example)\b/i);
    expect(html).not.toContain('App access: complete');
  });
  it('uses legible step markers and seam dividers without hiding incomplete steps or warnings', () => {
    const html = renderToStaticMarkup(createElement(ScreenTimeSetupChecklist, { readiness: screenTimeSetupReadiness({ ...status, authorized: false }, 'ios') }));
    const markers = recorded.styles.filter(style => style.width === 28 && style.height === 28);
    expect(markers).toHaveLength(3);
    expect(markers.every(style => style.borderRadius === 14 && style.borderWidth === 1)).toBe(true);
    expect(recorded.styles.filter(style => style.borderTopWidth === 1)).toHaveLength(2);
    expect(recorded.styles).toContainEqual(expect.objectContaining({ borderLeftWidth: 3, borderLeftColor: '#c43', padding: 12 }));
    expect(html).toContain('Choose apps: complete.');
    expect(html).toContain('Enable a daily limit: needed.');
    expect(html).toContain('role="alert"');
  });
});
