import { createRequire } from 'node:module';
import { createElement, isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SwipeTabsLayout } from './swipe-tabs';

type Route = { key: string; name: string; params?: Record<string, string> };
type PagerBar = { jumpTo: (key: string) => void; position: object; layout: { width: number; height: number } };
type Pager = {
  navigationState: { index: number; routes: Route[] };
  onSwipeStart: () => void;
  onIndexChange: (index: number) => void;
  renderScene: (input: { route: Route }) => ReactNode;
  renderTabBar: (pager: PagerBar) => ReactNode;
  swipeEnabled: boolean; animationEnabled: boolean; keyboardDismissMode: string;
  lazy: boolean; lazyPreloadDistance: number; overScrollMode: string;
};
type ViewProps = {
  children?: ReactNode; style?: unknown; pointerEvents?: string; 'aria-hidden'?: boolean;
  onStartShouldSetResponderCapture?: (event: unknown) => boolean;
};
type Scene = { focused: boolean; route: Route; navigation: unknown; headerShown: boolean; header: ReactNode; children?: ReactNode };
const h = vi.hoisted(() => ({
  hooks: [] as { value: unknown }[], cursor: 0, changed: false, updates: 0,
  layoutEffects: [] as (() => (() => void) | void)[], layoutCleanups: [] as (() => void)[],
  effectStarted: false, pendingEffect: null as (() => (() => void) | void) | null,
  cleanup: null as (() => void) | null, listeners: new Map<string, (value?: boolean) => void>(),
  removals: [] as ReturnType<typeof vi.fn>[], keyboardVisible: false, focusedInput: null as object | null,
  legacyFieldOnly: false, focusedField: null as number | null,
  platform: 'ios', motion: vi.fn<() => Promise<boolean>>(), reader: vi.fn<() => Promise<boolean>>(),
  navigate: vi.fn(), jumpTo: vi.fn(), pager: null as Pager | null, views: [] as ViewProps[], scenes: [] as Scene[],
  bar: null as Record<string, unknown> | null, barHeight: 0,
  position: {} as object, layoutWidth: 390, light: null as Record<string, unknown> | null,
}));
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  return { ...actual,
    useRef: (value: unknown) => {
      const index = h.cursor++;
      h.hooks[index] ??= { value: { current: value } };
      return h.hooks[index].value;
    },
    useState: (initial: unknown) => {
      const index = h.cursor++;
      h.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [h.hooks[index].value, (next: unknown) => {
        h.updates++;
        const value = typeof next === 'function' ? next(h.hooks[index].value) : next;
        if (!Object.is(value, h.hooks[index].value)) { h.hooks[index].value = value; h.changed = true; }
      }];
    },
    useEffect: (effect: () => (() => void) | void) => {
      if (!h.effectStarted) { h.effectStarted = true; h.pendingEffect = effect; }
    },
    useLayoutEffect: (effect: () => (() => void) | void) => { h.layoutEffects.push(effect); },
  };
});
vi.mock('react-native', () => {
  const addListener = (name: string, listener: (value?: boolean) => void) => {
    h.listeners.set(name, listener);
    const remove = vi.fn(() => h.listeners.delete(name)); h.removals.push(remove);
    return { remove };
  };
  const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
    ? Object.assign({}, ...style.map(flatten)) : (style || {}) as Record<string, unknown>;
  return {
    AccessibilityInfo: { addEventListener: addListener, isReduceMotionEnabled: h.motion, isScreenReaderEnabled: h.reader },
    Keyboard: { isVisible: () => h.keyboardVisible, addListener },
    TextInput: { State: {
      get currentlyFocusedInput() { return h.legacyFieldOnly ? undefined : () => h.focusedInput; },
      currentlyFocusedField: () => h.focusedField,
    } },
    Platform: { get OS() { return h.platform; }, select: (choices: Record<string, unknown>) => choices[h.platform] ?? choices.default },
    StyleSheet: { create: (styles: unknown) => styles, flatten, absoluteFill: { position: 'absolute' } },
    View: (props: ViewProps) => {
      h.views.push(props);
      return createElement('div', { 'aria-hidden': props['aria-hidden'], style: flatten(props.style) }, props.children);
    },
  };
});
vi.mock('expo-router/js-tabs', () => ({
  BottomTabBarHeightContext: { Provider: ({ value, children }: { value: number; children: ReactNode }) => {
    h.barHeight = value; return children;
  } },
  BottomTabBar: (props: Record<string, unknown>) => { h.bar = props; return createElement('footer'); },
}));
vi.mock('expo-router/react-navigation', () => ({
  SafeAreaProviderCompat: ({ children }: { children: ReactNode }) => children,
  Screen: (props: Scene) => { h.scenes.push(props); return createElement('section', { 'data-route': props.route.name }, props.children); },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 44, bottom: 20, left: 0, right: 0 }) }));
