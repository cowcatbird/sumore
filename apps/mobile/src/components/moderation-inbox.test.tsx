import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModerationInbox, moderationActions, reportedAppLabels } from './moderation-inbox';
import type { ModerationReport } from '@/services/moderation';

type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
type Button = { onPress: () => unknown; disabled?: boolean };
const h = vi.hoisted(() => ({
  slots: [] as unknown[], effects: [] as (() => void)[], cursor: 0,
  buttons: new Map<string, Button>(), listeners: new Set<(state: string) => void>(),
  inputs: new Map<string, (text: string) => void>(), owner: 'owner-a', appState: 'active', preview: false,
  isModerator: true, statusLoading: false, statusError: null as string | null,
  refresh: vi.fn(), queue: vi.fn(), review: vi.fn(),
}));
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  const effect = (callback: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = h.cursor++;
    const previous = h.slots[index] as Effect | undefined;
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      h.effects.push(() => { previous?.cleanup?.(); h.slots[index] = { deps, cleanup: callback() }; });
    }
  };
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = initial;
      return [h.slots[index], (value: unknown) => { h.slots[index] = typeof value === 'function' ? value(h.slots[index]) : value; }];
    },
    useRef: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = { current: initial };
      return h.slots[index];
    },
    useCallback: (callback: unknown, deps: readonly unknown[]) => {
      const index = h.cursor++;
      const previous = h.slots[index] as { callback: unknown; deps: readonly unknown[] } | undefined;
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) h.slots[index] = { callback, deps };
      return (h.slots[index] as { callback: unknown }).callback;
    },
    useEffect: effect, useLayoutEffect: effect,
  };
});
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  Pressable: ({ children, accessibilityLabel, ...props }: Button & { children: ReactNode; accessibilityLabel: string }) => {
    h.buttons.set(accessibilityLabel, props); return createElement('button', { disabled: props.disabled }, children);
  },
  ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel: string }) => createElement('span', null, accessibilityLabel),
  AppState: { get currentState() { return h.appState; }, addEventListener: (_: string, listener: (state: string) => void) => {
    h.listeners.add(listener); return { remove: () => h.listeners.delete(listener) };
  } },
}));
vi.mock('@/constants/theme', () => ({ Radius: {}, Space: {}, Type: {}, useAppColors: () => ({}) }));
vi.mock('@/constants/form-layout', () => ({ formControlStyle: {} }));
vi.mock('@/features/app-store', () => ({ useApp: () => ({ profile: { id: h.owner } }) }));
vi.mock('@/features/moderation-store', () => ({ useModeration: () => ({
  status: { isModerator: h.isModerator }, loading: h.statusLoading, error: h.statusError, refresh: h.refresh, preview: h.preview,
}) }));
vi.mock('@/services/moderation', () => ({ getModerationQueue: h.queue, reviewModerationReport: h.review }));
vi.mock('@/components/form-sheet', () => ({
  FormSheet: ({ children, visible }: { children: ReactNode; visible: boolean }) => visible ? createElement('section', null, children) : null,
  ActionButton: ({ label, ...props }: Button & { label: string }) => {
    h.buttons.set(label, props); return createElement('button', { disabled: props.disabled }, label);
  },
}));
vi.mock('@/components/keyboard-form', () => ({ KeyboardTextInput: ({ accessibilityLabel, onChangeText }: { accessibilityLabel: string; onChangeText: (text: string) => void }) => {
  h.inputs.set(accessibilityLabel, onChangeText); return createElement('textarea');
} }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const render = () => {
  h.cursor = 0; h.buttons.clear(); h.inputs.clear();
  const html = renderToStaticMarkup(createElement(ModerationInbox));
  const effects = h.effects.splice(0); effects.forEach(effect => effect());
  return html;
};
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const unmount = () => { h.slots.forEach(slot => (slot as Effect | undefined)?.cleanup?.()); };
const report = (patch: Partial<ModerationReport> = {}): ModerationReport => ({
  id: 'report-one', targetUserId: 'target', targetDisplayName: 'Reported camper', kind: 'person',
  reason: 'harassment', details: 'Report details', snapshot: { displayName: 'Name at report time', sharedLabels: [{ label: 'Shared label', minutes: 15 }] },
  status: 'open', createdAt: '2026-10-12T12:00:00Z', version: 2, action: null, ...patch,
});
beforeEach(() => {
  unmount(); h.slots = []; h.effects = []; h.listeners.clear(); h.buttons.clear(); h.inputs.clear();
  h.owner = 'owner-a'; h.appState = 'active'; h.preview = false; h.isModerator = true; h.statusLoading = false; h.statusError = null;
  h.refresh.mockReset().mockResolvedValue(undefined); h.queue.mockReset().mockResolvedValue([report()]); h.review.mockReset().mockResolvedValue({ reportId: 'report-one', status: 'resolved', version: 3 });
});

describe('private moderator inbox', () => {
  it.each(['unauthorized', 'preview', 'checking', 'failed-check'] as const)('does not read or expose report contents when %s', mode => {
    if (mode === 'unauthorized') h.isModerator = false;
    if (mode === 'preview') h.preview = true;
    if (mode === 'checking') h.statusLoading = true;
    if (mode === 'failed-check') h.statusError = 'Access could not be checked.';
    const html = render();
    expect(html).not.toContain('Reported camper'); expect(h.queue).not.toHaveBeenCalled(); expect(h.review).not.toHaveBeenCalled();
  });
  it('reads only the owner-scoped queue and labels snapshots as historic content, not proof', async () => {
    render(); await flush(); const html = render();
    expect(h.queue).toHaveBeenCalledWith('owner-a', 'open');
    expect(html).toContain('Name at report time'); expect(html).toContain('Shared label · 15 min');
    expect(html).toContain('not necessarily what is visible now'); expect(html).toContain('allegation, not proof');
    expect(h.review).not.toHaveBeenCalled();
  });
  it('requires a deliberate confirmation and user-visible reason before restricting', async () => {
    render(); await flush(); render(); h.buttons.get('Restrict social features')!.onPress(); render();
    expect(h.buttons.get('Confirm: restrict social features')?.disabled).toBe(true); expect(h.review).not.toHaveBeenCalled();
    h.inputs.get('Moderator review message')!('Please stop sending abusive requests.'); h.buttons.get('1 day')!.onPress(); render();
    h.buttons.get('Confirm: restrict social features')!.onPress(); await flush();
    expect(h.review).toHaveBeenCalledExactlyOnceWith('owner-a', { reportId: 'report-one', expectedVersion: 2,
      action: 'restrict', moderatorNote: 'Please stop sending abusive requests.', restrictionDays: 1 });
  });
  it('explains that person removal replaces the name and clears captured optional labels', async () => {
    render(); await flush(); render(); h.buttons.get('Remove reported content')!.onPress(); const html = render();
    expect(html).toContain('display name with “Camper”'); expect(html).toContain('clears all captured optional shared app labels');
    expect(html).toContain('only if they are still unchanged'); expect(h.review).not.toHaveBeenCalled();
  });
  it('shows the captured request category and explicitly preserves time approval when removing text', async () => {
    h.queue.mockResolvedValue([report({ kind: 'request', snapshot: { displayName: 'Name at report time', requestReason: 'Original request note', requestCategoryLabel: 'Original category' } })]);
    render(); await flush(); const list = render(); expect(list).toContain('Original request note'); expect(list).toContain('Original category');
    h.buttons.get('Remove reported content')!.onPress(); const html = render();
    expect(html).toContain('minutes, approval, and any granted time stay unchanged'); expect(h.review).not.toHaveBeenCalled();
  });
  it('blocks duplicate confirmation taps synchronously', async () => {
    const pending = Promise.withResolvers<{ reportId: string; status: string; version: number }>(); h.review.mockReturnValue(pending.promise);
    render(); await flush(); render(); h.buttons.get('Dismiss report')!.onPress(); render();
    const confirm = h.buttons.get('Confirm: dismiss report')!;
    confirm.onPress(); confirm.onPress(); render(); expect(h.review).toHaveBeenCalledOnce();
    expect(h.buttons.get('Saving review…')?.disabled).toBe(true); pending.resolve({ reportId: 'report-one', status: 'dismissed', version: 3 }); await flush();
    expect(render()).toContain('Review saved.');
  });
  it('reloads the queue after a stale version or uncertain result without resending the action', async () => {
    h.review.mockRejectedValue(new Error('This report changed. Review the latest version.'));
    render(); await flush(); render(); h.buttons.get('Dismiss report')!.onPress(); render();
    h.queue.mockResolvedValue([]); h.buttons.get('Confirm: dismiss report')!.onPress(); await flush();
    const html = render(); expect(h.review).toHaveBeenCalledOnce(); expect(h.queue.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('This report changed.'); expect(html).not.toContain('Review saved.'); expect(html).not.toContain('Confirm: dismiss report');
  });
  it('supports reviewed restriction appeals with an explicit restore reason', async () => {
    h.queue.mockResolvedValue([report({ status: 'resolved', action: 'restrict' })]);
    render(); await flush(); render(); h.buttons.get('Resolved reports')!.onPress(); render(); await flush(); render();
    expect(h.queue).toHaveBeenCalledWith('owner-a', 'resolved');
    h.buttons.get('Restore social features')!.onPress(); render(); expect(h.buttons.get('Confirm: restore social features')?.disabled).toBe(true);
    h.inputs.get('Moderator review message')!('Appeal reviewed; restriction removed.'); render(); h.buttons.get('Confirm: restore social features')!.onPress(); await flush();
    expect(h.review).toHaveBeenCalledWith('owner-a', expect.objectContaining({ action: 'restore', moderatorNote: 'Appeal reviewed; restriction removed.', restrictionDays: null }));
  });
  it('ignores completed operations after its account session unmounts', async () => {
    const pending = Promise.withResolvers<ModerationReport[]>(); h.queue.mockReturnValue(pending.promise);
    render(); unmount(); const before = [...h.slots]; pending.resolve([report()]); await flush();
    expect(h.slots).toEqual(before); expect(h.listeners.size).toBe(0);
    const source = readFileSync(new URL('./moderation-inbox.tsx', import.meta.url), 'utf8');
    expect(source).toContain('key={profile.id}'); expect(source).toContain('if (!status.isModerator)');
  });
  it('ignores older filter reads that finish after the current queue', async () => {
    const oldRead = Promise.withResolvers<ModerationReport[]>(); h.queue.mockReturnValueOnce(oldRead.promise);
    render(); h.buttons.get('Resolved reports')!.onPress();
    h.queue.mockResolvedValue([report({ targetDisplayName: 'Resolved camper', status: 'resolved' })]);
    render(); await flush(); expect(render()).toContain('Resolved camper');
    oldRead.resolve([report({ targetDisplayName: 'Stale camper' })]); await flush();
    const html = render(); expect(html).toContain('Resolved camper'); expect(html).not.toContain('Stale camper');
  });
  it('invalidates an old confirmation immediately when its queue is refreshed', async () => {
    render(); await flush(); render(); h.buttons.get('Dismiss report')!.onPress(); render();
    const oldConfirm = h.buttons.get('Confirm: dismiss report')!;
    h.buttons.get('Refresh reports')!.onPress(); oldConfirm.onPress(); await flush();
    expect(h.review).not.toHaveBeenCalled();
  });
  it('pages beyond 100 closed reports so a later restriction can be restored', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => report({ id: `report-${index}`, status: 'resolved', action: 'warn' }));
    h.queue.mockResolvedValue(firstPage);
    render(); await flush(); render(); h.buttons.get('Resolved reports')!.onPress(); render(); await flush(); render();
    expect(h.buttons.get('Previous page')?.disabled).toBe(true); expect(h.buttons.get('Next page')?.disabled).toBe(false);
    h.queue.mockResolvedValue([report({ id: 'later-restriction', targetDisplayName: 'Later restricted camper', status: 'resolved', action: 'restrict' })]);
    h.buttons.get('Next page')!.onPress(); render(); await flush(); const secondPage = render();
    expect(h.queue).toHaveBeenLastCalledWith('owner-a', 'resolved', { createdAt: firstPage[99].createdAt, id: 'report-99' });
    expect(secondPage).toContain('Later restricted camper'); expect(secondPage).toContain('Page 2');
    expect(h.buttons.has('Restore social features')).toBe(true); expect(h.buttons.get('Next page')?.disabled).toBe(true);
    h.queue.mockResolvedValue(firstPage); h.buttons.get('Previous page')!.onPress(); render(); await flush();
    expect(h.queue).toHaveBeenLastCalledWith('owner-a', 'resolved'); expect(render()).toContain('Page 1');
  });
  it('can return from an empty later page and resets the cursor for a new status filter', async () => {
    h.queue.mockResolvedValue(Array.from({ length: 100 }, (_, index) => report({ id: `report-${index}` })));
    render(); await flush(); render(); h.queue.mockResolvedValue([]); h.buttons.get('Next page')!.onPress(); render(); await flush();
    const emptyPage = render(); expect(emptyPage).toContain('No open reports on this page'); expect(h.buttons.get('Previous page')?.disabled).toBe(false);
    h.buttons.get('Previous page')!.onPress(); render(); await flush(); expect(h.queue).toHaveBeenLastCalledWith('owner-a', 'open');
    render(); h.buttons.get('Dismissed reports')!.onPress(); render(); await flush();
    expect(h.queue).toHaveBeenLastCalledWith('owner-a', 'dismissed'); expect(render()).toContain('Page 1');
  });
  it('does not let an old page read overwrite a newly selected filter', async () => {
    h.queue.mockResolvedValue(Array.from({ length: 100 }, (_, index) => report({ id: `report-${index}` })));
    render(); await flush(); render();
    const pendingPage = Promise.withResolvers<ModerationReport[]>(); h.queue.mockReturnValueOnce(pendingPage.promise);
    h.buttons.get('Next page')!.onPress(); render();
    h.queue.mockResolvedValue([report({ targetDisplayName: 'New filter result', status: 'resolved', action: 'warn' })]);
    h.buttons.get('Resolved reports')!.onPress(); render(); await flush(); expect(render()).toContain('New filter result');
    pendingPage.resolve([report({ targetDisplayName: 'Stale page result' })]); await flush();
    const html = render(); expect(html).toContain('New filter result'); expect(html).not.toContain('Stale page result');
    expect(h.queue).toHaveBeenLastCalledWith('owner-a', 'resolved');
  });
  it('hides reports immediately while backgrounded and rechecks access on return', async () => {
    render(); await flush(); render(); h.listeners.forEach(listener => listener('background'));
    expect(render()).not.toContain('Reported camper'); h.listeners.forEach(listener => listener('active')); expect(h.refresh).toHaveBeenCalled();
  });
});

describe('review safety presentation', () => {
  it('offers no account actions for deleted targets and only restores reviewed restrictions', () => {
    expect(moderationActions(report({ targetUserId: null }))).toEqual(['dismiss']);
    expect(moderationActions(report({ status: 'resolved', action: 'restrict' }))).toEqual(['restore']);
    expect(moderationActions(report({ status: 'resolved', action: 'warn' }))).toEqual([]);
    expect(moderationActions(report({ status: 'dismissed' }))).toEqual([]);
  });
  it('never serializes extra fields from reported label objects', () => {
    expect(reportedAppLabels([{ label: 'Video', minutes: 30, privateLoginKey: 'never-render' }, { privateLoginKey: 'never-render' }, null])).toEqual(['Video · 30 min']);
    expect(reportedAppLabels({ privateLoginKey: 'never-render' })).toEqual([]);
  });
});
