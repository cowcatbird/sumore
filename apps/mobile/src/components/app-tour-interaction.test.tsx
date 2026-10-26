import { createRequire } from 'node:module';
import { createElement, isValidElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppTourState } from '@/domain/app-tour-state';
import { AppTourProvider } from './app-tour';

// Executes actual provider/button handlers with a real tour store. This tests
// routing order and account boundaries, not native modal rendering or layout.
const h = vi.hoisted(() => ({
  store: null as ReturnType<typeof createAppTourState> | null,
  pending: { current: null as unknown }, profileId: 'person-a', platform: 'ios',
  buttons: new Map<string, () => void>(), effects: [] as (() => unknown)[], frames: [] as FrameRequestCallback[],
  dismissModal: null as (() => void) | null, push: vi.fn(), write: vi.fn(), dismissKeyboard: vi.fn(),
  states: [] as unknown[], stateCursor: 0, refs: [] as { current: unknown }[], refCursor: 0,
  layoutCursor: 0, layoutEffects: [] as (() => unknown)[], cleanups: [] as (() => void)[],
  pager: null as null | { navigationState: { index: number; routes: { key: string; index: number }[] };
    onSwipeStart: () => void; onIndexChange: (index: number) => void; swipeEnabled: boolean; animationEnabled: boolean },
  jumpTo: vi.fn(), focusedInput: null as unknown, capture: null as (() => boolean) | null,
  keyboardVisible: false, listeners: new Map<string, (value?: boolean) => void>(),
  motion: vi.fn(), reader: vi.fn(),
}));
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.stateCursor++;
      if (!index) return [h.store, vi.fn()];
      if (!(index in h.states)) h.states[index] = initial;
      return [h.states[index], (value: unknown) => { h.states[index] = value; }];
    },
    useRef: (initial: unknown) => {
      const index = h.refCursor++;
      if (!index) return h.pending;
      return h.refs[index] ??= { current: initial };
    },
    useLayoutEffect: (effect: () => unknown) => { if (h.layoutCursor++ > 0) h.layoutEffects.push(effect); },
    useEffect: (effect: () => unknown) => { h.effects.push(effect); } };
});
function label(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(label).join('');
  if (isValidElement<{ children: ReactNode }>(node)) return label(node.props.children);
  return '';
}
vi.mock('react-native', () => {
  const content = ({ children }: { children: ReactNode }) => createElement('div', null, children);
  return {
    View: ({ onStartShouldSetResponderCapture, children }: { onStartShouldSetResponderCapture?: () => boolean; children: ReactNode }) => {
      if (onStartShouldSetResponderCapture) h.capture = onStartShouldSetResponderCapture;
      return content({ children });
    }, Text: content, ScrollView: content,
    Modal: ({ visible, children, onDismiss }: { visible: boolean; children: ReactNode; onDismiss: () => void }) => {
      h.dismissModal = onDismiss; return visible ? createElement('section', null, children) : null;
    },
    Pressable: ({ accessibilityLabel, children, onPress }: { accessibilityLabel?: string; children: ReactNode; onPress: () => void }) => {
      h.buttons.set(accessibilityLabel ?? label(children), onPress);
      return createElement('button', null, children);
    },
    Keyboard: { dismiss: h.dismissKeyboard, isVisible: () => h.keyboardVisible,
      addListener: (name: string, listener: () => void) => { h.listeners.set(name, listener); return { remove: () => h.listeners.delete(name) }; } },
    AccessibilityInfo: { isReduceMotionEnabled: h.motion, isScreenReaderEnabled: h.reader,
      addEventListener: (name: string, listener: (value: boolean) => void) => { h.listeners.set(name, value => listener(Boolean(value))); return { remove: () => h.listeners.delete(name) }; } },
    TextInput: { State: { currentlyFocusedInput: () => h.focusedInput } },
    StyleSheet: { create: (value: unknown) => value },
    Platform: { get OS() { return h.platform; } }, useWindowDimensions: () => ({ width: 360, height: 640 }),
  };
});
vi.mock('react-native-tab-view', () => ({ TabView: (props: NonNullable<typeof h.pager> & {
  renderScene: (props: { route: { key: string; index: number } }) => ReactNode;
  renderTabBar: (props: { jumpTo: typeof h.jumpTo }) => ReactNode;
}) => {
  h.pager = props;
  return createElement('main', null, props.renderTabBar({ jumpTo: h.jumpTo }),
    props.renderScene({ route: props.navigationState.routes[props.navigationState.index] }));
} }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  SafeAreaView: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  useSafeAreaInsets: () => ({ top: 44, bottom: 20, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({ router: { push: h.push } }));
vi.mock('expo-symbols', () => ({ SymbolView: () => null }));
vi.mock('@/components/character-sprite', () => ({ BrandLogo: () => null, CharacterSprite: () => null, HatSprite: () => null }));
vi.mock('@/components/smore-sprite', () => ({ SMoreSprite: () => null }));
vi.mock('@/constants/theme', () => ({ Radius: {}, Space: {}, useAppColors: () => ({}) }));
vi.mock('@/features/app-store', () => ({ useApp: () => ({ isReady: true, isAuthenticated: true, profile: { id: h.profileId, displayName: 'Camper' } }) }));
vi.mock('@/lib/storage', () => ({ appStorage: {} }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const tick = async () => { for (let count = 0; count < 8; count++) await Promise.resolve(); };
function render() {
  h.cleanups.splice(0).forEach(cleanup => cleanup());
  h.buttons.clear(); h.effects = []; h.pager = null; h.capture = null;
  h.stateCursor = 0; h.refCursor = 0; h.layoutCursor = 0; h.layoutEffects = [];
  const html = renderToStaticMarkup(createElement(AppTourProvider, null, createElement('main', null, 'Actual app')));
  [...h.layoutEffects.splice(0), ...h.effects.splice(0)].forEach(effect => {
    const cleanup = effect(); if (typeof cleanup === 'function') h.cleanups.push(cleanup as () => void);
  });
  return html;
}
function press(name: string) { expect(h.buttons.has(name), name).toBe(true); h.buttons.get(name)!(); }
beforeEach(async () => {
  vi.clearAllMocks(); h.platform = 'ios'; h.profileId = 'person-a'; h.pending.current = null; h.frames = [];
  h.cleanups.splice(0).forEach(cleanup => cleanup());
  h.states = []; h.refs = []; h.keyboardVisible = false; h.focusedInput = null; h.pager = null; h.capture = null; h.listeners.clear();
  h.motion.mockResolvedValue(false); h.reader.mockResolvedValue(false);
  h.push.mockReset(); h.write.mockResolvedValue(undefined);
  h.store = createAppTourState({ getItem: async () => null, setItem: h.write }, () => '2026-09-26T00:00:00Z');
  h.store.bindProfile('person-a'); await tick();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => h.frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => { h.cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); });

describe('tour activities use the real screens without completing onboarding', () => {
  it('waits for iOS modal dismissal, opens the real invite, and resumes the next slide from a banner', () => {
    render(); press('Add friends');
    expect(h.push).not.toHaveBeenCalled();
    expect(h.store!.getSnapshot()).toMatchObject({ visible: false, step: 0, activity: 'friends' });
    expect(render()).toContain('Continue tour');
    expect(h.buttons.has('Next tour step')).toBe(false);
    h.dismissModal!(); h.dismissModal!();
    expect(h.push).toHaveBeenCalledExactlyOnceWith({ pathname: '/friends', params: { invite: '1', section: 'friends' } });
    press('Continue tour');
    expect(h.store!.getSnapshot()).toEqual({ profileId: 'person-a', visible: true, step: 1 });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.dismissKeyboard).toHaveBeenCalledTimes(2);
  });
  it('opens customization and still requires Finish after resuming the last slide', async () => {
    h.store!.setStep(4); render(); press('Customize camper'); render(); h.dismissModal!();
    expect(h.push).toHaveBeenCalledExactlyOnceWith('/customize');
    press('Continue tour'); render();
    expect(h.store!.getSnapshot().step).toBe(5);
    expect(h.write).not.toHaveBeenCalled();
    press('Finish tour'); await tick();
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.write.mock.calls[0][1])).toHaveProperty('completedAt');
  });
  it.each(['android', 'web'])('dispatches the %s route after the hidden modal commits', platform => {
    h.platform = platform; render(); press('Add friends');
    expect(h.push).not.toHaveBeenCalled(); render();
    expect(h.push).not.toHaveBeenCalled();
    h.frames.splice(0).forEach(frame => frame(0));
    expect(h.push).toHaveBeenCalledTimes(1);
  });
  it('ignores stale navigation and Back callbacks when the account changes', async () => {
    h.store!.setStep(4); render(); const oldBack = h.buttons.get('Previous tour step')!; press('Customize camper');
    h.profileId = 'person-b'; h.store!.bindProfile('person-b'); await tick(); render();
    h.dismissModal!(); oldBack(); await tick();
    expect(h.push).not.toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
    expect(h.store!.getSnapshot()).toEqual({ profileId: 'person-b', visible: true, step: 0 });
  });
  it('reopens the current slide if activity navigation throws', () => {
    h.push.mockImplementationOnce(() => { throw new Error('Synthetic route failure'); });
    h.store!.setStep(4); render(); press('Customize camper'); render(); h.dismissModal!();
    expect(h.store!.getSnapshot()).toEqual({ profileId: 'person-a', visible: true, step: 4 });
    expect(h.write).not.toHaveBeenCalled();
  });
  it('leaves the first-slide header empty and moves backward without dismissing or writing a checkpoint', () => {
    render();
    expect(h.buttons.has('Previous tour step')).toBe(false);
    expect(h.buttons.has('Skip tour')).toBe(false);
    press('Next tour step'); render();
    expect(h.buttons.has('Previous tour step')).toBe(true);
    press('Previous tour step'); render();
    expect(h.store!.getSnapshot()).toEqual({ profileId: 'person-a', visible: true, step: 0 });
    expect(h.buttons.has('Previous tour step')).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
  });
  it('offers Back on every later slide and only Finish can complete the last slide', () => {
    for (let step = 1; step < 6; step++) {
      h.store!.setStep(step); render();
      expect(h.buttons.has('Skip tour')).toBe(false);
      expect(h.buttons.has('Finish tour')).toBe(step === 5);
      press('Previous tour step');
      expect(h.store!.getSnapshot()).toEqual({ profileId: 'person-a', visible: true, step: step - 1 });
    }
    expect(h.write).not.toHaveBeenCalled();
  });
});

describe('the intro pager changes real tour state without bypassing completion', () => {
  it.each(['ios', 'android', 'web'])('swipes forward and backward on %s while keeping the buttons available', async platform => {
    h.platform = platform; render(); await tick(); render();
    expect(h.pager!.swipeEnabled).toBe(true);
    expect(h.pager!.navigationState.routes.map(route => route.key)).toEqual(['circle', 'request', 'limits', 'reward', 'customize', 'login']);
    h.pager!.onSwipeStart(); h.pager!.onIndexChange(1); render();
    expect(h.store!.getSnapshot()).toMatchObject({ visible: true, step: 1 });
    expect(h.buttons.has('Previous tour step')).toBe(true);
    h.pager!.onSwipeStart(); h.pager!.onIndexChange(0); render();
    expect(h.store!.getSnapshot()).toMatchObject({ visible: true, step: 0 });
    expect(h.buttons.has('Add friends')).toBe(true);
    expect(h.write).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled();
  });

  it('ignores programmatic, invalid, and multi-page callbacks and restores the current page', () => {
    render(); h.pager!.onIndexChange(1);
    expect(h.store!.getSnapshot().step).toBe(0);
    expect(h.jumpTo).toHaveBeenCalledWith('circle');
    for (const target of [-1, 2, 6, Number.NaN]) {
      h.pager!.onSwipeStart(); h.pager!.onIndexChange(target);
      expect(h.store!.getSnapshot().step).toBe(0);
    }
    expect(h.write).not.toHaveBeenCalled();
  });

  it('does not let a late swipe override Next or an activity suspension', () => {
    render(); const firstPager = h.pager!; firstPager.onSwipeStart();
    press('Next tour step'); render(); firstPager.onIndexChange(0);
    expect(h.store!.getSnapshot().step).toBe(1);
    expect(h.jumpTo).toHaveBeenCalledWith('request');
    press('Previous tour step'); render(); const activityPager = h.pager!; activityPager.onSwipeStart();
    press('Add friends'); render(); activityPager.onIndexChange(1);
    expect(h.store!.getSnapshot()).toMatchObject({ visible: false, step: 0, activity: 'friends' });
    expect(h.write).not.toHaveBeenCalled();
  });

  it('does not capture input touches or navigate when an input gains focus during a swipe', () => {
    render(); h.focusedInput = {};
    expect(h.capture!()).toBe(false); render();
    expect(h.pager!.swipeEnabled).toBe(false);
    h.pager!.onSwipeStart(); h.pager!.onIndexChange(1);
    expect(h.store!.getSnapshot().step).toBe(0);
    h.focusedInput = null; h.capture!(); render();
    expect(h.pager!.swipeEnabled).toBe(true);
    h.pager!.onSwipeStart(); h.focusedInput = {}; h.pager!.onIndexChange(1);
    expect(h.store!.getSnapshot().step).toBe(0);
  });

  it('disables paging while the keyboard or a native screen reader is active', async () => {
    h.keyboardVisible = true; h.reader.mockResolvedValue(true);
    render(); expect(h.pager!.swipeEnabled).toBe(false);
    h.listeners.get('keyboardDidHide')!(); await tick(); render();
    expect(h.pager!.swipeEnabled).toBe(false);
    h.listeners.get('screenReaderChanged')!(false); render();
    expect(h.pager!.swipeEnabled).toBe(true);
    const beforeKeyboard = h.pager!; beforeKeyboard.onSwipeStart();
    h.listeners.get('keyboardDidShow')!(); render(); beforeKeyboard.onIndexChange(1);
    expect(h.store!.getSnapshot().step).toBe(0);
  });

  it('supports reduced motion without disabling deliberate swipes, and ignores the web screen-reader stub', async () => {
    h.platform = 'web'; h.reader.mockResolvedValue(true);
    render(); expect(h.pager!.animationEnabled).toBe(false);
    await tick(); render(); expect(h.pager!.animationEnabled).toBe(true);
    expect(h.reader).not.toHaveBeenCalled(); expect(h.pager!.swipeEnabled).toBe(true);
    h.listeners.get('reduceMotionChanged')!(true); render();
    expect(h.pager!.animationEnabled).toBe(false); expect(h.pager!.swipeEnabled).toBe(true);
    h.pager!.onSwipeStart(); h.pager!.onIndexChange(1);
    expect(h.store!.getSnapshot().step).toBe(1);
  });

  it('requires the explicit Finish button after swiping onto the final slide', async () => {
    h.store!.setStep(4); render(); h.pager!.onSwipeStart(); h.pager!.onIndexChange(5); render();
    expect(h.store!.getSnapshot()).toMatchObject({ visible: true, step: 5 });
    expect(h.write).not.toHaveBeenCalled();
    h.pager!.onSwipeStart(); h.pager!.onIndexChange(6);
    expect(h.store!.getSnapshot()).toMatchObject({ visible: true, step: 5 });
    expect(h.write).not.toHaveBeenCalled();
    press('Finish tour'); await tick(); expect(h.write).toHaveBeenCalledTimes(1);
  });
});
