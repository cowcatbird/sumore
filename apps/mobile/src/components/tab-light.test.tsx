import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TabLightIcon, TabLightLabel, TabLightProvider, type TabPosition } from './tab-light';

type Interpolation = { inputRange: number[]; outputRange: number[]; extrapolate?: string };
type Node = { read: () => number; interpolate: (config: Interpolation) => Node };
type Value = Node & { current: number; setValue: (next: number) => void };
type ViewProps = { testID?: string; style?: unknown; children?: ReactNode; pointerEvents?: string; 'aria-hidden'?: boolean };
type Hook = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
const h = vi.hoisted(() => ({
  hooks: [] as Hook[], cursor: 0, effects: [] as (() => void)[], updates: 0,
  views: [] as ViewProps[], symbols: [] as Record<string, unknown>[],
  state: 'active' as string | null, stateListener: null as ((state: string) => void) | null,
  remove: vi.fn(), timing: vi.fn(), sequence: vi.fn(), loop: vi.fn(),
  animations: [] as { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[],
  values: [] as Value[],
}));

// Evaluate the graph lazily, like Animated: changing the source position updates
// every layer without rendering React or waiting for a route-change callback.
function node(read: () => number): Node {
  return { read, interpolate: ({ inputRange, outputRange }) => node(() => {
    const value = read();
    if (value <= inputRange[0]) return outputRange[0];
    if (value >= inputRange.at(-1)!) return outputRange.at(-1)!;
    const right = inputRange.findIndex(point => point >= value);
    const fraction = (value - inputRange[right - 1]) / (inputRange[right] - inputRange[right - 1]);
    return outputRange[right - 1] + fraction * (outputRange[right] - outputRange[right - 1]);
  }) };
}
function value(initial: number): Value {
  const result = node(() => result.current) as Value;
  result.current = initial;
  result.setValue = vi.fn((next: number) => { result.current = next; });
  return result;
}
const read = (input: number | Node) => typeof input === 'number' ? input : input.read();
const flatten = (style: unknown): Record<string, unknown> => Array.isArray(style)
  ? Object.assign({}, ...style.map(flatten)) : (style || {}) as Record<string, unknown>;

vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      h.hooks[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [h.hooks[index].value, (next: unknown) => {
        h.updates++;
        h.hooks[index].value = typeof next === 'function' ? next(h.hooks[index].value) : next;
      }];
    },
    useEffect: (effect: () => (() => void) | void, deps?: readonly unknown[]) => {
      const index = h.cursor++;
      const previous = h.hooks[index];
      if (previous && deps && previous.deps?.length === deps.length && deps.every((item, i) => Object.is(item, previous.deps![i]))) return;
      h.hooks[index] = { ...previous, deps };
      h.effects.push(() => { previous?.cleanup?.(); h.hooks[index].cleanup = effect() ?? undefined; });
    },
  };
});
vi.mock('react-native', () => ({
  Animated: {
    Value: function AnimatedValue(initial: number) { const animated = value(initial); h.values.push(animated); return animated; },
    View: (props: ViewProps) => { h.views.push(props); return createElement('div', { 'data-testid': props.testID }, props.children); },
    subtract: (left: number | Node, right: number | Node) => node(() => read(left) - read(right)),
    multiply: (left: number | Node, right: number | Node) => node(() => read(left) * read(right)),
    timing: h.timing, sequence: h.sequence, loop: h.loop,
  },
  AppState: {
    get currentState() { return h.state; },
    addEventListener: (_event: string, listener: (state: string) => void) => { h.stateListener = listener; return { remove: h.remove }; },
  },
  Easing: { inOut: (easing: unknown) => easing, sin: 'sin' },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: { position: 'absolute', top: 0, left: 0, bottom: 0, right: 0 } },
  View: (props: ViewProps) => { h.views.push(props); return createElement('div', { 'aria-hidden': props['aria-hidden'] }, props.children); },
}));
vi.mock('expo-symbols', () => ({ SymbolView: (props: Record<string, unknown>) => { h.symbols.push(props); return createElement('span'); } }));
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children: ReactNode }) => createElement('svg', null, children),
  Defs: ({ children }: { children: ReactNode }) => createElement('defs', null, children),
  RadialGradient: ({ children }: { children: ReactNode }) => createElement('radialGradient', null, children),
  Rect: () => createElement('rect'), Stop: () => createElement('stop'),
}));
vi.mock('@/constants/theme', () => ({ useAppColors: () => ({ ink: '#FFF5E6', inkSoft: '#A9BEBD', ember: '#FFAD5F', emberLow: '#C36B20', emberWash: '#402113' }) }));

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (element: ReactNode) => string };
const routes = ['index', 'screen-time', 'friends', 'settings'];
type ProviderProps = Omit<Parameters<typeof TabLightProvider>[0], 'children'>;
function icons(focused = 'index') {
  return routes.map(routeName => createElement(TabLightIcon, { key: routeName, routeName, focused: routeName === focused,
    name: 'flame', activeName: 'flame.fill', size: 22 }));
}
function render(props: ProviderProps, children: ReactNode = icons()) {
  h.cursor = 0; h.views = []; h.symbols = [];
  const html = renderToStaticMarkup(<TabLightProvider {...props}>{children}</TabLightProvider>);
  h.effects.splice(0).forEach(effect => effect());
  return html;
}
function options(position: Value | null, overrides: Partial<ProviderProps> = {}): ProviderProps {
  return { position: position as unknown as TabPosition | null, enabled: true, reduceMotion: false, ...overrides };
}
function layer(id: string) { const view = h.views.find(item => item.testID === id); expect(view).toBeDefined(); return view!; }
function opacity(route: string, kind: string) { return read(flatten(layer(`tab-light-${route}-${kind}`).style).opacity as Node | number); }
function unmount() { h.hooks.forEach(hook => { hook.cleanup?.(); hook.cleanup = undefined; }); }

