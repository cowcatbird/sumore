import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AppColorsDark, AppColorsLight } from '@/constants/theme';
import { SectionHeading } from './section-heading';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup: (element: ReactNode) => string;
};
const palette = vi.hoisted(() => ({ dark: true }));

vi.mock('@/constants/theme', async importOriginal => {
  const theme = await importOriginal<typeof import('@/constants/theme')>();
  return { ...theme, useAppColors: () => palette.dark ? theme.AppColorsDark : theme.AppColorsLight };
});
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const host = ({ children, style, accessibilityRole }: {
    children: ReactNode; style: unknown; accessibilityRole?: string;
  }) => createElement('div', {
    style: Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style,
    role: accessibilityRole === 'header' ? 'heading' : undefined,
  }, children);
  return {
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    StyleSheet: { create: (styles: unknown) => styles },
    View: host, Text: host,
  };
});

describe('quiet section headings', () => {
  it('uses the theme seam for a thin neutral divider, not an orange gradient', () => {
    for (const dark of [true, false]) {
      palette.dark = dark;
      const html = renderToStaticMarkup(createElement(SectionHeading, { title: 'Notifications' }));
      expect(html).toContain(`border-top-color:${dark ? AppColorsDark.seam : AppColorsLight.seam}`);
      expect(html).toContain('border-top-width:1px');
      expect(html).not.toContain('<svg');
    }
  });

  it('keeps the same heading geometry with and without a help action', () => {
    for (const action of [undefined, createElement('button', { style: { minHeight: 44 } }, '?')]) {
      const html = renderToStaticMarkup(createElement(SectionHeading, { title: 'Daily app limit', action }));
      expect(html).toContain('padding-top:16px');
      expect(html).toContain('min-height:44px');
      expect(html).toContain('align-items:center');
      // The simple host mock serializes native lineHeight as a unitless number.
      expect(html).toContain('font-size:19px;line-height:24;');
      expect(html).toContain('role="heading"');
    }
  });

  it('uses the shared layout for all three Setup dividers and retains the page-title band', () => {
    const settings = readFileSync(new URL('../app/settings.tsx', import.meta.url), 'utf8');
    const limits = readFileSync(new URL('./screen-time-controls.tsx', import.meta.url), 'utf8');
    const screenHeader = readFileSync(new URL('./screen-header.tsx', import.meta.url), 'utf8');
    expect(settings).toContain('<SectionHeading title="Notifications" />');
    expect(settings).toContain('<AccountControls />');
    expect(settings).toContain('<HelpFeedbackControls key={profile.id} />');
    expect(readFileSync(new URL('./account-controls.tsx', import.meta.url), 'utf8')).toContain('<SectionHeading title="Account" />');
    expect(readFileSync(new URL('./help-feedback-controls.tsx', import.meta.url), 'utf8')).toContain('<SectionHeading title="Help & feedback" />');
    expect(limits).toContain('<SectionHeading title="Daily app limit"');
    expect(settings).not.toContain('BlanketBand');
    expect(limits).not.toContain('BlanketBand');
    expect(screenHeader).toContain('<BlanketBand />');
  });
});
