import { describe, expect, it } from 'vitest';
import { CAMPSITE, CAMPER_SLOTS, camperRect, campsitePositions, sceneRect } from './campsite-layout';

describe('native campsite coordinate registration', () => {
  it('keeps the fire anchored to the painted log pile at every viewport size', () => {
    for (const width of [287, 320, 393, 560]) {
      const rect = sceneRect(width, 380, 950, 320, 335);
      const unit = width / CAMPSITE.width;
      expect(rect.left + 160 * unit).toBeCloseTo(width / 2);
      expect(rect.top + 320 * unit).toBeCloseTo((1270 - 350) * unit);
    }
  });
  it('puts every camper foot at its seat, not at the SVG origin', () => {
    for (const width of [287, 393, 560]) for (const slot of CAMPER_SLOTS) {
      const rect = camperRect(width, slot);
      const unit = width / CAMPSITE.width;
      expect(rect.left + 76 * slot.scale * unit).toBeCloseTo(slot.x * unit);
      expect(rect.top + 194 * slot.scale * unit).toBeCloseTo((slot.y - 350) * unit);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.left + rect.width).toBeLessThanOrEqual(width);
      expect(rect.top).toBeGreaterThan(0);
    }
  });
  it('preserves the one/two-person layout and never invents seats', () => {
    expect(campsitePositions(0)).toHaveLength(0);
    expect(campsitePositions(1)).toEqual([CAMPER_SLOTS[2]]);
    expect(campsitePositions(2)).toEqual([CAMPER_SLOTS[2], CAMPER_SLOTS[3]]);
    for (const count of [3, 4, 5, 6]) expect(campsitePositions(count)).toHaveLength(count);
    expect(campsitePositions(8)).toHaveLength(6);
  });
});