beforeEach(() => {
  unmount(); vi.clearAllMocks(); h.hooks = []; h.cursor = 0; h.effects = []; h.updates = 0;
  h.views = []; h.symbols = []; h.state = 'active'; h.stateListener = null; h.animations = []; h.values = [];
  h.timing.mockImplementation((animated, config) => ({ animated, config }));
  h.sequence.mockImplementation(steps => ({ steps }));
  h.loop.mockImplementation(() => { const animation = { start: vi.fn(), stop: vi.fn() }; h.animations.push(animation); return animation; });
});

describe('finger-following tab illumination', () => {
  it('crossfades white and orange continuously before the router focus changes', () => {
    const position = value(0); render(options(position));
    const updates = h.updates;
    for (const fraction of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      position.setValue(fraction);
      expect(opacity('index', 'active')).toBeCloseTo(1 - fraction);
      expect(opacity('index', 'inactive')).toBeCloseTo(fraction);
      expect(opacity('index', 'highlight')).toBeCloseTo(1 - fraction);
      expect(opacity('screen-time', 'active')).toBeCloseTo(fraction);
      expect(opacity('screen-time', 'inactive')).toBeCloseTo(1 - fraction);
      expect(opacity('screen-time', 'highlight')).toBeCloseTo(fraction);
      expect(opacity('friends', 'active')).toBe(0);
      expect(opacity('settings', 'active')).toBe(0);
    }
    expect(h.updates).toBe(updates);
    expect(h.symbols[0]).toMatchObject({ name: 'flame', tintColor: '#FFF5E6', size: 22 });
    expect(h.symbols[1]).toMatchObject({ name: 'flame.fill', tintColor: '#FFAD5F', size: 22 });
  });

  it('follows reverse swipes and cancelled swipes back to the exact original colors', () => {
    const position = value(3); render(options(position), icons('settings'));
    for (const fraction of [3, 2.8, 2.5, 2.2, 2, 2.35, 2.7, 2.2, 2]) {
      position.setValue(fraction);
      expect(opacity('friends', 'active')).toBeCloseTo(3 - fraction);
      expect(opacity('settings', 'active')).toBeCloseTo(fraction - 2);
      expect(opacity('index', 'active')).toBe(0);
      expect(opacity('screen-time', 'active')).toBe(0);
    }
    expect(opacity('friends', 'inactive')).toBe(0);
    expect(opacity('settings', 'inactive')).toBe(1);
    routes.forEach(route => expect(opacity(route, 'glow')).toBe(0));
  });

  it('lights exactly one tab at each settled page and clamps every opacity', () => {
    const position = value(0); render(options(position));
    routes.forEach((route, index) => {
      position.setValue(index);
      routes.forEach(other => {
        expect(opacity(other, 'active')).toBe(other === route ? 1 : 0);
        expect(opacity(other, 'highlight')).toBe(other === route ? 1 : 0);
        expect(opacity(other, 'glow')).toBe(0);
      });
    });
    for (const overscroll of [-100, -0.5, 3.5, 100]) {
      position.setValue(overscroll);
      routes.forEach(route => {
        expect(opacity(route, 'active')).toBeGreaterThanOrEqual(0);
        expect(opacity(route, 'active')).toBeLessThanOrEqual(1);
      });
    }
  });

  it.each([false, true])('ignores the navigator’s duplicated focused=%s icon layer when pager progress exists', focused => {
    render(options(value(0.4)), createElement(TabLightIcon, { routeName: 'index', focused, name: 'flame', size: 22 }));
    expect(opacity('index', 'active')).toBeCloseTo(0.6);
  });

  it('falls back to ordinary focus before measurement and for unknown routes', () => {
    render(options(null), icons('friends'));
    expect(opacity('friends', 'active')).toBe(1);
    expect(opacity('screen-time', 'active')).toBe(0);
    routes.forEach(route => expect(opacity(route, 'glow')).toBe(0));
    render(options(value(0.25)), createElement(TabLightIcon, { routeName: 'customize', focused: false, name: 'flame', size: 22 }));
    expect(opacity('customize', 'active')).toBe(0);
    expect(opacity('customize', 'inactive')).toBe(1);
  });

  it('uses the same fraction for labels, retaining an in-flow label and one absolute overlay', () => {
    const position = value(1.4);
    render(options(position), <TabLightLabel routeName="screen-time" focused={false}>
      {color => <span style={{ color }}>Screen Time</span>}
    </TabLightLabel>);
    expect(opacity('screen-time', 'label-active')).toBeCloseTo(0.6);
    expect(opacity('screen-time', 'label-inactive')).toBeCloseTo(0.4);
    expect(flatten(layer('tab-light-screen-time-label-active').style)).toMatchObject({ position: 'absolute' });
    expect(flatten(layer('tab-light-screen-time-label-inactive').style)).not.toHaveProperty('position');
    position.setValue(2);
    expect(opacity('screen-time', 'label-active')).toBe(0);
  });

  it('shows a moving glow only between pages and removes it when the slide settles or cancels', () => {
    const position = value(0.25); render(options(position));
    const updates = h.updates;
    expect(opacity('index', 'glow')).toBeCloseTo(0.325 * 0.75);
    expect(opacity('screen-time', 'glow')).toBeCloseTo(0.325 * 0.25);
    position.setValue(0.5);
    expect(opacity('index', 'glow')).toBeCloseTo(0.65 * 0.5);
    expect(opacity('screen-time', 'glow')).toBeCloseTo(0.65 * 0.5);
    h.values[0].setValue(0.93);
    expect(opacity('index', 'glow')).toBeCloseTo(0.65 * 0.5 * 0.93);
    expect(opacity('screen-time', 'glow')).toBeCloseTo(0.65 * 0.5 * 0.93);
    expect(opacity('friends', 'glow')).toBe(0);
    for (const endpoint of [0, 1]) {
      position.setValue(endpoint);
      routes.forEach(route => expect(opacity(route, 'glow')).toBe(0));
    }
    expect(h.updates).toBe(updates);
    expect(h.values).toHaveLength(1);
    expect(h.views.filter(view => view.pointerEvents === 'none').every(view => view['aria-hidden'])).toBe(true);
  });

  it('retains the normal rounded selection highlight at rest', () => {
    render(options(value(2)), icons('friends'));
    expect(flatten(layer('tab-light-friends-highlight').style)).toMatchObject({
      borderRadius: 13, backgroundColor: '#402113',
    });
    expect(opacity('friends', 'highlight')).toBe(1);
    expect(opacity('friends', 'glow')).toBe(0);
    expect(opacity('settings', 'highlight')).toBe(0);
  });

  it('flickers only the orange artwork while labels, pale icons, and the highlight remain steady', () => {
    render(options(value(0)), [...icons(), <TabLightLabel key="label" routeName="index" focused>
      {color => <span style={{ color }}>Camp</span>}
    </TabLightLabel>]);
    expect(layer('tab-light-index-active').children).toMatchObject({ props: { testID: 'tab-light-index-flicker' } });
    const updates = h.updates;
    for (const warmth of [1, 0.995, 0.985, 0.992, 1]) {
      h.values[0].setValue(warmth);
      expect(opacity('index', 'flicker')).toBe(warmth);
      expect(opacity('index', 'active')).toBe(1);
      expect(opacity('index', 'highlight')).toBe(1);
      expect(opacity('index', 'label-active')).toBe(1);
      expect(opacity('index', 'label-inactive')).toBe(0);
      expect(opacity('screen-time', 'inactive')).toBe(1);
      expect(opacity('screen-time', 'active')).toBe(0);
      expect(opacity('index', 'glow')).toBe(0);
    }
    expect(h.updates).toBe(updates);
  });
});

