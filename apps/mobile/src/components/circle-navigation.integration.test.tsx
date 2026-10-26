import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement, isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FriendsScreen from '@/app/friends';
import RequestsScreen from '@/app/requests';

type Button = { accessibilityLabel?: string; accessibilityValue?: { text?: string }; disabled?: boolean;
  onPress?: () => void; children: ReactNode; style?: Record<string, unknown> };
type Input = { accessibilityLabel: string; value: string; onChangeText: (value: string) => void };
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, buttons: new Map<string, Button>(), inputs: new Map<string, Input>(),
  focus: [] as (() => void | (() => void))[], params: {} as { section?: string; invite?: string },
  setParams: vi.fn(), push: vi.fn(), clearError: vi.fn(), join: vi.fn(), decide: vi.fn(), refill: vi.fn(),
  campfireRender: vi.fn(),
  friends: [] as { id: string; initials: string; displayName: string; friendCode: string }[],
  renderedText: [] as { content: string; numberOfLines?: number }[],
  safeEdges: [] as string[][], preview: false, busy: false, error: null as string | null, requests: true,
  redirect: null as unknown,
}));
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return '';
}
// Exercises real route/callback state with small native element substitutes.
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
  };
});
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Text: ({ children, numberOfLines }: { children: ReactNode; numberOfLines?: number }) => {
    h.renderedText.push({ content: text(children), numberOfLines });
    return createElement('span', null, children);
  },
  ScrollView: ({ children }: { children: ReactNode }) => createElement('main', null, children),
  Pressable: (props: Button) => {
    const label = props.accessibilityLabel ?? text(props.children).trim().replace(/\s+/g, ' ');
    h.buttons.set(label, props); return createElement('button', { disabled: props.disabled }, props.children);
  },
  Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? createElement('dialog', null, children) : null,
  ActivityIndicator: () => null, Keyboard: { dismiss: vi.fn() }, StyleSheet: { create: (value: unknown) => value },
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SafeAreaView: ({ children, edges }: { children: ReactNode; edges: string[] }) => {
    h.safeEdges.push(edges); return createElement('div', null, children);
  },
}));
vi.mock('expo-symbols', () => ({ SymbolView: () => null }));
vi.mock('expo-router', () => ({
  router: { push: h.push, setParams: h.setParams },
  useLocalSearchParams: () => h.params,
  useFocusEffect: (callback: () => void | (() => void)) => { h.focus.push(callback); },
  Redirect: ({ href }: { href: unknown }) => { h.redirect = href; return null; },
}));
vi.mock('@/constants/theme', () => ({
  useAppColors: () => ({ ink: '#fff', wool: '#222', inkSoft: '#aaa' }),
  Radius: { tin: 10, fold: 16 }, Shadow: {}, Space: { xs: 4, sm: 8, md: 12, lg: 24 }, Type: {}, stripeFor: () => 'ink',
}));
vi.mock('@/components/blanket-band', () => ({ BlanketBand: () => null }));
vi.mock('@/components/local-preview-banner', () => ({ LocalPreviewBanner: ({ actionLabel, onAction }: { actionLabel?: string; onAction?: () => void }) => {
  if (!h.preview) return null;
  if (actionLabel) h.buttons.set(actionLabel, { children: actionLabel, onPress: onAction });
  return createElement('span', null, 'Demo');
} }));
vi.mock('@/components/help-button', () => ({ HelpButton: () => null }));
vi.mock('@/components/community-rules', () => ({ CommunityRulesNotice: () => null }));
vi.mock('@/components/report-content-sheet', () => ({ ReportContentForm: () => null, ReportContentSheet: () => null }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: ({ title }: { title: string }) => createElement('h1', null, title) }));
vi.mock('@/components/campfire', () => ({ Campfire: ({ onPressYourCamper }: { onPressYourCamper: () => void }) => {
  h.campfireRender();
  h.buttons.set('Your camper', { children: 'Your camper', onPress: onPressYourCamper }); return createElement('span', null, 'Campfire');
} }));
vi.mock('@/components/circle-allocations', () => ({ CircleAllocations: () => createElement('span', null, 'Shared limits') }));
vi.mock('@/components/friend-code-actions', () => ({ FriendCodeActions: ({ code }: { code: string }) => createElement('span', null, `Own actions ${code}`) }));
vi.mock('@/components/keyboard-form', () => ({
  KeyboardForm: ({ children }: { children: ReactNode }) => createElement('form', null, children),
  KeyboardTextInput: (props: Input) => { h.inputs.set(props.accessibilityLabel, props); return createElement('input', { value: props.value, readOnly: true }); },
}));
vi.mock('@/features/local-art-preview', () => ({
  get isLocalArtPreview() { return h.preview; }, sampleLooks: [], useLocalArtPreview: () => h.preview ? { refillRequests: h.refill } : null,
}));
vi.mock('@/features/app-store', () => ({ useApp: () => ({
  profile: { id: 'self', friendCode: 'OWNER123' }, campfire: { seats: [] }, circleShop: { id: 'group' },
  friends: h.friends,
  incomingRequests: h.requests ? [{ id: 'request1', minutes: 15, reason: 'Finish reading', friend: { id: 'friend', initials: 'FR', displayName: 'Friend', friendCode: 'PRIVATE_PEER_CODE' } }] : [],
  busy: h.busy, error: h.error, clearError: h.clearError, joinSharedCircle: h.join, decideRequest: h.decide,
}) }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
function render() {
  h.cursor = 0; h.buttons.clear(); h.inputs.clear(); h.focus = []; h.safeEdges = []; h.renderedText = [];
  return renderToStaticMarkup(createElement(FriendsScreen));
}
function focus() { return h.focus.map(callback => callback()); }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function press(label: string) {
  const button = h.buttons.get(label)!; expect(button, `Missing ${label}`).toBeDefined();
  if (!button.disabled) button.onPress?.();
  await flush(); return render();
}
beforeEach(() => {
  vi.clearAllMocks(); h.slots = []; h.cursor = 0; h.params = {}; h.preview = false; h.busy = false; h.error = null; h.requests = true;
  h.friends = [{ id: 'friend', initials: 'FR', displayName: 'Friend', friendCode: 'PRIVATE_PEER_CODE' }];
  h.setParams.mockImplementation(params => { h.params = { ...h.params, ...params }; });
  h.decide.mockResolvedValue(undefined); h.join.mockResolvedValue(undefined);
});

describe('Circle navigation and invite actions', () => {
  it('shows Friends first with pending request count, safe area and no peer codes', () => {
    const html = render(); expect(html).toContain('Your circle'); expect(html).not.toContain('Campfire');
    expect(h.buttons.has('Requests, 1 pending')).toBe(true);
    expect(html).not.toContain('PRIVATE_PEER_CODE'); expect(html).not.toContain('OWNER123');
    expect(h.safeEdges).toContainEqual(['top', 'left', 'right']);
  });
  it.each([false, true])('keeps Friends, codes and requests available without mounting a campsite (preview=%s)', async preview => {
    h.preview = preview;
    const html = render();
    expect(h.campfireRender).not.toHaveBeenCalled();
    expect(h.buttons.has('Your camper')).toBe(false);
    expect(html).toContain('1 friend');
    expect(html).toContain('Shared limits');
    expect(h.buttons.has('Options for Friend')).toBe(true);
    expect(h.buttons.has('Manage circle')).toBe(true);
    expect(h.buttons.has('Show your friend code')).toBe(true);
    expect(h.buttons.has('Invite or join friends')).toBe(true);
    expect(await press('Show your friend code')).toContain('Own actions OWNER123');
    expect(await press('Invite or join friends')).toContain('Own actions OWNER123');
    expect(h.inputs.has('Your friend code')).toBe(false);
    expect(h.inputs.has('Your friend’s code')).toBe(true);
    await press('Close');
    expect(await press('Requests, 1 pending')).toContain('Finish reading');
    expect(h.buttons.has('Approve')).toBe(true);
    expect(h.buttons.has('Deny')).toBe(true);
    await press('Friends');
    expect(h.campfireRender).not.toHaveBeenCalled();
  });
  it('reveals copy/share only beside the owner code and hides it when viewing requests', async () => {
    const initial = render();
    expect(initial).not.toContain('OWNER123');
    expect(initial).not.toContain('Own actions');
    expect(h.buttons.get('Show your friend code')?.accessibilityValue).toBeUndefined();
    expect(await press('Show your friend code')).toContain('Own actions OWNER123');
    expect(h.buttons.get('Hide your friend code')?.accessibilityValue).toEqual({ text: 'OWNER123' });
    expect(await press('Requests, 1 pending')).not.toContain('OWNER123');
    expect(await press('Friends')).not.toContain('OWNER123');
    expect(h.setParams).toHaveBeenLastCalledWith({ section: 'friends' });
  });
  it('hides the owner reveal on focus cleanup', async () => {
    render(); const cleanups = focus(); render(); await press('Show your friend code');
    cleanups.forEach(cleanup => cleanup?.()); expect(render()).not.toContain('OWNER123');
  });
  it('loads incoming requests directly from the route and preserves both decisions', async () => {
    h.params = { section: 'requests' }; const html = render();
    expect(html).toContain('Finish reading'); expect(html).not.toContain('Campfire'); expect(html).not.toContain('PRIVATE_PEER_CODE');
    await press('Approve'); expect(h.decide).toHaveBeenLastCalledWith('request1', 'approved');
    await press('Deny'); expect(h.decide).toHaveBeenLastCalledWith('request1', 'denied');
  });
  it('keeps busy decisions disabled and displays store errors and empty state', async () => {
    h.params = { section: 'requests' }; h.busy = true; render();
    await press('Approve'); await press('Deny'); expect(h.decide).not.toHaveBeenCalled();
    h.busy = false; h.decide.mockRejectedValueOnce(new Error('handled by store')); h.error = 'Try again'; render();
    expect(await press('Approve')).toContain('Try again');
    h.requests = false; expect(render()).toContain('No requests');
  });
  it('retains preview request reload instead of replacing it with a live operation', async () => {
    h.preview = true; h.params = { section: 'requests' }; render();
    await press('Reload requests'); expect(h.refill).toHaveBeenCalledTimes(1); expect(h.decide).not.toHaveBeenCalled();
  });
  it('consumes a tour invite once, supports a future new invite and wraps the sheet in its own safe area', async () => {
    h.params = { section: 'friends', invite: '1' }; render(); focus();
    expect(render()).toContain('Own actions OWNER123');
    expect(h.setParams).toHaveBeenCalledExactlyOnceWith({ invite: undefined, section: 'friends' });
    expect(h.safeEdges).toContainEqual(['top', 'bottom', 'left', 'right']);
    await press('Close'); h.params.invite = '1'; render(); focus(); render();
    expect(h.inputs.has('Your friend’s code')).toBe(false); // Before router consumption is observed.
    h.params.invite = undefined; render(); focus();
    h.params.invite = '1'; render(); focus(); render();
    expect(h.inputs.has('Your friend’s code')).toBe(true);
  });
  it.each([false, true])('makes the owner code read-only without removing copy/share or joining (preview=%s)', async preview => {
    h.preview = preview;
    render();
    const html = await press('Invite or join friends');
    expect(html).toContain('OWNER123');
    expect(html).toContain('Own actions OWNER123');
    expect(html).toContain('Your permanent friend code. It cannot be changed.');
    expect(html).not.toContain('PRIVATE_PEER_CODE');
    expect([...h.inputs.keys()]).toEqual(['Your friend’s code']);
    expect(h.buttons.has('Save code')).toBe(false);
    h.inputs.get('Your friend’s code')!.onChangeText('OTHER123');
    expect(render()).toContain('Own actions OWNER123');
    await press('Close');
    expect(render()).not.toContain('OWNER123');
    expect(await press('Invite or join friends')).toContain('Own actions OWNER123');
  });
  it('requires explicit join confirmation and preserves existing circle warning', async () => {
    render(); await press('Invite or join friends');
    h.inputs.get('Your friend’s code')!.onChangeText('OTHER123'); render();
    expect(await press('Join circle')).toContain('Only you will move. Your old circle keeps its s’mores and unlocks.');
    expect(h.join).not.toHaveBeenCalled();
    expect(await press('Confirm and join')).toContain('Circle joined.');
    expect(h.join).toHaveBeenCalledExactlyOnceWith('OTHER123');
  });
  it('puts the people and their quiet menus before the invite panel and shared limits', () => {
    h.friends[0].displayName = 'Ridge the camper';
    const html = render();
    expect(html.indexOf('Your people')).toBeGreaterThan(-1);
    expect(html.indexOf('Ridge the camper')).toBeGreaterThan(html.indexOf('Your people'));
    expect(html.indexOf('Better with friends')).toBeGreaterThan(html.indexOf('Ridge the camper'));
    expect(html.indexOf('Shared limits')).toBeGreaterThan(html.indexOf('Better with friends'));
    expect(h.buttons.has('Invite or join friends')).toBe(true);
    expect(h.buttons.has('Options for Ridge the camper')).toBe(true);
    expect(html).not.toContain('OWNER123');
    expect(html).not.toContain('PRIVATE_PEER_CODE');
    expect(h.campfireRender).not.toHaveBeenCalled();
  });
  it.each([false, true])('keeps an empty Circle useful without inventing members or exposing a code (preview=%s)', preview => {
    h.preview = preview; h.friends = [];
    const html = render();
    expect(html).toContain('Just you, for now');
    expect(html).toContain('Invite someone to start your circle.');
    expect(html.indexOf('Better with friends')).toBeGreaterThan(html.indexOf('Just you, for now'));
    expect(h.buttons.has('Invite or join friends')).toBe(true);
    expect(h.buttons.has('Show your friend code')).toBe(true);
    expect([...h.buttons.keys()].filter(label => label.startsWith('Options for '))).toEqual([]);
    expect(html).not.toContain('OWNER123');
    expect(html).not.toContain('PRIVATE_PEER_CODE');
    expect(h.campfireRender).not.toHaveBeenCalled();
  });
  it('keeps long names intact and member controls at least 44 points without making the full row a button', () => {
    const displayName = 'A very long camper name that should wrap naturally across multiple lines';
    h.friends[0].displayName = displayName;
    const html = render();
    expect(html).toContain(displayName);
    expect(h.renderedText.find(node => node.content === displayName)?.numberOfLines).toBeUndefined();
    expect(h.buttons.get(`Options for ${displayName}`)?.style).toMatchObject({ width: 44, height: 44 });
    expect(h.buttons.get('Manage circle')?.style?.minHeight).toBeGreaterThanOrEqual(44);
    expect(h.buttons.has(displayName)).toBe(false);
  });
  it('retains the main Camp campsite and its camper customization entry', () => {
    const camp = readFileSync(new URL('../app/index.tsx', import.meta.url), 'utf8');
    expect(camp).toContain('<Campfire seats={campfire.seats}');
    expect(camp).toContain("onPressYourCamper={() => router.push('/customize')}");
  });
  it('redirects the legacy request route to Circle requests for installed notification links', () => {
    renderToStaticMarkup(createElement(RequestsScreen));
    expect(h.redirect).toEqual({ pathname: '/friends', params: { section: 'requests' } });
  });
});