vi.mock('react-native-tab-view', () => ({ TabView: (props: Pager) => {
  h.pager = props;
  return createElement('main', { 'data-pager': true }, props.renderTabBar({ jumpTo: h.jumpTo, position: h.position,
    layout: { width: h.layoutWidth, height: 600 } }), props.navigationState.routes.map(route =>
    createElement('article', { key: route.key }, props.renderScene({ route }))));
} }));
vi.mock('./tab-light', () => ({
  TabLightProvider: ({ children, ...props }: { children: ReactNode }) => { h.light = props; return children; },
}));
vi.mock('@/constants/theme', () => ({ useAppColors: () => ({ ground: '#0A151D' }) }));

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const tick = async () => { for (let index = 0; index < 4; index++) await Promise.resolve(); };
function fixture(active = 'index') {
  const routes: Route[] = ['friends', 'customize', 'settings', 'index', 'requests', 'screen-time']
    .map(name => ({ key: `${name}-key`, name, ...(name === 'friends' ? { params: { section: 'friends', invite: '1' } } : {}) }));
  const state = { index: routes.findIndex(route => route.name === active), routes };
  const navigation = { navigate: h.navigate };
  const descriptors = Object.fromEntries(routes.map(route => [route.key, {
    options: { tabBarStyle: [{ backgroundColor: '#0A151D' }, { height: 92 }] },
    navigation: { routeKey: route.key }, render: vi.fn(() => createElement('p', null, route.name)),
  }]));
  return { state, navigation, descriptors };
}
type Fixture = ReturnType<typeof fixture>;
function render(props: Fixture) {
  let html = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    h.cursor = 0; h.changed = false; h.views = []; h.scenes = []; h.pager = null; h.layoutEffects = [];
    html = renderToStaticMarkup(createElement(SwipeTabsLayout, props as unknown as Parameters<typeof SwipeTabsLayout>[0]));
    if (!h.changed) break;
  }
  h.layoutCleanups.splice(0).forEach(cleanup => cleanup());
  h.layoutEffects.splice(0).forEach(effect => { const cleanup = effect(); if (cleanup) h.layoutCleanups.push(cleanup); });
  if (h.pendingEffect) { const effect = h.pendingEffect; h.pendingEffect = null; h.cleanup = effect() ?? null; }
  return html;
}
function activate(props: Fixture, name: string) { props.state.index = props.state.routes.findIndex(route => route.name === name); }
function pager() { expect(h.pager).not.toBeNull(); return h.pager!; }
function captureTouch(outsidePager = false) {
  const wrapper = h.views.find(view => view.onStartShouldSetResponderCapture);
  expect(wrapper).toBeDefined();
  return wrapper!.onStartShouldSetResponderCapture!({ currentTarget: { contains: () => !outsidePager }, target: {} });
}
function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  h.cleanup?.(); h.layoutCleanups.splice(0).forEach(cleanup => cleanup()); vi.clearAllMocks();
  h.hooks = []; h.cursor = 0; h.changed = false; h.updates = 0;
  h.layoutEffects = [];
  h.effectStarted = false; h.pendingEffect = null; h.cleanup = null; h.listeners.clear(); h.removals = [];
  h.keyboardVisible = false; h.focusedInput = null; h.platform = 'ios'; h.legacyFieldOnly = false; h.focusedField = null;
  h.position = {}; h.layoutWidth = 390; h.light = null;
  h.motion.mockResolvedValue(false); h.reader.mockResolvedValue(false);
});

