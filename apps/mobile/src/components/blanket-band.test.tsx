import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { BlanketBand } from './blanket-band';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup: (element: ReactNode) => string;
};

vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  return {
    Appearance: { getColorScheme: () => 'dark' },
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    StyleSheet: { create: (styles: unknown) => styles },
    View: ({ children, style, pointerEvents, importantForAccessibility }: {
      children: import('react').ReactNode; style: unknown[]; pointerEvents: string; importantForAccessibility: string;
    }) => createElement('div', {
      style: Object.assign({}, ...style.filter(Boolean)),
      'data-pointer-events': pointerEvents,
      'data-accessibility': importantForAccessibility,
    }, children),
  };
});
vi.mock('react-native-svg', () => ({
  default: 'svg', Defs: 'defs', LinearGradient: 'linearGradient', Rect: 'rect', Stop: 'stop',
}));

describe('firelight divider', () => {
  it('matches the reference with a continuous left-to-right orange gradient', () => {
    const html = renderToStaticMarkup(createElement(BlanketBand));
    expect(html).toContain('x1="0%" y1="0%" x2="100%" y2="0%"');
    expect(html).toContain('<stop offset="0%" stop-color="#C4551F"');
    expect(html).toContain('<stop offset="100%" stop-color="#FFAD66"');
    expect(html.match(/<stop /g)).toHaveLength(2);
    expect(html).toContain('height:6px');
  });

  it('preserves the shared sizing and optional rounded inset without intercepting input', () => {
    const html = renderToStaticMarkup(createElement(BlanketBand, { height: 4, inset: true }));
    expect(html).toContain('width:100%');
    expect(html).toContain('height:4px');
    expect(html).toContain('border-radius:999px');
    expect(html).toContain('viewBox="0 0 100 1" preserveAspectRatio="none"');
    expect(html).toContain('data-pointer-events="none"');
    expect(html).toContain('data-accessibility="no-hide-descendants"');
  });

  it('keeps gradient references distinct when a screen has several bars', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(BlanketBand), createElement(BlanketBand, { height: 5 })));
    const ids = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map(match => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(html).toContain(`fill="url(#${id})"`);
  });
});
