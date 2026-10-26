import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { subscribeSpriteFrames } from './sprite-frame-clock';

const cleanups: (() => void)[] = [];
function listen(duration: number, listener = vi.fn()) {
  const cleanup = subscribeSpriteFrames(duration, listener);
  cleanups.push(cleanup);
  return { listener, cleanup };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('visible sprite frame clock', () => {
  it('runs six marshmallow flames on one timer without dropping sprite frames', () => {
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const clockReads = vi.spyOn(Date, 'now');
    const flames = Array.from({ length: 6 }, () => listen(380));
    expect(intervals).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(11_400);
    // Thirty ticks instead of 6 × 30 independent interval callbacks. Every
    // flame still receives all thirty frames plus its initial still frame.
    expect(clockReads).toHaveBeenCalledTimes(31); // One start + thirty ticks.
    for (const { listener } of flames) {
      expect(listener).toHaveBeenCalledTimes(31);
      expect(listener.mock.calls.slice(0, 5).map(([frame]) => frame)).toEqual([0, 1, 2, 0, 1]);
    }
  });

  it('keeps the large and small fire cadences independent', () => {
    const big = listen(300);
    const small = listen(380);
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(300);
    expect(big.listener).toHaveBeenLastCalledWith(1);
    expect(small.listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(80);
    expect(small.listener).toHaveBeenLastCalledWith(1);
  });

  it('joins the current frame and leaves other visible subscribers running', () => {
    const first = listen(380);
    vi.advanceTimersByTime(760);
    const second = listen(380);
    expect(second.listener).toHaveBeenLastCalledWith(2);
    first.cleanup();
    first.cleanup();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(380);
    expect(first.listener).toHaveBeenCalledTimes(3);
    expect(second.listener).toHaveBeenLastCalledWith(0);
  });

  it('does no timer work after the last route hides and resumes from frame zero', () => {
    const flames = Array.from({ length: 6 }, () => listen(380));
    vi.advanceTimersByTime(760);
    flames.forEach(({ cleanup }) => cleanup());
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    flames.forEach(({ listener }) => expect(listener).toHaveBeenCalledTimes(3));
    const resumed = listen(380);
    expect(resumed.listener).toHaveBeenLastCalledWith(0);
    vi.advanceTimersByTime(380);
    expect(resumed.listener).toHaveBeenLastCalledWith(1);
  });

  it('counts duplicated callback subscriptions independently', () => {
    const callback = vi.fn();
    const first = listen(380, callback);
    listen(380, callback);
    first.cleanup();
    vi.advanceTimersByTime(380);
    expect(callback).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('shares the safe fallback duration rather than creating a busy invalid timer', () => {
    listen(0);
    listen(Number.NaN);
    listen(300);
    expect(vi.getTimerCount()).toBe(1);
  });
});
