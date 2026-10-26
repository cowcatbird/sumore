import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';

import { CAMPSITE, CAMPFIRE_ORIGIN, sceneRect } from './campsite-layout';

type Bitmap = { width: number; height: number; data: Uint8Array };
const require = createRequire(import.meta.url);
const jimp = require('jimp-compact') as { read(bytes: Uint8Array): Promise<{ bitmap: Bitmap }> };
const snowBytes = readFileSync(new URL('../../assets/campsite/background-snow.png', import.meta.url));
let snow: Bitmap;
let forest: Bitmap;

beforeAll(async () => {
  [snow, forest] = await Promise.all([
    snowBytes,
    readFileSync(new URL('../../assets/campsite/background.png', import.meta.url)),
  ].map(async bytes => (await jimp.read(bytes)).bitmap));
});

describe('supplied snow campsite artwork', () => {
  it('keeps the latest supplied PNG unchanged, including its transparent right padding', () => {
    expect(createHash('sha256').update(snowBytes).digest('hex'))
      .toBe('392b785b931382c2258bd2ff96e704391f6dfe5557dee095b7aac000a66fb188');
    expect([snow.width, snow.height]).toEqual([1139, 1920]);
    let opaque = 0, partial = 0, transparent = 0, minVisibleAlpha = 255;
    for (let i = 3; i < snow.data.length; i += 4) {
      const alpha = snow.data[i];
      if (alpha === 0) transparent++;
      else {
        if (alpha === 255) opaque++; else partial++;
        minVisibleAlpha = Math.min(minVisibleAlpha, alpha);
      }
    }
    // Preserve the supplied translucency and baked snowman shading; neither
    // flatten the painting nor crop the padding out of the bitmap itself.
    expect({ opaque, partial, transparent, minVisibleAlpha })
      .toEqual({ opaque: 280420, partial: 1793180, transparent: 113280, minVisibleAlpha: 132 });
  });

  it('keeps the visible 1080 by 1920 painting at the origin without shifting its source coordinates', () => {
    expect([forest.width, forest.height]).toEqual([1080, 1920]);
    expect(snow.width - forest.width).toBe(59);
    expect(snow.height).toBe(forest.height);
    let missingArt = 0, paintedPadding = 0;
    for (let y = 0; y < snow.height; y++) for (let x = 0; x < snow.width; x++) {
      const alpha = snow.data[(y * snow.width + x) * 4 + 3];
      if (x < forest.width && alpha === 0) missingArt++;
      if (x >= forest.width && alpha !== 0) paintedPadding++;
    }
    expect({ missingArt, paintedPadding }).toEqual({ missingArt: 0, paintedPadding: 0 });
  });

  it('keeps the log and stone interiors at exactly the original fire coordinates', () => {
    const interiors = new Set(['555555ff', '1a1500ff', '443500ff']);
    const rgba = (bitmap: Bitmap, offset: number) => Buffer.from(bitmap.data.subarray(offset, offset + 4)).toString('hex');
    let checked = 0, different = 0;
    for (let y = 1190; y < 1350; y++) for (let x = 350; x < 715; x++) {
      const offset = (y * forest.width + x) * 4;
      const original = rgba(forest, offset);
      if (!interiors.has(original)) continue;
      // Ignore antialiased edges blended against the different ground colors.
      if (![-4, 4, -4 * forest.width, 4 * forest.width].every(delta => rgba(forest, offset + delta) === original)) continue;
      checked++;
      const snowOffset = (y * snow.width + x) * 4;
      if (rgba(snow, snowOffset) !== original) different++;
    }
    expect(checked).toBe(15600);
    expect(different).toBe(0);
    expect(CAMPFIRE_ORIGIN).toEqual({ x: 540, y: 1270 });
    const anchor = (CAMPFIRE_ORIGIN.y * snow.width + CAMPFIRE_ORIGIN.x) * 4;
    expect(Array.from(snow.data.subarray(anchor, anchor + 4))).toEqual([63, 50, 0, 255]);
  });

  it.each([320, 390, 560])('keeps the same fire attachment when the snowy scene is %ipx wide', width => {
    expect(CAMPSITE).toEqual({ width: 1080, height: 1700, skyCrop: 350 });
    const fire = sceneRect(width, 380, 950, 320, 335);
    // Scene scaling follows the visible painting, not its 59px blank padding.
    const unit = width / CAMPSITE.width;
    expect(fire.left + (CAMPFIRE_ORIGIN.x - 380) * unit).toBeCloseTo(540 * unit);
    expect(fire.top + (CAMPFIRE_ORIGIN.y - 950) * unit).toBeCloseTo((1270 - 350) * unit);
  });
});
