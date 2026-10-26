import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { NEW_HAT_ART, type NewHatId } from './new-hat-art';

const require = createRequire(import.meta.url);
const imageBytes = fs.readFileSync(new URL('../../assets/campsite/hats-extra.png', import.meta.url));
const png = require('pngjs').PNG.sync.read(imageBytes) as { width: number; height: number; data: Uint8Array };
const pixel = (x: number, y: number) => Array.from(png.data.slice((y * png.width + x) * 4, (y * png.width + x) * 4 + 4));
const hatIds = Object.keys(NEW_HAT_ART) as NewHatId[];

function containsCrop(hat: NewHatId, x: number, y: number) {
  const { crop } = NEW_HAT_ART[hat];
  return x >= crop.x && y >= crop.y && x < crop.x + crop.w && y < crop.y + crop.h;
}

describe('transparent additional hat atlas and measured reference anchors', () => {
  it('uses the exact unmodified transparent 1000 by 500 user-provided PNG', () => {
    expect([png.width, png.height]).toEqual([1000, 500]);
    expect(createHash('sha256').update(imageBytes).digest('hex')).toBe('3ef6966aefd014ffc69a2cc6330c32aeb9cc4741d2ed8bd55df6c81c559dad88');
    expect(hatIds).toEqual(['beanie', 'bucket', 'headband', 'propeller', 'wizard', 'pirate', 'clown', 'viking']);
    for (const [x, y] of [[0, 0], [500, 250], [999, 499]]) expect(pixel(x, y)[3]).toBe(0);
  });

  it.each(hatIds)('%s has a tight alpha crop without manually cut silhouettes', hat => {
    const art = NEW_HAT_ART[hat];
    const { crop } = art;
    expect(Object.keys(art)).toEqual(['crop', 'referenceHead']);
    expect(crop.w).toBeGreaterThan(0);
    expect(crop.h).toBeGreaterThan(0);
    expect(crop.x + crop.w).toBeLessThanOrEqual(1000);
    expect(crop.y + crop.h).toBeLessThanOrEqual(500);
    const opaque = [];
    for (let y = crop.y; y < crop.y + crop.h; y++) for (let x = crop.x; x < crop.x + crop.w; x++) {
      if (pixel(x, y)[3] > 0) opaque.push([x, y]);
    }
    expect(opaque.length).toBeGreaterThan(1500);
    expect(Math.min(...opaque.map(([x]) => x))).toBe(crop.x);
    expect(Math.max(...opaque.map(([x]) => x))).toBe(crop.x + crop.w - 1);
    expect(Math.min(...opaque.map(([, y]) => y))).toBe(crop.y);
    expect(Math.max(...opaque.map(([, y]) => y))).toBe(crop.y + crop.h - 1);
  });

  it('captures every nontransparent source pixel, including detached details and antialias edges', () => {
    let visible = 0;
    for (let y = 0; y < 500; y++) for (let x = 0; x < 1000; x++) {
      if (!pixel(x, y)[3]) continue;
      visible++;
      expect(hatIds.some(hat => containsCrop(hat, x, y))).toBe(true);
    }
    expect(visible).toBe(130251);
    // The pirate has one more antialias row than the retired polygon clip.
    expect(NEW_HAT_ART.pirate.crop.h).toBe(118);
  });

  it('retains only measured guide bounds, not reference head pixels', () => {
    hatIds.forEach((hat, index) => {
      expect(NEW_HAT_ART[hat].referenceHead).toEqual({ x: 46 + 250 * (index % 4), y: 75 + 250 * Math.floor(index / 4), w: 158, h: 152 });
    });
    for (const [x, y] of [[125, 195], [375, 195], [625, 190], [875, 200], [125, 435], [375, 450], [625, 460], [875, 445], [625, 85]]) {
      expect(pixel(x, y)[3]).toBe(0);
    }
  });

  it('preserves white beanie details and gray Viking metal as real opaque artwork', () => {
    expect(pixel(110, 42)).toEqual([255, 255, 255, 255]);
    expect(pixel(100, 112)).toEqual([255, 255, 255, 255]);
    for (const [x, y] of [[875, 325], [874, 384], [806, 315], [944, 315]]) expect(pixel(x, y)[3]).toBe(255);
  });

  it('keeps both propeller blades, transparent gaps, green clown hair, and the separate nose', () => {
    for (const [x, y] of [[825, 58], [892, 48], [625, 344], [634, 428]]) expect(pixel(x, y)[3]).toBe(255);
    for (const [x, y] of [[817, 74], [891, 63], [635, 398]]) expect(pixel(x, y)[3]).toBe(0);
  });
});