describe('swipe tabs stay controlled by Expo Router', () => {
  it('maps only the four visible routes, preserving the original bar, route objects, and safe area', () => {
    const props = fixture('friends'); const html = render(props);
    expect(pager().navigationState.routes.map(route => route.name)).toEqual(['index', 'screen-time', 'friends', 'settings']);
    expect(pager().navigationState.index).toBe(2);
    expect(pager().navigationState.routes[2]).toBe(props.state.routes[0]);
    expect(isValidElement(pager().renderTabBar({ jumpTo: h.jumpTo, position: h.position,
      layout: { width: h.layoutWidth, height: 600 } }))).toBe(true);
    expect(html.match(/<footer/g)).toHaveLength(1);
    expect(h.bar).toMatchObject({ state: props.state, descriptors: props.descriptors, navigation: props.navigation,
      insets: { top: 44, bottom: 20, left: 0, right: 0 } });
    expect(h.barHeight).toBe(92);
    expect(props.descriptors['customize-key'].render).not.toHaveBeenCalled();
    expect(props.descriptors['requests-key'].render).not.toHaveBeenCalled();
  });

  it('merges existing Circle deep-link params and waits for router state before changing the controlled index', () => {
    const props = fixture(); render(props);
    const circle = props.state.routes[0];
    pager().onSwipeStart();
    pager().onIndexChange(2);
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith({ name: 'friends', params: circle.params, merge: true });
    expect(h.navigate.mock.calls[0][0].params).toBe(circle.params);
    render(props); expect(pager().navigationState.index).toBe(0);
    activate(props, 'friends'); render(props); expect(pager().navigationState.index).toBe(2);
    activate(props, 'settings'); render(props); expect(pager().navigationState.index).toBe(3);
  });

  it('ignores unchanged, out-of-range, and hidden-screen pager callbacks', () => {
    const props = fixture(); render(props);
    pager().onSwipeStart();
    for (const index of [0, -1, 4, 99]) pager().onIndexChange(index);
    activate(props, 'customize'); render(props); pager().onIndexChange(2);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('keeps the pager tree and last main index behind customization, then retains the hidden scene on return', () => {
    const props = fixture('friends'); render(props);
    activate(props, 'customize'); const hidden = render(props);
    expect(hidden).toContain('data-pager="true"');
    expect(hidden).toContain('data-route="customize"');
    expect(pager().navigationState.index).toBe(2);
    expect(pager().swipeEnabled).toBe(false);
    expect(h.views.find(view => view.onStartShouldSetResponderCapture)).toMatchObject({ pointerEvents: 'none', 'aria-hidden': true });
    const wrapperStyles = h.views.find(view => view.onStartShouldSetResponderCapture)!.style as Record<string, unknown>[];
    expect(Object.assign({}, ...wrapperStyles)).toMatchObject({ opacity: 0 });
    expect(Object.assign({}, ...wrapperStyles)).not.toHaveProperty('display', 'none');
    expect(h.scenes.filter(scene => scene.focused).map(scene => scene.route.name)).toEqual(['customize']);
    activate(props, 'friends'); const restored = render(props);
    expect(restored).toContain('data-route="customize"');
    expect(h.scenes.find(scene => scene.route.name === 'customize')?.focused).toBe(false);
    expect(h.views.filter(view => view['aria-hidden'] === true && view.pointerEvents === 'none')).toHaveLength(1);
    expect(h.scenes.filter(scene => scene.focused).map(scene => scene.route.name)).toEqual(['friends']);
  });

  it('supports a hidden-route deep link without navigating or exposing the inactive main pager', () => {
    const props = fixture('customize'); render(props);
    expect(pager().navigationState.index).toBe(0);
    expect(pager().swipeEnabled).toBe(false);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.scenes.filter(scene => scene.focused).map(scene => scene.route.name)).toEqual(['customize']);
  });

  it('passes focus and the correct descriptor navigation to scenes without duplicate headers', () => {
    const props = fixture('screen-time'); render(props);
    expect(h.scenes.filter(scene => scene.focused).map(scene => scene.route.name)).toEqual(['screen-time']);
    for (const scene of h.scenes) {
      expect(scene.navigation).toBe(props.descriptors[scene.route.key].navigation);
      expect(scene.headerShown).toBe(false); expect(scene.header).toBeNull();
    }
    expect(pager()).toMatchObject({ lazy: true, lazyPreloadDistance: 1, keyboardDismissMode: 'none', overScrollMode: 'never' });
  });

  it('does not navigate for programmatic page callbacks and reconciles to the router-selected page', () => {
    const props = fixture('settings'); render(props);
    pager().onIndexChange(1);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.jumpTo).toHaveBeenCalledExactlyOnceWith('settings-key');
  });

  it.each(['ios', 'android', 'web'])('jumps directly between tapped tabs on %s without disabling swipes', async platform => {
    h.platform = platform;
    const props = fixture(); render(props); await tick(); render(props);
    expect(pager().animationEnabled).toBe(false);
    // A first-to-last tab tap must not animate through Screen Time and Circle.
    activate(props, 'settings'); render(props);
    expect(pager().navigationState.index).toBe(3);
    expect(pager().animationEnabled).toBe(false);
    expect(pager().swipeEnabled).toBe(true);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.light!.position).toBe(h.position);
    // Gesture navigation is independent of programmatic animation.
    pager().onSwipeStart(); pager().onIndexChange(2);
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith({
      name: 'friends', params: props.state.routes[0].params, merge: true,
    });
    activate(props, 'friends'); render(props);
    activate(props, 'index'); render(props);
    expect(pager().navigationState.index).toBe(0);
    expect(pager().animationEnabled).toBe(false);
  });

  it('clears the committed pager controller when its bridge unmounts', () => {
    render(fixture());
    h.layoutCleanups.splice(0).forEach(cleanup => cleanup());
    pager().onIndexChange(1);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.jumpTo).not.toHaveBeenCalled();
  });

  it.each(['settings', 'customize'])('rejects a late swipe callback after external navigation to %s', destination => {
    const props = fixture('friends'); render(props);
    const originalPager = pager(); originalPager.onSwipeStart();
    activate(props, destination); render(props);
    originalPager.onIndexChange(1);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.jumpTo).toHaveBeenCalledExactlyOnceWith(destination === 'settings' ? 'settings-key' : 'friends-key');
  });

  it('rejects a stale swipe when a deep link changes params on the same focused route', () => {
    const props = fixture('friends'); render(props);
    const originalPager = pager(); originalPager.onSwipeStart();
    const oldParams = props.state.routes[0].params;
    props.state.routes[0] = { ...props.state.routes[0], params: { section: 'requests' } };
    render(props); originalPager.onIndexChange(3);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.jumpTo).toHaveBeenCalledExactlyOnceWith('friends-key');
    expect(props.state.routes[0].params).toEqual({ section: 'requests' });
    expect(oldParams).toEqual({ section: 'friends', invite: '1' });
  });
});

