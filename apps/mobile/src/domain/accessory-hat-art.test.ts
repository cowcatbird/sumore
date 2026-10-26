import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { ACCESSORY_HAT_ART } from './accessory-hat-art';
import { fitHat, hatAtlasGeometry } from './hat-fitting';
import { fitAtlasImage } from './sprite-atlas';

const require = createRequire(import.meta.url);
const bytes = fs.readFileSync(new URL('../../assets/campsite/hats-accessories.png', import.meta.url));
const png = require('pngjs').PNG.sync.read(bytes) as { width: number; height: number; data: Uint8Array };
const pixel = (x: number, y: number) => Array.from(png.data.slice((y * png.width + x) * 4, (y * png.width + x) * 4 + 4));
const entries = Object.entries(ACCESSORY_HAT_ART);

describe('six original accessory sprites', () => {
  it('preserves the transparent user file byte for byte', () => {
    expect([png.width, png.height]).toEqual([794, 317]);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('9d250d965b73ed0000afbfe98d9f64683ee5da6a5af17d4f4f06a6a31bc0d3e8');
    expect(entries.map(([id]) => id)).toEqual(['cat-ears', 'sunflower', 'lollipop', 'bubble-gum', 'googly-eyes', 'disguise-glasses']);
  });

  it.each(entries)('%s crop contains all antialiased edges and no neighboring item', (_id, { crop }) => {
    let left = Infinity, top = Infinity, right = -1, bottom = -1, count = 0;
    for (let y = crop.y; y < crop.y + crop.h; y++) for (let x = crop.x; x < crop.x + crop.w; x++) {
      if (!pixel(x, y)[3]) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); count++;
    }
    expect(count).toBeGreaterThan(1000);
    expect({ x: left, y: top, w: right - left + 1, h: bottom - top + 1 }).toEqual(crop);
  });

  it('contains every supplied pixel exactly once, including separated nose and eyebrows', () => {
    let count = 0;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      if (!pixel(x, y)[3]) continue;
      count++;
      expect(entries.filter(([, { crop }]) => x >= crop.x && x < crop.x + crop.w && y >= crop.y && y < crop.y + crop.h)).toHaveLength(1);
    }
    expect(count).toBe(18497);
  });

  it('never includes the white reference heads or a flattened black background', () => {
    for (const [x, y] of [[0, 0], [793, 316], [80, 110], [238, 115], [395, 85], [552, 85], [715, 122], [72, 248]]) {
      expect(pixel(x, y)[3]).toBe(0);
    }
    expect(pixel(698, 89)).toEqual([0, 0, 0, 255]); // Real pupil, not keyed-out black.
    expect(pixel(98, 274)).toEqual([233, 213, 153, 255]); // Nose stays intact.
  });

  it('keeps mouth decorations on the cheek and glasses across the face on both bodies', () => {
    for (const top of [194 - 65 * 214 / 133, 194 - 65 * 247 / 132]) {
      for (const [id, { crop, referenceHead }] of entries) {
        const hat = id as keyof typeof ACCESSORY_HAT_ART;
        const atlas = hatAtlasGeometry(hat);
        const fit = fitHat(hat, top, crop.w / crop.h);
        const image = fitAtlasImage(atlas.width, atlas.height, crop, fit);
        const scale = 65 / referenceHead.w;
        expect(image.x + referenceHead.x * scale).toBeCloseTo(43);
        expect(image.y + referenceHead.y * scale).toBeCloseTo(top);
        if (hat === 'lollipop' || hat === 'bubble-gum') {
          expect(fit.x).toBeGreaterThan(75.5);
          expect(fit.y).toBeGreaterThan(top + 20);
        }
        if (hat === 'disguise-glasses') {
          expect(fit.x).toBeLessThan(43);
          expect(fit.x + fit.width).toBeGreaterThan(108);
        }
      }
    }
  });
});
