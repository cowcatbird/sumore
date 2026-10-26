import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FormLayout, formControlStyle, formSectionStyle } from '@/constants/form-layout';
import { Radius, Space } from '@/constants/theme';
import { ActionButton } from './form-sheet';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup: (node: ReactNode) => string;
};
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const host = ({ children, style, disabled }: { children?: ReactNode; style?: object; disabled?: boolean }) =>
    createElement('button', { style, disabled }, children);
  return {
    Platform: { OS: 'web', select: (choices: Record<string, unknown>) => choices.web ?? choices.default },
    View: host, Text: host, Pressable: host, Modal: host, Keyboard: { dismiss: vi.fn() },
  };
});
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => children,
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/keyboard-form', () => ({ KeyboardForm: ({ children }: { children: ReactNode }) => children }));
const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('consistent form geometry', () => {
  it('matches the existing folded-corner theme and spacing scale', () => {
    expect(FormLayout.controlHeight).toBe(50);
    expect(FormLayout.controlRadius).toBe(Radius.fold);
    expect(FormLayout.sectionGap).toBe(Space.sm);
    expect(FormLayout.sectionSpacing).toBe(Space.lg);
    expect(FormLayout.dividerPadding).toBe(Space.md);
    expect(formControlStyle).toEqual({ minHeight: 50, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12 });
    expect(formSectionStyle).toEqual({ gap: 12 });
  });
  it.each([{},{ primary: true },{ danger: true },{ disabled: true }])('keeps primary, secondary, danger and disabled actions the same shape (%j)', props => {
    const html = renderToStaticMarkup(createElement(ActionButton, { label: 'Account action', onPress: () => {}, ...props }));
    expect(html).toContain('min-height:50px');
    expect(html).toContain('border-radius:16px');
    expect(html).toContain('padding-horizontal:16px');
    expect(html).toContain('padding-vertical:12px');
  });
  it('uses the shared controls in Setup, account sheets, feedback and real/demo Screen Time', () => {
    for (const file of ['../app/settings.tsx','./account-controls.tsx','./help-feedback-controls.tsx','./screen-time-controls.tsx','./local-preview-screen-time-controls.tsx']) {
      const source = read(file);
      expect(source).toContain("from '@/constants/form-layout'");
      expect(source).toContain('...formControlStyle');
      expect(source).toContain('formSectionStyle');
      expect(source).not.toMatch(/minHeight:\s*(46|48|52)\b/);
    }
    expect(read('../app/settings.tsx')).not.toMatch(/marginTop:\s*Space\.(?:sm|xs)/);
    expect(read('./screen-time-controls.tsx')).not.toContain('borderRadius: Radius.coal');
    expect(read('./local-preview-screen-time-controls.tsx')).not.toContain('borderRadius: Radius.coal');
  });
  it('keeps compact time chips and multiline reports intentionally distinct', () => {
    for (const file of ['./screen-time-controls.tsx','./local-preview-screen-time-controls.tsx']) {
      expect(read(file)).toMatch(/option:\s*\{[^}]*minHeight: 44[^}]*borderRadius: Radius\.tin/);
    }
    expect(read('./help-feedback-controls.tsx')).toContain('minHeight: 150, maxHeight: 240');
  });
  it('reserves the status-bar inset once and preserves the keyboard-aware form/sheets', () => {
    const setup = read('../app/settings.tsx');
    expect(setup).toContain("<SafeAreaView edges={['top']}");
    expect(setup).toContain('contentInsetAdjustmentBehavior="never"');
    expect(setup).toContain('<KeyboardForm');
    expect(setup).not.toContain('KeyboardAvoidingView');
    const sheet = read('./form-sheet.tsx');
    expect(sheet).toContain("edges={['top', 'bottom', 'left', 'right']}");
    expect(sheet).toContain('<KeyboardForm');
    expect(sheet).toContain('gap: FormLayout.sectionGap');
    expect(sheet).toContain('if (!busy) { Keyboard.dismiss(); onClose(); }');
  });
});