describe('swipe interaction and accessibility guards', () => {
  it('disables gestures while the keyboard is already visible or changes visibility', () => {
    const props = fixture(); h.keyboardVisible = true; render(props);
    expect(pager().swipeEnabled).toBe(false);
    h.listeners.get('keyboardDidHide')!(); render(props); expect(pager().swipeEnabled).toBe(true);
    h.listeners.get('keyboardDidShow')!(); render(props); expect(pager().swipeEnabled).toBe(false);
  });

  it('does not capture input touches and disables paging while a text input is focused', () => {
    const props = fixture(); render(props); h.focusedInput = {};
    expect(captureTouch()).toBe(false); render(props); expect(pager().swipeEnabled).toBe(false);
    h.focusedInput = null; expect(captureTouch()).toBe(false); render(props); expect(pager().swipeEnabled).toBe(true);
  });

  it('supports the legacy web focused-field API when currentlyFocusedInput is absent', () => {
    const props = fixture(); h.platform = 'web'; h.legacyFieldOnly = true; h.focusedField = 42; render(props);
    expect(captureTouch()).toBe(false); render(props); expect(pager().swipeEnabled).toBe(false);
    h.focusedField = null;
    expect(captureTouch()).toBe(false); render(props); expect(pager().swipeEnabled).toBe(true);
  });

  it('prefers the modern focused-input API when both input APIs exist', () => {
    const props = fixture(); h.focusedField = 42; render(props);
    expect(captureTouch()).toBe(false); render(props);
    expect(pager().swipeEnabled).toBe(true);
  });

  it('does not swipe the background for web portal sheet touches', () => {
    const props = fixture(); h.platform = 'web'; render(props);
    expect(captureTouch(true)).toBe(false); render(props); expect(pager().swipeEnabled).toBe(false);
    captureTouch(false); render(props); expect(pager().swipeEnabled).toBe(true);
  });

  it('reads screen-reader state and responds to accessibility changes', async () => {
    const props = fixture(); h.reader.mockResolvedValue(true); render(props); await tick(); render(props);
    expect(pager().swipeEnabled).toBe(false);
    h.listeners.get('screenReaderChanged')!(false); render(props); expect(pager().swipeEnabled).toBe(true);
    h.listeners.get('screenReaderChanged')!(true); render(props); expect(pager().swipeEnabled).toBe(false);
  });

  it('does not let the always-true web screen-reader stub disable browser swipes', async () => {
    const props = fixture(); h.platform = 'web'; h.reader.mockResolvedValue(true);
    render(props); await tick(); render(props);
    expect(h.reader).not.toHaveBeenCalled();
    expect(h.listeners.has('screenReaderChanged')).toBe(false);
    expect(pager().swipeEnabled).toBe(true);
    pager().onSwipeStart(); pager().onIndexChange(1);
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith({ name: 'screen-time', params: undefined, merge: true });
  });

  it('keeps tab taps instant and applies reduced motion to lighting without disabling gestures', async () => {
    const props = fixture(); render(props); expect(pager().animationEnabled).toBe(false);
    expect(h.light!.reduceMotion).toBe(true);
    await tick(); render(props); expect(pager().animationEnabled).toBe(false);
    expect(h.light!.reduceMotion).toBe(false);
    h.listeners.get('reduceMotionChanged')!(true); render(props);
    expect(pager().animationEnabled).toBe(false); expect(pager().swipeEnabled).toBe(true);
    expect(h.light!.reduceMotion).toBe(true);
    pager().onSwipeStart(); pager().onIndexChange(1);
    expect(h.navigate).toHaveBeenCalledWith({ name: 'screen-time', params: undefined, merge: true });
  });

  it.each(['keyboardDidShow', 'screenReaderChanged'])('cancels an in-flight gesture when %s disables paging', event => {
    const props = fixture(); render(props);
    const originalPager = pager(); originalPager.onSwipeStart();
    h.listeners.get(event)!(true); render(props); originalPager.onIndexChange(1);
    expect(pager().swipeEnabled).toBe(false);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.jumpTo).toHaveBeenCalledExactlyOnceWith('index-key');
  });

  it('does not let late initial accessibility queries overwrite newer change events', async () => {
    const motion = deferred(); const reader = deferred();
    h.motion.mockReturnValue(motion.promise); h.reader.mockReturnValue(reader.promise);
    const props = fixture(); render(props);
    h.listeners.get('reduceMotionChanged')!(true); h.listeners.get('screenReaderChanged')!(true);
    motion.resolve(false); reader.resolve(false); await tick(); render(props);
    expect(pager().animationEnabled).toBe(false); expect(pager().swipeEnabled).toBe(false);
  });

  it('removes all event subscriptions and ignores accessibility promises after unmount', async () => {
    const motion = deferred(); const reader = deferred();
    h.motion.mockReturnValue(motion.promise); h.reader.mockReturnValue(reader.promise);
    render(fixture()); h.cleanup!(); const previousUpdates = h.updates;
    motion.resolve(false); reader.resolve(true); await tick();
    expect(h.removals).toHaveLength(4);
    for (const remove of h.removals) expect(remove).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(0); expect(h.updates).toBe(previousUpdates);
    h.cleanup = null;
  });
});

