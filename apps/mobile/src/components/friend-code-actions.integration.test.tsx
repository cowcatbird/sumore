import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FriendCodeActions } from './friend-code-actions';

type Button = { accessibilityLabel: string; disabled: boolean; onPress: () => void };
type EffectSlot = { deps?: readonly unknown[]; cleanup?: () => void };
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
  buttons: new Map<string, Button>(), copy: vi.fn(), share: vi.fn(),
}));
// Explicit SSR/callback harness, not a substitute for native clipboard or layout QA.
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = initial;
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
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) => createElement('span', { role: accessibilityRole }, children),
  Pressable: (props: Button & { children: ReactNode }) => {
    h.buttons.set(props.accessibilityLabel, props);
    return createElement('button', { disabled: props.disabled }, props.children);
  },
  Share: { share: h.share },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: h.copy }));
vi.mock('@/constants/theme', () => ({ useAppColors: () => ({ ember: '#ff9', inkSoft: '#555', woolDeep: '#111', seam: '#ccc' }) }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let props: { code: string; disabled?: boolean; demo?: boolean };
let mountedCode: string | undefined;
function render() {
  // Model the CodeActions key boundary on an owner-code change.
  if (mountedCode !== undefined && props.code !== mountedCode) {
    for (const slot of h.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as EffectSlot).cleanup?.();
    h.slots = [];
  }
  mountedCode = props.code;
  h.cursor = 0; h.buttons.clear();
  const html = renderToStaticMarkup(createElement(FriendCodeActions, props));
  h.effects.splice(0).forEach(effect => effect());
  return html;
}
async function press(label: string) {
  const button = h.buttons.get(label)!; expect(button).toBeDefined();
  if (!button.disabled) button.onPress();
  await flush(); return render();
}
beforeEach(() => {
  vi.clearAllMocks(); h.slots = []; h.effects = []; h.cursor = 0;
  mountedCode = undefined;
  props = { code: 'OWNER123' }; h.copy.mockResolvedValue(true); h.share.mockResolvedValue({ action: 'sharedAction' });
});
afterEach(() => {
  for (const slot of h.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as EffectSlot).cleanup?.();
});

describe('friend code actions', () => {
  it('copies only the supplied owner code and confirms success', async () => {
    render(); expect(await press('Copy code')).toContain('Copied.');
    expect(h.copy).toHaveBeenCalledExactlyOnceWith('OWNER123');
    expect(h.share).not.toHaveBeenCalled();
  });
  it('opens the native share sheet with the owner code', async () => {
    render(); await press('Share code');
    expect(h.share).toHaveBeenCalledExactlyOnceWith({ title: 'Join my circle on sumore', message: 'Join my circle on sumore with my friend code: OWNER123' });
    expect(h.copy).not.toHaveBeenCalled();
  });
  it.each([false, 'reject'])('reports clipboard failure without showing success (%s)', async failure => {
    if (failure === false) h.copy.mockResolvedValueOnce(false);
    else h.copy.mockRejectedValueOnce(new Error('private platform detail'));
    render(); const html = await press('Copy code');
    expect(html).toContain('Could not copy. Try again.');
    expect(html).not.toContain('Copied.'); expect(html).not.toContain('private platform detail');
  });
  it('contains a share-sheet failure and offers copying', async () => {
    h.share.mockRejectedValueOnce(new Error('private platform detail'));
    render(); const html = await press('Share code');
    expect(html).toContain('Could not share. Try copying the code.');
    expect(html).not.toContain('private platform detail');
  });
  it('labels demo copying clearly and refuses external demo sharing even through the callback', async () => {
    props = { code: 'DEMO123', demo: true }; render();
    expect(h.buttons.get('Share code')!.disabled).toBe(true);
    h.buttons.get('Share code')!.onPress(); await flush();
    expect(h.share).not.toHaveBeenCalled();
    expect(await press('Copy code')).toContain('Copied. This code cannot connect real accounts.');
    expect(h.copy).toHaveBeenCalledExactlyOnceWith('DEMO123');
  });
  it.each([{ code: '' }, { code: 'OWNER123', disabled: true }])('blocks unavailable actions (%j)', async value => {
    props = value; render();
    for (const button of h.buttons.values()) { expect(button.disabled).toBe(true); button.onPress(); }
    await flush(); expect(h.share).not.toHaveBeenCalled(); expect(h.copy).not.toHaveBeenCalled();
  });
  it('prevents duplicate submissions and clears pending state when the owner code changes', async () => {
    const gate = Promise.withResolvers<boolean>(); h.copy.mockReturnValueOnce(gate.promise);
    render(); const callback = h.buttons.get('Copy code')!.onPress;
    callback(); callback(); render();
    expect(h.copy).toHaveBeenCalledTimes(1); expect(h.buttons.get('Copy code')!.disabled).toBe(true);
    props = { code: 'NEWCODE' }; render(); render();
    expect(h.buttons.get('Copy code')!.disabled).toBe(false);
    gate.resolve(true); await flush();
    expect(render()).not.toContain('Copied.');
    expect(await press('Copy code')).toContain('Copied.');
    expect(h.copy).toHaveBeenLastCalledWith('NEWCODE');
  });
});
