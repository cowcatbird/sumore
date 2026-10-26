import { createRequire } from 'node:module';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeSpriteFrames } from './sprite-frame-clock';
import { useVisibleAnimation } from './use-fire-motion';

const h = vi.hoisted(() => ({
  focusedEffects: [] as (() => void | (() => void))[],
  state: 'active',
  appListeners: new Set<(state: string) => void>(),
  motionListeners: new Set<(value: boolean) => void>(),
  getReduced: vi.fn<() => Promise<boolean>>(),
}));
vi.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => { h.focusedEffects.push(callback); },
}));
vi.mock('react-native', () => ({
  Animated: {}, Platform: { OS: 'ios' },
  AppState: {
    get currentState() { return h.state; },
    addEventListener: (_: string, callback: (state: string) => void) => {
      h.appListeners.add(callback); return { remove: () => h.appListeners.delete(callback) };
    },
  },
  AccessibilityInfo: {
    isReduceMotionEnabled: h.getReduced,
    addEventListener: (_: string, callback: (value: boolean) => void) => {
      h.motionListeners.add(callback); return { remove: () => h.motionListeners.delete(callback) };
    },
  },
}));

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as {
  renderToStaticMarkup: (node: ReactNode) => string;
};
const cleanups: (() => void)[] = [];
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function mountGate(enabled = true, play: () => () => void = () => subscribeSpriteFrames(380, () => undefined)) {
  // Minimal effect harness: invokes the real hook's focus lifecycle, not a
  // device renderer. Timer counts below cover scheduler/lifecycle work only.
  function Probe() { useVisibleAnimation(enabled, play); return null; }
  renderToStaticMarkup(createElement(Probe));
  const focusEffect = h.focusedEffects.at(-1)!;
  let stopFocus: void | (() => void);
  const blur = () => { stopFocus?.(); stopFocus = undefined; };
  const focus = () => { blur(); stopFocus = focusEffect(); };
  cleanups.push(blur);
  return { focus, blur };
}
function appState(value: string) { h.state = value; h.appListeners.forEach(listener => listener(value)); }
function reduceMotion(value: boolean) { h.motionListeners.forEach(listener => listener(value)); }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0); vi.clearAllMocks();
  h.focusedEffects = []; h.state = 'active'; h.appListeners.clear(); h.motionListeners.clear();
  h.getReduced.mockResolvedValue(false);
});
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  expect(vi.getTimerCount()).toBe(0);
  expect(h.appListeners.size).toBe(0);
  expect(h.motionListeners.size).toBe(0);
  vi.useRealTimers();
});

describe('visible campsite animation lifecycle', () => {
  it('does no work for a mounted but unfocused tab', async () => {
    const gate = mountGate();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.getReduced).not.toHaveBeenCalled();
    gate.focus(); await flush();
    expect(vi.getTimerCount()).toBe(1);
    gate.blur();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one clock for six visible flames and zero after blur', async () => {
    const gates = Array.from({ length: 6 }, () => mountGate());
    gates.forEach(gate => gate.focus()); await flush();
    expect(vi.getTimerCount()).toBe(1);
    gates.forEach(gate => gate.blur());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops in the background and restarts once when foregrounded', async () => {
    const gate = mountGate(); gate.focus(); await flush();
    appState('background');
    expect(vi.getTimerCount()).toBe(0);
    appState('active'); appState('active');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('stays still when reduced motion is enabled and follows later changes', async () => {
    h.getReduced.mockResolvedValue(true);
    const gate = mountGate(); gate.focus(); await flush();
    expect(vi.getTimerCount()).toBe(0);
    reduceMotion(false);
    expect(vi.getTimerCount()).toBe(1);
    reduceMotion(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let an old preference query restart animation after Reduce Motion turns on', async () => {
    let resolve!: (value: boolean) => void;
    h.getReduced.mockReturnValue(new Promise<boolean>(done => { resolve = done; }));
    const gate = mountGate(); gate.focus();
    reduceMotion(true); resolve(false); await flush();
    expect(vi.getTimerCount()).toBe(0);
    reduceMotion(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('ignores a pending preference result after the route blurs', async () => {
    let resolve!: (value: boolean) => void;
    h.getReduced.mockReturnValue(new Promise<boolean>(done => { resolve = done; }));
    const gate = mountGate(); gate.focus(); gate.blur(); resolve(false); await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never starts paused artwork or a route initially in the background', async () => {
    const paused = mountGate(false); paused.focus(); await flush();
    expect(h.getReduced).not.toHaveBeenCalled();
    h.state = 'background';
    const background = mountGate(); background.focus(); await flush();
    expect(vi.getTimerCount()).toBe(0);
    appState('active');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('fails still if the accessibility preference cannot be read', async () => {
    h.getReduced.mockRejectedValue(new Error('Unavailable'));
    const gate = mountGate(); gate.focus(); await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
});
