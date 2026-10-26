import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PUBLIC_INFO_URLS } from '@/constants/public-info';
import { PublicInfoLinks } from './public-info-links';

type LinkProps = {
  children: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint: string;
  accessibilityRole: string;
  accessibilityState: { disabled: boolean; busy: boolean };
  disabled: boolean;
};
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, links: new Map<string, LinkProps>(), openURL: vi.fn(),
}));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = initial;
      return [h.slots[index], (next: unknown) => { h.slots[index] = next; }];
    },
    useRef: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = { current: initial };
      return h.slots[index];
    },
  };
});
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Text: ({ children, accessibilityRole, selectable }: { children: ReactNode; accessibilityRole?: string; selectable?: boolean }) =>
    createElement('span', { role: accessibilityRole, 'data-selectable': selectable }, children),
  Pressable: (props: LinkProps) => {
    h.links.set(props.accessibilityLabel, props);
    return createElement('button', { role: props.accessibilityRole, 'aria-label': props.accessibilityLabel, disabled: props.disabled }, props.children);
  },
  Linking: { openURL: h.openURL },
}));
vi.mock('@/constants/theme', () => ({ Space: { xs: 8 }, Type: { bodySmall: {} },
  useAppColors: () => ({ inkSoft: '#abc', ember: '#fab' }) }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
function render(compact = false) {
  h.cursor = 0; h.links.clear();
  return renderToStaticMarkup(createElement(PublicInfoLinks, { compact }));
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
beforeEach(() => { h.slots = []; h.cursor = 0; h.links.clear(); h.openURL.mockReset().mockResolvedValue(undefined); });

describe('public information links', () => {
  it('offers privacy before sign-in and deletion instructions in Setup without unavailable copy', () => {
    expect(render(true)).toContain('Privacy policy');
    expect(render(true)).not.toContain('Account deletion help');
    const html = render();
    expect(html).toContain('Account deletion help');
    expect(html).not.toContain('Not implemented yet');
    expect(html).not.toContain('role="alert"');
    const auth = readFileSync(new URL('./auth-gate.tsx', import.meta.url), 'utf8');
    const help = readFileSync(new URL('./help-feedback-controls.tsx', import.meta.url), 'utf8');
    expect(auth).toContain('<PublicInfoLinks compact />');
    expect(help).toContain('<PublicInfoLinks />');
  });
  it.each([
    ['Privacy policy', 'https://sumore-support.vercel.app/privacy/'],
    ['Account deletion help', 'https://sumore-support.vercel.app/delete-account/'],
  ])('opens %s only when pressed, using its exact public HTTPS destination', async (label, url) => {
    render(); expect(h.openURL).not.toHaveBeenCalled();
    const link = h.links.get(label)!;
    expect(link.accessibilityRole).toBe('link');
    expect(link.accessibilityHint).toContain('browser');
    link.onPress(); await flush();
    expect(h.openURL).toHaveBeenCalledExactlyOnceWith(url);
    expect(render()).not.toContain('Could not open');
    expect(Object.values(PUBLIC_INFO_URLS)).toContain(url);
  });
  it('can open privacy from the compact, signed-out entry', async () => {
    render(true); h.links.get('Privacy policy')!.onPress(); await flush();
    expect(h.openURL).toHaveBeenCalledExactlyOnceWith(PUBLIC_INFO_URLS.privacy);
  });
  it('prevents repeated browser launches while opening and restores both links afterward', async () => {
    const pending = Promise.withResolvers<void>(); h.openURL.mockReturnValueOnce(pending.promise);
    render(); const privacy = h.links.get('Privacy policy')!; const deletion = h.links.get('Account deletion help')!;
    privacy.onPress(); privacy.onPress(); deletion.onPress();
    expect(h.openURL).toHaveBeenCalledTimes(1);
    expect(render()).toContain('Opening…');
    expect(h.links.get('Privacy policy')!.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(h.links.get('Account deletion help')!.disabled).toBe(true);
    pending.resolve(); await flush(); render();
    expect(h.links.get('Privacy policy')!.accessibilityState).toEqual({ disabled: false, busy: false });
    expect(h.links.get('Account deletion help')!.disabled).toBe(false);
  });
  it.each(['Privacy policy', 'Account deletion help'])('provides a selectable address after %s fails, then allows retry', async label => {
    h.openURL.mockRejectedValueOnce(new Error('Internal native failure details'));
    render(); h.links.get(label)!.onPress(); await flush();
    const html = render();
    expect(html).toContain('role="alert"'); expect(html).toContain('data-selectable="true"');
    expect(html).toContain('Could not open your browser');
    expect(html).toContain(label === 'Privacy policy' ? PUBLIC_INFO_URLS.privacy : PUBLIC_INFO_URLS.accountDeletion);
    expect(html).not.toContain('Internal native failure details');
    expect(h.links.get(label)!.disabled).toBe(false);
    h.links.get(label)!.onPress(); await flush();
    expect(render()).not.toContain('Could not open your browser');
    expect(h.openURL).toHaveBeenCalledTimes(2);
  });
});