describe('subtle, nonblocking campfire flicker', () => {
  it('runs one shared native-driven loop without holding an interaction handle', () => {
    render(options(value(0)));
    expect(h.loop).toHaveBeenCalledOnce();
    expect(h.animations[0].start).toHaveBeenCalledOnce();
    expect(h.timing).toHaveBeenCalledTimes(2);
    const configurations = h.timing.mock.calls.map(([, config]) => config);
    expect(configurations.map(config => config.duration)).toEqual([2600, 3200]);
    expect(configurations.map(config => config.toValue)).toEqual([0.985, 1]);
    // Ending where the cycle starts and avoiding sequence resets prevents
    // a visible brightness jump between iterations.
    expect(h.loop.mock.calls[0][1]).toEqual({ resetBeforeIteration: false });
    configurations.forEach(config => {
      expect(config).toMatchObject({ useNativeDriver: true, isInteraction: false });
      expect(config.toValue).toBeGreaterThanOrEqual(0.985);
      expect(config.toValue).toBeLessThanOrEqual(1);
    });
  });

  it.each([
    { enabled: false, reduceMotion: false },
    { enabled: true, reduceMotion: true },
  ])('does not animate when %j', configuration => {
    render(options(value(0), configuration));
    expect(h.loop).not.toHaveBeenCalled();
    expect(opacity('index', 'glow')).toBe(0);
    expect(opacity('index', 'flicker')).toBe(1);
  });

  it('keeps reduced-motion colors synced to the finger without an idle pulse', () => {
    const position = value(1.5); render(options(position, { reduceMotion: true }));
    expect(opacity('screen-time', 'active')).toBe(0.5);
    expect(opacity('friends', 'active')).toBe(0.5);
    expect(h.loop).not.toHaveBeenCalled();
    position.setValue(2);
    expect(opacity('friends', 'active')).toBe(1);
  });

  it('pauses in background, resumes in foreground, and stops every loop on unmount', () => {
    const props = options(value(0)); render(props);
    h.stateListener!('background'); render(props);
    expect(h.animations[0].stop).toHaveBeenCalledOnce();
    expect(h.loop).toHaveBeenCalledOnce();
    h.stateListener!('active'); render(props);
    expect(h.loop).toHaveBeenCalledTimes(2);
    expect(h.animations[1].start).toHaveBeenCalledOnce();
    unmount();
    expect(h.animations[1].stop).toHaveBeenCalledOnce();
    expect(h.remove).toHaveBeenCalledOnce();
  });

  it('stops the current loop when the bar is hidden or reduced motion is enabled', () => {
    const position = value(0); render(options(position));
    render(options(position, { enabled: false }));
    expect(h.animations[0].stop).toHaveBeenCalledOnce();
    render(options(position));
    expect(h.animations[1].start).toHaveBeenCalledOnce();
    render(options(position, { reduceMotion: true }));
    expect(h.animations[1].stop).toHaveBeenCalledOnce();
    expect(h.values[0].read()).toBe(1);
  });

  it('does not start a loop if mounted while the app is already inactive', () => {
    h.state = 'inactive'; render(options(value(0)));
    expect(h.loop).not.toHaveBeenCalled();
  });
});
