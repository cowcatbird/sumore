import { describe, expect, it } from 'vitest';
import { createTourPagerNavigation } from './app-tour-gesture';

describe('intro tour pager navigation', () => {
  it('allows one adjacent page in either direction per deliberate swipe', () => {
    const pager = createTourPagerNavigation(6);
    pager.update(2, true); pager.start();
    expect(pager.select(3)).toBe(true);
    expect(pager.select(3)).toBe(false);
    pager.update(3, true); pager.start();
    expect(pager.select(2)).toBe(true);
  });

  it('does not treat button-driven native page callbacks as swipes', () => {
    const pager = createTourPagerNavigation(6);
    pager.update(0, true);
    expect(pager.select(1)).toBe(false);
    pager.update(1, true);
    expect(pager.select(2)).toBe(false);
  });

  it('invalidates unfinished swipes when a button changes the slide', () => {
    const pager = createTourPagerNavigation(6);
    pager.update(2, true); pager.start();
    pager.update(3, true);
    expect(pager.select(2)).toBe(false);
  });

  it('blocks hidden tours, keyboard and screen-reader gestures, including late page events', () => {
    const pager = createTourPagerNavigation(6);
    pager.update(2, false); pager.start();
    expect(pager.select(3)).toBe(false);
    pager.update(2, true); pager.start(); pager.update(2, false);
    expect(pager.select(3)).toBe(false);
    pager.update(2, true);
    expect(pager.select(3)).toBe(false);
  });

  it('ignores cancellation and never skips slides or moves past either edge', () => {
    const pager = createTourPagerNavigation(6);
    pager.update(2, true); pager.start(); pager.cancel();
    expect(pager.select(3)).toBe(false);
    for (const target of [-1, 4, 6, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      pager.update(2, true); pager.start();
      expect(pager.select(target)).toBe(false);
    }
    pager.update(0, true); pager.start(); expect(pager.select(-1)).toBe(false);
    pager.update(5, true); pager.start(); expect(pager.select(6)).toBe(false);
  });

  it('can reach the last slide, without having any completion action', () => {
    const pager = createTourPagerNavigation(6);
    pager.update(4, true); pager.start(); expect(pager.select(5)).toBe(true);
    expect(Object.keys(pager).sort()).toEqual(['cancel', 'select', 'start', 'update']);
  });
});
