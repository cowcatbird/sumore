import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { FormLayout } from '@/constants/form-layout';
import { SettingsActionRow } from './settings-action-row';

vi.mock('react-native', () => ({
  Platform: { select: (values: Record<string, unknown>) => values.web ?? values.default },
  Pressable: ({ children, style, accessibilityLabel, accessibilityState, disabled }: {
    children: ReactNode; style: (state: { pressed: boolean }) => object; accessibilityLabel: string;
    accessibilityState: { disabled: boolean }; disabled: boolean;
  }) => createElement('button', { style: style({ pressed: false }), 'aria-label': accessibilityLabel,
    'aria-disabled': accessibilityState.disabled, disabled }, children),
  View: ({ children, style, accessibilityElementsHidden }: { children: ReactNode; style?: object; accessibilityElementsHidden?: boolean }) =>
    createElement('div', { style, 'aria-hidden': accessibilityElementsHidden }, children),
  Text: ({ children, style }: { children: ReactNode; style: object }) => createElement('span', { style }, children),
}));
vi.mock('expo-symbols', () => ({
  SymbolView: ({ name }: { name: { web: string } }) => createElement('i', { 'data-symbol': name.web }),
}));
vi.mock('@/constants/theme', async importOriginal => {
  const theme = await importOriginal<typeof import('@/constants/theme')>();
  return { ...theme, useAppColors: () => theme.AppColorsDark };
});
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const render = (disabled = false) => renderToStaticMarkup(createElement(SettingsActionRow, {
  label: 'Login key · tap to view', icon: { ios: 'key', android: 'key', web: 'key' }, onPress: vi.fn(), disabled,
}));

describe('Setup action row presentation', () => {
  it('uses the shared growing tap target with icon, left-aligned label and chevron', () => {
    const html = render();
    expect(html).toContain(`min-height:${FormLayout.controlHeight}px`);
    expect(html).toContain(`border-radius:${FormLayout.controlRadius}px`);
    expect(html).toContain('data-symbol="key"');
    expect(html).toContain('data-symbol="chevron_right"');
    expect(html).toContain('flex-shrink:1');
    expect(html).not.toContain('text-align:center');
    const source = readFileSync(new URL('./settings-action-row.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('numberOfLines');
    expect(source).not.toContain('height: FormLayout.controlHeight');
  });

  it('exposes one descriptive button target and hides both decorative symbols', () => {
    const html = render(true);
    expect(html).toContain('aria-label="Login key · tap to view"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('disabled=""');
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
  });

  it('keeps account recovery outside Setup in its existing button presentation', () => {
    const account = readFileSync(new URL('./account-controls.tsx', import.meta.url), 'utf8');
    expect(account).toContain('<RestoreAccountButton appearance="row" />');
    expect(account).toContain("appearance = 'button'");
    expect(account).toContain('<ActionButton label="Already have an account?" onPress={openRestore} />');
  });
});
