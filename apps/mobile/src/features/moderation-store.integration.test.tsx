import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModerationProvider, useModeration } from './moderation-store';

type EffectSlot = { deps?: readonly unknown[]; cleanup?: () => void; callback?: unknown };
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, layouts: [] as (() => void)[], effects: [] as (() => void)[], owner: 'owner-a', preview: false,
  group: 'circle-a', friends: [{ id: 'friend-a' }], requests: [{ id: 'request-a', friend: { id: 'friend-a' } }],
  listeners: new Set<(state: string) => void>(), get: vi.fn(), accept: vi.fn(), report: vi.fn(),
}));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  const effect = (queue: (() => void)[], callback: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = h.cursor++, previous = h.slots[index] as EffectSlot | undefined;
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      queue.push(() => { previous?.cleanup?.(); const cleanup = callback(); h.slots[index] = { deps, cleanup }; });
    }
  };
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [h.slots[index], (next: unknown) => { h.slots[index] = typeof next === 'function' ? next(h.slots[index]) : next; }];
    },
    useRef: (initial: unknown) => { const index = h.cursor++; if (!(index in h.slots)) h.slots[index] = { current: initial }; return h.slots[index]; },
    useCallback: (callback: unknown, deps: readonly unknown[]) => {
      const index = h.cursor++, previous = h.slots[index] as EffectSlot | undefined;
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) h.slots[index] = { callback, deps };
      return (h.slots[index] as EffectSlot).callback;
    },
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(h.layouts, callback, deps),
    useEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => effect(h.effects, callback, deps),
  };
});
vi.mock('react-native', () => ({ AppState: { addEventListener: (_event: string, listener: (state: string) => void) => {
  h.listeners.add(listener); return { remove: () => h.listeners.delete(listener) };
} } }));
vi.mock('@/features/app-store', () => ({ useApp: () => ({ profile: { id: h.owner }, circleShop: { id: h.group }, friends: h.friends, incomingRequests: h.requests }) }));
vi.mock('@/features/local-art-preview', () => ({ get isLocalArtPreview() { return h.preview; } }));
vi.mock('@/services/moderation', () => ({ COMMUNITY_RULES_VERSION: '2026-10-12', getModerationStatus: (...args: unknown[]) => h.get(...args),
  acceptCommunityRules: (...args: unknown[]) => h.accept(...args), reportCircleContent: (...args: unknown[]) => h.report(...args) }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
let value: ReturnType<typeof useModeration>;
function Probe() {
  // Expose the current context to the callback-driving test harness only.
  // eslint-disable-next-line react-hooks/globals
  value = useModeration();
  return createElement('div', null, 'Personal controls stay available', JSON.stringify({ status: value.status, error: value.error }));
}
function dispose() {
  for (const slot of h.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as EffectSlot).cleanup?.();
}
function render() {
  h.cursor = 0;
  const html = renderToStaticMarkup(createElement(ModerationProvider, null, createElement(Probe)));
  h.layouts.splice(0).forEach(callback => callback()); h.effects.splice(0).forEach(callback => callback()); return html;
}
function switchAccount(owner: string) {
  // Mirrors React's disposal of the production AccountModeration key.
  dispose(); h.slots = []; h.layouts = []; h.effects = []; h.owner = owner; return render();
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const status = (acceptedRulesVersion: string | null = null) => ({ rulesVersion: '2026-10-12', acceptedRulesVersion, restriction: null, notices: [], isModerator: false });
const target = { ownerId: 'owner-a', circleId: 'circle-a', targetUserId: 'friend-a', displayName: 'Friend', kind: 'person' as const };
beforeEach(() => {
  vi.clearAllMocks(); h.slots = []; h.cursor = 0; h.layouts = []; h.effects = []; h.listeners.clear();
  h.owner = 'owner-a'; h.group = 'circle-a'; h.preview = false; h.friends = [{ id: 'friend-a' }]; h.requests = [{ id: 'request-a', friend: { id: 'friend-a' } }];
  h.get.mockResolvedValue(status()); h.accept.mockResolvedValue(status('2026-10-12')); h.report.mockResolvedValue({ reportId: 'report-a', status: 'received' });
});
afterEach(dispose);

describe('Account-scoped moderation provider', () => {
  it('refreshes on first mount and foreground, with manual retry and no shell lock on server error', async () => {
    expect(render()).toContain('Personal controls stay available'); await flush(); render();
    expect(h.get).toHaveBeenCalledExactlyOnceWith('owner-a'); expect(value.status?.acceptedRulesVersion).toBeNull();
    h.get.mockRejectedValueOnce(new Error('Community controls need a server update.'));
    h.listeners.forEach(listener => listener('active')); await flush(); const failed = render();
    expect(failed).toContain('server update'); expect(failed).toContain('Personal controls stay available');
    await value.refresh(); render(); expect(value.error).toBeNull(); expect(h.get).toHaveBeenCalledTimes(3);
  });
  it('never loads or mutates the real backend for a browser preview', async () => {
    h.preview = true; render(); await flush(); render(); await value.refresh();
    expect(value.status?.isModerator).toBe(false); expect(value.status?.acceptedRulesVersion).toBeNull();
    await expect(value.acceptRules()).rejects.toThrow('unavailable in this browser');
    await expect(value.report(target, 'spam', '', 'receipt-a')).rejects.toThrow('No report was sent');
    expect(h.get).not.toHaveBeenCalled(); expect(h.accept).not.toHaveBeenCalled(); expect(h.report).not.toHaveBeenCalled();
  });
  it('ignores old account responses through A → B → A and clears private statuses immediately', async () => {
    const old = Promise.withResolvers<ReturnType<typeof status>>(); h.get.mockReturnValueOnce(old.promise);
    render(); switchAccount('owner-b'); await flush(); render(); switchAccount('owner-a'); await flush(); render();
    old.resolve({ ...status(), isModerator: true }); await flush(); render();
    expect(value.status?.isModerator).toBe(false); expect(h.listeners.size).toBe(1);
  });
  it('ignores stale status refresh responses and prevents refresh overwriting confirmed acceptance', async () => {
    render(); await flush(); render();
    const old = Promise.withResolvers<ReturnType<typeof status>>(); h.get.mockReturnValueOnce(old.promise);
    const loading = value.refresh(); const accepted = value.acceptRules();
    h.listeners.forEach(listener => listener('active')); await accepted; render();
    expect(h.get).toHaveBeenCalledTimes(2); expect(value.status?.acceptedRulesVersion).toBe('2026-10-12');
    old.resolve(status()); await loading; render(); expect(value.status?.acceptedRulesVersion).toBe('2026-10-12');
  });
  it('binds explicit acceptance to the displayed policy and prevents two concurrent writes', async () => {
    render(); await flush(); render();
    const pending = Promise.withResolvers<ReturnType<typeof status>>(); h.accept.mockReturnValueOnce(pending.promise);
    const first = value.acceptRules(); await expect(value.acceptRules()).rejects.toThrow('wait for your current action');
    expect(h.accept).toHaveBeenCalledExactlyOnceWith('owner-a', '2026-10-12');
    pending.resolve(status('2026-10-12')); await first; render(); expect(value.accepting).toBe(false);
  });
  it('refuses an unseen future policy version', async () => {
    h.get.mockResolvedValue({ ...status(), rulesVersion: 'future' }); render(); await flush(); render();
    await expect(value.acceptRules()).rejects.toThrow('Update sumore'); expect(h.accept).not.toHaveBeenCalled();
  });
  it('captures the exact report target, never a caller-supplied text snapshot', async () => {
    render(); await flush(); render(); await value.report({ ...target, kind: 'request', requestId: 'request-a' }, 'harassment', 'Context', 'receipt-a');
    expect(h.report).toHaveBeenCalledExactlyOnceWith('owner-a', 'circle-a', { targetUserId: 'friend-a', targetRequestId: 'request-a',
      reason: 'harassment', details: 'Context', clientReportId: 'receipt-a' });
  });
  it.each(['circle', 'member', 'request'])('refuses a stale %s at the report boundary', async change => {
    render(); await flush(); render(); const report = value.report;
    if (change === 'circle') h.group = 'circle-b'; else if (change === 'member') h.friends = []; else h.requests = [];
    render(); await expect(report({ ...target, kind: 'request', requestId: 'request-a' }, 'spam', '', 'receipt-a')).rejects.toThrow('changed');
    expect(h.report).not.toHaveBeenCalled();
  });
  it('rejects old account callbacks after provider unmount, before any mutation', async () => {
    render(); await flush(); render(); const old = value; switchAccount('owner-b'); await flush(); render();
    await expect(old.report(target, 'spam', '', 'receipt-a')).rejects.toThrow('changed');
    await expect(old.acceptRules()).rejects.toThrow('changed'); expect(h.report).not.toHaveBeenCalled(); expect(h.accept).not.toHaveBeenCalled();
  });
  it('does not claim a report result if the circle changes in flight', async () => {
    render(); await flush(); render(); const pending = Promise.withResolvers<unknown>(); h.report.mockReturnValueOnce(pending.promise);
    const sending = value.report(target, 'spam', '', 'receipt-a'); h.group = 'circle-b'; render(); pending.resolve({ status: 'received' });
    await expect(sending).rejects.toThrow('report may have been received'); expect(h.report).toHaveBeenCalledTimes(1);
  });
});