describe('pager-synchronized tab light', () => {
  it('publishes the measured animated position itself, not the completed route index', () => {
    const props = fixture('screen-time'); render(props); render(props);
    expect(h.light).toMatchObject({ position: h.position, enabled: true, reduceMotion: true });
    expect(h.light!.position).toBe(h.position);
    expect(pager().navigationState.index).toBe(1);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('does not publish unstable unmeasured positions before the pager has a width', () => {
    const props = fixture(); h.layoutWidth = 0;
    render(props); render(props);
    expect(h.light!.position).toBeNull();
    h.position = {}; render(props); render(props);
    expect(h.light!.position).toBeNull();
    h.layoutWidth = 390; render(props); render(props);
    expect(h.light!.position).toBe(h.position);
  });

  it('connects a replacement measured position node after a pager layout change', () => {
    const props = fixture(); render(props); render(props);
    const initialPosition = h.position;
    h.position = {}; h.layoutWidth = 560; render(props); render(props);
    expect(h.light!.position).toBe(h.position);
    expect(h.light!.position).not.toBe(initialPosition);
  });

  it('disables the decorative light behind hidden routes and while the keyboard covers the bar', () => {
    const props = fixture('friends'); render(props); render(props);
    expect(h.light!.enabled).toBe(true);
    activate(props, 'customize'); render(props);
    expect(h.light!.enabled).toBe(false);
    activate(props, 'friends'); render(props);
    expect(h.light!.enabled).toBe(true);
    h.listeners.get('keyboardDidShow')!(); render(props);
    expect(h.light!.enabled).toBe(false);
    h.listeners.get('keyboardDidHide')!(); render(props);
    expect(h.light!.enabled).toBe(true);
  });

  it('passes live reduced-motion preferences to the tab glow', async () => {
    const props = fixture(); render(props);
    expect(h.light!.reduceMotion).toBe(true);
    await tick(); render(props);
    expect(h.light!.reduceMotion).toBe(false);
    h.listeners.get('reduceMotionChanged')!(true); render(props);
    expect(h.light!.reduceMotion).toBe(true);
  });
});
