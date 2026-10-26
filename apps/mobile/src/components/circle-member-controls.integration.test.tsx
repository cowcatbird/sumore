import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CircleMemberControls, CircleMemberMenuButton } from './circle-member-controls';

type Button = { label?: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean; children?: ReactNode };
type EffectSlot = { deps?: readonly unknown[]; cleanup?: () => void };
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, layouts: [] as (() => void)[],
  buttons: new Map<string, Button>(), forms: new Map<string, { onClose: () => void; busy: boolean }>(),
  profileId: 'owner-a', groupId: 'circle-a' as string | undefined, friends: [{ id: 'scout-id', displayName: 'Scout' }], busy: false, demo: false,
  leave: vi.fn(), block: vi.fn(), unblock: vi.fn(), list: vi.fn(),
}));
// Executes production callbacks against controllable provider promises. This
// verifies ownership/confirmation behavior, not native visual presentation.
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
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = h.cursor++;
      const previous = h.slots[index] as EffectSlot | undefined;
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        h.layouts.push(() => {
          previous?.cleanup?.(); const cleanup = callback();
          h.slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
        });
      }
    },
  };
});
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) => createElement('span', { role: accessibilityRole }, children),
  ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel: string }) => createElement('span', null, accessibilityLabel),
  Pressable: (props: Button) => {
    if (props.accessibilityLabel) h.buttons.set(props.accessibilityLabel, props);
    return createElement('button', { disabled: props.disabled }, props.children);
  },
}));
vi.mock('expo-symbols', () => ({ SymbolView: () => null }));
vi.mock('@/components/report-content-sheet', () => ({ ReportContentForm: () => createElement('span', null, 'Report form') }));
vi.mock('@/components/form-sheet', () => ({
  ActionButton: (props: Button & { label: string }) => { h.buttons.set(props.label, props); return createElement('button', { disabled: props.disabled }, props.label); },
  FormSheet: ({ visible, title, children, ...props }: { visible: boolean; title: string; children: ReactNode; onClose: () => void; busy: boolean }) => {
    if (!visible) return null;
    h.forms.set(title, props); return createElement('section', { 'aria-label': title }, children);
  },
}));
vi.mock('@/constants/theme', () => ({ Radius: { fold: 10 }, Space: { xs: 8, md: 16 }, Type: { bodySmall: { fontSize: 13, lineHeight: 19 } }, useAppColors: () => ({ ink: '#111', inkSoft: '#555' }) }));
vi.mock('@/features/local-art-preview', () => ({ get isLocalArtPreview() { return h.demo; } }));
vi.mock('@/features/app-store', () => ({ useApp: () => ({ profile: { id: h.profileId }, circleShop: h.groupId ? { id: h.groupId } : undefined,
  friends: h.friends, busy: h.busy, leaveCircle: h.leave, blockPerson: h.block, unblockPerson: h.unblock, getBlockedPeople: h.list }) }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function render() {
  h.cursor = 0; h.buttons.clear(); h.forms.clear();
  const html = renderToStaticMarkup(createElement(CircleMemberControls, null,
    h.friends.map(friend => createElement(CircleMemberMenuButton, { key: friend.id, personId: friend.id, displayName: friend.displayName }))));
  h.layouts.splice(0).forEach(effect => effect());
  return html;
}
async function press(label: string) {
  const button = h.buttons.get(label);
  expect(button, `Missing ${label}`).toBeDefined();
  if (!button!.disabled) button!.onPress();
  await flush(); return render();
}
function switchOwner(id: string) { h.profileId = id; render(); return render(); }
async function openBlock() {
  await press('Options for Scout');
  return press('Block Scout');
}
beforeEach(() => {
  vi.clearAllMocks(); h.slots = []; h.cursor = 0; h.layouts = []; h.buttons.clear(); h.forms.clear();
  h.profileId = 'owner-a'; h.groupId = 'circle-a'; h.friends = [{ id: 'scout-id', displayName: 'Scout' }]; h.busy = false; h.demo = false;
  h.leave.mockResolvedValue(undefined); h.block.mockResolvedValue(undefined); h.unblock.mockResolvedValue(undefined); h.list.mockResolvedValue([]);
});
afterEach(() => {
  for (const slot of h.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as EffectSlot).cleanup?.();
});

describe('Circle member action confirmations', () => {
  it('does not mutate for opening/cancelling a person menu or leave confirmation', async () => {
    render(); await press('Options for Scout');
    expect(render()).toContain('They stay in the circle');
    await press('Block Scout'); await press('Cancel'); await press('Cancel');
    expect(h.forms.size).toBe(0);
    await press('Manage circle'); await press('Leave circle');
    const confirmation = render();
    expect(confirmation).toContain('Your account, private login key, and this phone’s app limits stay unchanged.');
    expect(confirmation).not.toContain('Your profile, private login key');
    expect(confirmation).toContain('This circle keeps its shared s’mores and purchases.');
    expect(confirmation).toContain('No one can approve your requests until you join a circle with friends.');
    await press('Cancel');
    expect(h.forms.has('Manage circle')).toBe(true);
    expect(h.leave).not.toHaveBeenCalled(); expect(h.block).not.toHaveBeenCalled(); expect(h.unblock).not.toHaveBeenCalled();
  });

  it('requires explicit block-and-leave, prevents rapid duplicates, and waits for confirmed success', async () => {
    const operation = Promise.withResolvers<void>(); h.block.mockReturnValue(operation.promise);
    render(); const confirmation = await openBlock();
    expect(confirmation).toContain('We store both account IDs and the block date');
    expect(confirmation).toContain('Unblocking or deleting either account removes the record.');
    expect(h.block).not.toHaveBeenCalled();
    const confirm = h.buttons.get('Confirm block Scout and leave circle')!.onPress;
    const cancel = h.buttons.get('Cancel')!.onPress;
    confirm(); confirm(); cancel(); await flush();
    expect(render()).toContain('Updating circle');
    expect(h.forms.get('Block Scout?')!.busy).toBe(true);
    h.forms.get('Block Scout?')!.onClose();
    expect(render()).not.toContain('Scout is blocked.');
    expect(h.block).toHaveBeenCalledExactlyOnceWith('scout-id');
    h.friends = []; h.groupId = 'new-personal-circle';
    h.list.mockResolvedValue([{ id: 'scout-id', displayName: 'Scout', blockedAt: '2026-09-29T12:00:00Z' }]);
    operation.resolve(); await flush();
    const done = render();
    expect(done).toContain('Scout is blocked. Your current circle is shown below; they were not removed.');
    expect(done).not.toContain('Updating circle');
    expect(h.buttons.get('Leave circle')!.disabled).toBe(true);
    expect(h.buttons.has('Unblock Scout')).toBe(true);
    expect(h.leave).not.toHaveBeenCalled();
  });

  it('keeps a failed leave visible in its confirmation with no invented success, then allows retry', async () => {
    h.leave.mockRejectedValueOnce(new Error('Could not leave while offline.'));
    render(); await press('Manage circle'); await press('Leave circle');
    const failure = await press('Confirm leave circle');
    expect(failure).toContain('Could not leave while offline.');
    expect(failure).toContain('role="alert"');
    expect(failure).not.toContain('Circle change confirmed.');
    expect(h.forms.has('Leave your circle?')).toBe(true);
    expect(h.buttons.get('Confirm leave circle')!.disabled).toBe(false);
    const done = await press('Confirm leave circle');
    expect(done).toContain('Circle change confirmed. Your current circle is shown below.');
    expect(h.leave).toHaveBeenCalledTimes(2);
  });

  it('requires unblock confirmation, handles failure, and never promises automatic rejoining', async () => {
    h.list.mockResolvedValue([{ id: 'blocked-scout', displayName: 'Scout', blockedAt: '2026-09-29T12:00:00Z' }]);
    render(); await press('Manage circle'); await press('Unblock Scout');
    expect(render()).toContain('does not automatically rejoin their circle');
    await press('Cancel'); expect(h.unblock).not.toHaveBeenCalled();
    await press('Unblock Scout'); h.unblock.mockRejectedValueOnce(new Error('Unblock could not be saved.'));
    expect(await press('Confirm unblock Scout')).toContain('Unblock could not be saved.');
    expect(h.buttons.has('Confirm unblock Scout')).toBe(true);
    const pending = Promise.withResolvers<void>(); h.unblock.mockReturnValueOnce(pending.promise);
    const confirm = h.buttons.get('Confirm unblock Scout')!.onPress;
    confirm(); confirm(); await flush();
    expect(render()).not.toContain('Scout is unblocked.');
    expect(h.unblock).toHaveBeenCalledTimes(2);
    pending.resolve(); await flush();
    const done = render();
    expect(done).toContain('Scout is unblocked. You have not rejoined a circle.');
    expect(done).toContain('No blocked people.');
    expect(h.leave).not.toHaveBeenCalled(); expect(h.block).not.toHaveBeenCalled();
    expect(h.unblock).toHaveBeenLastCalledWith('blocked-scout');
  });

  it('hides unavailable controls and disables leave in a solo circle', async () => {
    h.groupId = undefined; render();
    expect(h.buttons.has('Manage circle')).toBe(false); expect(h.buttons.has('Options for Scout')).toBe(false);
    expect(render()).toBe('');
    expect(h.list).not.toHaveBeenCalled();
    h.groupId = 'personal'; h.friends = []; render(); await press('Manage circle');
    expect(h.buttons.get('Leave circle')!.disabled).toBe(true);
    expect(await press('Leave circle')).toContain('You are already in a personal circle.');
    expect(h.leave).not.toHaveBeenCalled();
  });

  it('refuses a stale group confirmation and never sends a moved/missing member ID', async () => {
    render(); await openBlock(); h.groupId = 'different-circle'; render();
    expect(await press('Confirm block Scout and leave circle')).toContain('Your circle changed.');
    expect(h.block).not.toHaveBeenCalled();
    h.forms.get('Block Scout?')!.onClose(); render();
    await press('Manage circle'); await press('Leave circle'); h.friends = []; render();
    expect(await press('Confirm leave circle')).toContain('Your circle changed.');
    expect(h.leave).not.toHaveBeenCalled();
  });
});

describe('Circle UI async ownership and privacy', () => {
  it('ignores a late account-A mutation after A → B → A and releases busy for the new owner', async () => {
    const old = Promise.withResolvers<void>(); h.block.mockReturnValueOnce(old.promise);
    render(); await openBlock(); await press('Confirm block Scout and leave circle');
    expect(render()).toContain('Updating circle');
    switchOwner('owner-b'); expect(h.forms.size).toBe(0);
    expect(h.buttons.get('Options for Scout')!.disabled).toBe(false);
    switchOwner('owner-a'); await press('Manage circle');
    old.reject(new Error('Old account result must not appear.')); await flush();
    const html = render();
    expect(html).not.toContain('Old account result'); expect(html).not.toContain('Scout is blocked.');
    expect(h.buttons.get('Options for Scout')!.disabled).toBe(false); expect(h.forms.has('Manage circle')).toBe(true);
  });

  it('never reveals an older account’s blocked roster, or an earlier closed list response', async () => {
    const old = Promise.withResolvers<{ id: string; displayName: string; blockedAt: string }[]>(); h.list.mockReturnValueOnce(old.promise);
    render(); await press('Manage circle'); switchOwner('owner-b'); await press('Manage circle');
    old.resolve([{ id: 'secret-id', displayName: 'Old account private name', blockedAt: '2026-09-29T12:00:00Z' }]); await flush();
    expect(render()).not.toContain('Old account private name');
    h.forms.get('Manage circle')!.onClose(); render();
    const closed = Promise.withResolvers<{ id: string; displayName: string; blockedAt: string }[]>(); h.list.mockReturnValueOnce(closed.promise);
    await press('Manage circle'); h.forms.get('Manage circle')!.onClose(); render(); await press('Manage circle');
    closed.resolve([{ id: 'stale-id', displayName: 'Stale closed list', blockedAt: '2026-09-29T12:00:00Z' }]); await flush();
    expect(render()).not.toContain('Stale closed list');
  });

  it('keeps list failures separate from successful mutations and offers a safe read retry', async () => {
    h.list.mockRejectedValueOnce(new Error('Blocked people could not load.'));
    render(); const failure = await press('Manage circle');
    expect(failure).toContain('Blocked people could not load.'); expect(failure).not.toContain('No blocked people.');
    expect(await press('Retry blocked people')).toContain('No blocked people.');
    await press('Leave circle'); h.list.mockRejectedValueOnce(new Error('List refresh failed.'));
    const saved = await press('Confirm leave circle');
    expect(saved).toContain('Circle change confirmed.'); expect(saved).toContain('List refresh failed.');
    expect(h.leave).toHaveBeenCalledTimes(1);
  });

  it('reloads a list cancelled by a failed mutation when returning to Manage', async () => {
    const interrupted = Promise.withResolvers<{ id: string; displayName: string; blockedAt: string }[]>();
    h.list.mockReturnValueOnce(interrupted.promise); h.leave.mockRejectedValueOnce(new Error('Leave failed.'));
    render(); await press('Manage circle'); await press('Leave circle'); await press('Confirm leave circle');
    const back = await press('Cancel');
    expect(back).toContain('No blocked people.');
    expect(back).toContain('Leave failed.');
    expect(h.list).toHaveBeenCalledTimes(2);
    interrupted.resolve([{ id: 'old', displayName: 'Superseded response', blockedAt: '' }]); await flush();
    expect(render()).not.toContain('Superseded response');
  });

  it('labels preview actions and uses only provider boundaries without revealing IDs/codes', async () => {
    h.demo = true; render(); await openBlock();
    expect(render()).toContain('Changes here stay in this browser and do not affect your phone’s circle.');
    const result = await press('Confirm block Scout and leave circle');
    expect(result).toContain('Scout is blocked.'); expect(result).toContain('Saved in this browser only.');
    for (const privateValue of ['scout-id', 'owner-a', 'circle-a']) expect(result).not.toContain(privateValue);
    const source = readFileSync(new URL('./circle-member-controls.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]@\/(?:services|native|lib\/supabase)|\bfetch\(|Alert\./);
    expect(source).not.toMatch(/friendCode/);
    expect(source).toContain('Report person');
    const route = readFileSync(new URL('../app/friends.tsx', import.meta.url), 'utf8');
    expect(source).toContain('Options for ${displayName}');
    expect(route).toContain('<CircleMemberMenuButton personId={friend.id} displayName={friend.displayName} />');
  });
});
