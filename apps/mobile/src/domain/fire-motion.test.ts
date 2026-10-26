import { describe, expect, it } from 'vitest';
import {
  BIG_FIRE_FRAME_MS, FIRE_GLOW_CYCLE_MS, FIRE_GLOW_MAX, FIRE_GLOW_MIN, FIRE_GLOW_STILL,
  SMALL_FIRE_FRAME_MS, sampleGlowProgress,
  sampleSpriteFrame, spriteFrameDuration,
} from './fire-motion';

describe('slow campsite animation', () => {
  it('cycles all three marshmallow sprites, in order, at 380ms per frame', () => {
    expect(SMALL_FIRE_FRAME_MS).toBe(380);
    expect([0, 380, 760, 1140, 1520].map(t => sampleSpriteFrame(t, SMALL_FIRE_FRAME_MS))).toEqual([0, 1, 2, 0, 1]);
  });
  it('slows the main fire from its original 110ms to 300ms per frame', () => {
    expect(BIG_FIRE_FRAME_MS).toBe(300);
    expect([0, 299, 300, 600, 900].map(t => sampleSpriteFrame(t, BIG_FIRE_FRAME_MS))).toEqual([0, 0, 1, 2, 0]);
  });
  it('samples isolated fire components at their own frame boundaries', () => {
    expect([0, 379, 380, 759, 760, 1139, 1140].map(t => sampleSpriteFrame(t, 380)))
      .toEqual([0, 0, 1, 1, 2, 2, 0]);
    expect(sampleSpriteFrame(16_300, 300)).toBe(0);
    expect(sampleSpriteFrame(-1, 300)).toBe(0);
    expect(sampleSpriteFrame(Number.NaN, 300)).toBe(0);
    expect(sampleSpriteFrame(Number.POSITIVE_INFINITY, 300)).toBe(0);
  });
  it('does not turn invalid durations into a busy timer', () => {
    for (const invalid of [0, -300, 0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(spriteFrameDuration(invalid)).toBe(BIG_FIRE_FRAME_MS);
    }
    expect(spriteFrameDuration(SMALL_FIRE_FRAME_MS)).toBe(SMALL_FIRE_FRAME_MS);
  });
  it('keeps the native light loop subtle and seamless', () => {
    expect(sampleGlowProgress(0)).toBeCloseTo(sampleGlowProgress(1), 12);
    expect(sampleGlowProgress(0.5)).toBeCloseTo(1, 12);
    expect(FIRE_GLOW_STILL).toBeGreaterThan(FIRE_GLOW_MIN);
    expect(FIRE_GLOW_STILL).toBeLessThan(FIRE_GLOW_MAX);
    for (let i = 0; i <= 1000; i++) {
      const opacity = FIRE_GLOW_MIN + sampleGlowProgress(i / 1000) * (FIRE_GLOW_MAX - FIRE_GLOW_MIN);
      expect(opacity).toBeGreaterThanOrEqual(0.82);
      expect(opacity).toBeLessThanOrEqual(1);
    }
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(sampleGlowProgress(invalid)).toBeCloseTo(0, 12);
    }
  });
  it('keeps illumination continuous at a sprite change', () => {
    const before = sampleGlowProgress(299 / FIRE_GLOW_CYCLE_MS);
    const after = sampleGlowProgress(300 / FIRE_GLOW_CYCLE_MS);
    expect(Math.abs(before - after) * (FIRE_GLOW_MAX - FIRE_GLOW_MIN)).toBeLessThan(0.001);
  });
  it('only chooses existing sprites throughout long-running playback', () => {
    for (let t = 0; t < 100_000; t += 97) {
      expect([0, 1, 2]).toContain(sampleSpriteFrame(t, SMALL_FIRE_FRAME_MS));
      expect([0, 1, 2]).toContain(sampleSpriteFrame(t, BIG_FIRE_FRAME_MS));
    }
  });
});
