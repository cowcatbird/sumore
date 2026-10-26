import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';

import { BODY_COLORS } from './character';
import { atlasRegionViewport, BURNT_CAP_REGION, BURNT_HAND_CROP, COLORED_CAMPER_ATLAS, coloredBodyCrop, coloredHandArt, HAND_VIEWPORT, ORIGINAL_BODY_CROPS, type PaintedBodyColor } from './colored-camper-art';
import { CHARACTER_MIRROR_X, fitAtlasImage, marshmallowFlameViewport, type SpriteCrop, type SpriteViewport } from './sprite-atlas';

type Bitmap = { width: number; height: number; data: Uint8Array };
type Pixel = { x: number; y: number; r: number; g: number; b: number; a: number };
const require = createRequire(import.meta.url);
const jimp = require('jimp-compact') as { read(bytes: Uint8Array): Promise<{ bitmap: Bitmap }> };
const imageBytes = readFileSync(new URL('../../assets/campsite/colored-campers.png', import.meta.url));
const colors: PaintedBodyColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'pink'];
const fills = { red: 'ff6464', orange: 'f3dbb5', yellow: 'f8ff8f', green: 'c3f4d0', blue: 'a9dbff', pink: 'f4c3e1' };
const outlines = { red: 'b90000', orange: 'e4ae58', yellow: 'cdda00', green: '78e593', blue: '7ac7ff', pink: 'e675b9' };
// Independently measured nontransparent bounds from the supplied PNG.
const sourceHands: Record<PaintedBodyColor, { full: SpriteCrop; cap: SpriteCrop }> = {
  red: { full: { x: 393, y: 105, w: 93, h: 92 }, cap: { x: 447, y: 105, w: 39, h: 40 } },
  orange: { full: { x: 390, y: 424, w: 94, h: 92 }, cap: { x: 444, y: 424, w: 40, h: 40 } },
  yellow: { full: { x: 390, y: 738, w: 94, h: 92 }, cap: { x: 444, y: 738, w: 40, h: 40 } },
  green: { full: { x: 1018, y: 110, w: 93, h: 92 }, cap: { x: 1072, y: 110, w: 39, h: 40 } },
  blue: { full: { x: 1018, y: 424, w: 93, h: 92 }, cap: { x: 1072, y: 424, w: 39, h: 40 } },
  pink: { full: { x: 1018, y: 738, w: 93, h: 92 }, cap: { x: 1072, y: 738, w: 39, h: 40 } },
};
let painted: Bitmap;
let originalBody: Bitmap;
let originalStick: Bitmap;

beforeAll(async () => {
  [painted, originalBody, originalStick] = await Promise.all([
    imageBytes,
    readFileSync(new URL('../../assets/campsite/sprites2.png', import.meta.url)),
    readFileSync(new URL('../../assets/campsite/hand-and-marshmellow.png', import.meta.url)),
  ].map(async bytes => (await jimp.read(bytes)).bitmap));
});

function inside(x: number, y: number, region: SpriteViewport) {
  return x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
}

function pixels(bitmap: Bitmap, crop: SpriteCrop): Pixel[] {
  const result: Pixel[] = [];
  for (let y = Math.max(0, Math.floor(crop.y)); y < Math.min(bitmap.height, Math.ceil(crop.y + crop.h)); y++) {
    for (let x = Math.max(0, Math.floor(crop.x)); x < Math.min(bitmap.width, Math.ceil(crop.x + crop.w)); x++) {
      const i = (y * bitmap.width + x) * 4;
      const [r, g, b, a] = bitmap.data.slice(i, i + 4);
      if (a) result.push({ x, y, r, g, b, a });
    }
  }
  return result;
}

function hex(pixel: Pixel) {
  return [pixel.r, pixel.g, pixel.b].map(value => value.toString(16).padStart(2, '0')).join('');
}

function bounds(points: Pixel[]): SpriteCrop {
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x + 1, h: Math.max(...ys) - y + 1 };
}

function project(bitmap: Bitmap, crop: SpriteCrop, viewport: SpriteViewport, x: number, y: number) {
  const image = fitAtlasImage(bitmap.width, bitmap.height, crop, viewport);
  const scale = image.width / bitmap.width;
  return { x: image.x + x * scale, y: image.y + y * scale };
}

function alphaAt(bitmap: Bitmap, crop: SpriteCrop, x: number, y: number) {
  const image = fitAtlasImage(bitmap.width, bitmap.height, crop, HAND_VIEWPORT);
  const scale = image.width / bitmap.width;
  const sourceX = Math.floor((x - image.x) / scale), sourceY = Math.floor((y - image.y) / scale);
  return sourceX < 0 || sourceY < 0 || sourceX >= bitmap.width || sourceY >= bitmap.height
    ? 0 : bitmap.data[(sourceY * bitmap.width + sourceX) * 4 + 3];
}

describe('supplied colored camper PNG', () => {
  it('retains the exact transparent user sheet and its antialiased edges', () => {
    expect(createHash('sha256').update(imageBytes).digest('hex')).toBe('cb708eb093f2083595655c432e306f025f231eb17fc5020fd417967b5eedb15f');
    expect({ width: painted.width, height: painted.height }).toEqual(COLORED_CAMPER_ATLAS);
    expect(COLORED_CAMPER_ATLAS).toEqual({ width: 1111, height: 885 });
    const alphaCounts = { transparent: 0, opaque: 0, antialiased: 0 };
    for (let i = 3; i < painted.data.length; i += 4) {
      const a = painted.data[i];
      alphaCounts[a === 0 ? 'transparent' : a === 255 ? 'opaque' : 'antialiased']++;
    }
    expect(alphaCounts).toEqual({ transparent: 672830, opaque: 299226, antialiased: 11179 });
  });

  it.each(colors)('isolates both %s bodies and preserves their supplied fill', color => {
    const row = (colors.indexOf(color) % 3) * 314;
    const column = colors.indexOf(color) < 3 ? 0 : 628;
    for (const body of ['tall', 'short'] as const) {
      const crop = coloredBodyCrop(color, body);
      const points = pixels(painted, crop);
      expect(bounds(points)).toEqual(body === 'tall'
        ? { x: 7 + column, y: 7 + row, w: column ? 130 : 131, h: 243 }
        : { x: 196 + column, y: 38 + row, w: 131, h: 212 });
      expect(new Set(points.filter(pixel => pixel.a === 255).map(hex))).toEqual(new Set([fills[color]]));
      expect(points.length).toBeGreaterThan(22000);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y + crop.h).toBeLessThanOrEqual(painted.height);
      expect(crop.x + crop.w).toBeLessThanOrEqual(painted.width);
    }
    expect(BODY_COLORS.find(option => option.id === color)?.hex.toLowerCase()).toBe(`#${fills[color]}`);
  });

  it('includes every visible sprite pixel in exactly one crop, including all right-edge hands', () => {
    const crops = colors.flatMap(color => [coloredBodyCrop(color, 'tall'), coloredBodyCrop(color, 'short'), coloredHandArt(color).crop]);
    let visible = 0, missingOrDuplicated = 0;
    for (let y = 0; y < painted.height; y++) for (let x = 0; x < painted.width; x++) {
      if (!painted.data[(y * painted.width + x) * 4 + 3]) continue;
      visible++;
      const owners = crops.filter(crop => x >= crop.x && x < crop.x + crop.w && y >= crop.y && y < crop.y + crop.h);
      if (owners.length !== 1) missingOrDuplicated++;
    }
    expect(visible).toBe(310405);
    expect(missingOrDuplicated).toBe(0);
    for (const color of ['green', 'blue', 'pink'] as const) {
      const crop = coloredHandArt(color).crop;
      expect(crop.x + crop.w).toBe(painted.width + 1);
    }
  });
});

describe('colored camper placement', () => {
  it.each(['tall', 'short'] as const)('preserves the original %s head position, width, and baseline', body => {
    const original = ORIGINAL_BODY_CROPS[body];
    expect(original).toEqual(body === 'tall'
      ? { x: 237, y: 424, w: 132, h: 247 }
      : { x: 443, y: 459, w: 133, h: 214 });
    const height = 65 * original.h / original.w;
    const viewport = { x: 43, y: 194 - height, width: 65, height };
    const originalPixels = pixels(originalBody, original);
    const centroid = (points: Pixel[]) => {
      const weight = points.reduce((sum, pixel) => sum + pixel.a, 0);
      return { x: points.reduce((sum, pixel) => sum + pixel.x * pixel.a, 0) / weight,
        y: points.reduce((sum, pixel) => sum + pixel.y * pixel.a, 0) / weight };
    };
    const oldCenter = centroid(originalPixels);
    const oldPosition = project(originalBody, original, viewport, oldCenter.x, oldCenter.y);
    for (const color of colors) {
      const crop = coloredBodyCrop(color, body);
      expect([crop.w, crop.h]).toEqual([original.w, original.h]);
      const placed = atlasRegionViewport(COLORED_CAMPER_ATLAS, crop, viewport, crop);
      expect(placed.x).toBeCloseTo(43);
      expect(placed.y).toBeCloseTo(viewport.y);
      expect(placed.width).toBeCloseTo(65);
      expect(placed.y + placed.height).toBeCloseTo(194);
      const center = centroid(pixels(painted, crop));
      const position = project(painted, crop, viewport, center.x, center.y);
      // The supplied art has subpixel export differences; keep its center
      // within half a display pixel while retaining the exact legacy layout.
      expect(Math.abs(position.x - oldPosition.x)).toBeLessThan(0.5);
      expect(Math.abs(position.y - oldPosition.y)).toBeLessThan(0.5);
    }
  });

  it.each(colors)('keeps the %s hand fill, outline, and fresh cap in their own regions', color => {
    const art = coloredHandArt(color);
    const points = pixels(painted, art.crop);
    expect(bounds(points)).toEqual(sourceHands[color].full);
    const hand = points.filter(pixel => {
      const position = project(painted, art.crop, HAND_VIEWPORT, pixel.x + 0.5, pixel.y + 0.5);
      return inside(position.x, position.y, art.hand);
    });
    expect(hand.filter(pixel => pixel.a === 255 && hex(pixel) === fills[color]).length).toBeGreaterThan(450);
    expect(hand.filter(pixel => pixel.a === 255 && hex(pixel) === outlines[color]).length).toBeGreaterThan(400);
    expect(hand.some(pixel => pixel.a === 255 && (hex(pixel) === 'ffffff' || hex(pixel) === '858585'))).toBe(false);
    const cap = points.filter(pixel => {
      const position = project(painted, art.crop, HAND_VIEWPORT, pixel.x + 0.5, pixel.y + 0.5);
      return inside(position.x, position.y, art.marshmallow);
    });
    expect(cap.filter(pixel => pixel.a === 255 && hex(pixel) === 'ffffff').length).toBeGreaterThan(400);
    expect(cap.filter(pixel => pixel.a === 255 && hex(pixel) === '858585').length).toBeGreaterThan(400);
    expect(art.hand.y).toBeGreaterThan(art.marshmallow.y + art.marshmallow.height);
  });

  it.each(colors)('keeps the measured %s cap center at the previous hand attachment', color => {
    const art = coloredHandArt(color);
    const cap = pixels(painted, sourceHands[color].cap)
      .filter(pixel => pixel.a > 128 && pixel.r === pixel.g && pixel.g === pixel.b);
    const weight = cap.reduce((sum, pixel) => sum + pixel.a, 0);
    const x = cap.reduce((sum, pixel) => sum + (pixel.x + 0.5) * pixel.a, 0) / weight;
    const y = cap.reduce((sum, pixel) => sum + (pixel.y + 0.5) * pixel.a, 0) / weight;
    const center = project(painted, art.crop, HAND_VIEWPORT, x, y);
    expect(HAND_VIEWPORT).toEqual({ x: 94, y: 119, width: 57, height: 57 });
    // Measured from the previous transparent sheet rendered into this viewport.
    expect(Math.abs(center.x - 138.682)).toBeLessThan(0.1);
    expect(Math.abs(center.y - 131.494)).toBeLessThan(0.1);
  });
});

describe('burnt cap composite', () => {
  it.each(colors)('removes every supplied fresh %s cap pixel while keeping the colored hand', color => {
    const art = coloredHandArt(color);
    const capPixels = pixels(painted, sourceHands[color].cap);
    let retainedCap = 0;
    for (const pixel of capPixels) {
      const position = project(painted, art.crop, HAND_VIEWPORT, pixel.x + 0.5, pixel.y + 0.5);
      if (inside(position.x, position.y, art.stickBelowCap)) retainedCap++;
    }
    expect(capPixels.length).toBeGreaterThan(1000);
    expect(retainedCap).toBe(0);
    expect(art.stickBelowCap.y).toBeCloseTo(143.3);
    expect(art.hand.y).toBeGreaterThan(art.stickBelowCap.y);
    expect(art.hand.y + art.hand.height).toBeLessThan(art.stickBelowCap.y + art.stickBelowCap.height);
  });

  it('retains the original burnt cap and connector without including any old white hand pixels', () => {
    const retained = pixels(originalStick, BURNT_CAP_REGION);
    expect(retained.filter(pixel => pixel.a === 255 && hex(pixel) === '22180c').length).toBeGreaterThan(800);
    expect(retained.filter(pixel => pixel.a === 255 && hex(pixel) === '74532b').length).toBeGreaterThan(150);
    // Black/dark antialias pixels belong to the burnt cap; the old hand is
    // white inside a gray ring, so exclude only those light neutral pixels.
    expect(retained.some(pixel => pixel.r >= 100 && pixel.r === pixel.g && pixel.g === pixel.b)).toBe(false);
    const oldHand = pixels(originalStick, { x: 421, y: 513, w: 53, h: 52 });
    expect(oldHand.filter(pixel => pixel.a === 255 && hex(pixel) === 'ffffff').length).toBeGreaterThan(900);
    expect(BURNT_CAP_REGION.y + BURNT_CAP_REGION.h).toBeLessThanOrEqual(Math.min(...oldHand.map(pixel => pixel.y)));
  });

  it.each(colors)('overlaps the real %s stick pixels with the burnt connector across the seam', color => {
    const art = coloredHandArt(color);
    const cap = atlasRegionViewport(originalStick, BURNT_HAND_CROP, HAND_VIEWPORT, BURNT_CAP_REGION);
    let overlapCount = 0, minY = Infinity, maxY = -Infinity;
    // Sample the projected PNG alpha, not merely intersecting clip rectangles.
    for (let y = art.stickBelowCap.y + 0.125; y < cap.y + cap.height; y += 0.25) {
      for (let x = cap.x + 0.125; x < cap.x + cap.width; x += 0.25) {
        if (!inside(x, y, art.stickBelowCap) || !inside(x, y, cap)) continue;
        if (alphaAt(painted, art.crop, x, y) > 128 && alphaAt(originalStick, BURNT_HAND_CROP, x, y) > 128) {
          overlapCount++;
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    expect(overlapCount).toBeGreaterThan(80);
    expect(minY - art.stickBelowCap.y).toBeLessThan(0.5);
    expect(maxY - minY).toBeGreaterThan(4);
  });

  it('keeps the original burnt cap at the same flame attachment in both directions', () => {
    const cap = atlasRegionViewport(originalStick, BURNT_HAND_CROP, HAND_VIEWPORT, { x: 492, y: 444, w: 55, h: 54 });
    expect(cap.x).toBeCloseTo(126.5714285714);
    expect(cap.y).toBeCloseTo(119.6428571429);
    expect(cap.width).toBeCloseTo(23.5714285714);
    expect(cap.height).toBeCloseTo(23.1428571429);
    const right = marshmallowFlameViewport('right');
    expect(right).toEqual({ x: 128, y: 99, width: 27, height: 34 });
    expect(right.y + right.height).toBeGreaterThan(cap.y);
    expect(right.y + right.height).toBeLessThan(cap.y + cap.height);
    const left = marshmallowFlameViewport('left');
    expect(left.x).toBe(CHARACTER_MIRROR_X - right.x - right.width);
    const mirroredCapX = CHARACTER_MIRROR_X - cap.x - cap.width;
    expect(mirroredCapX + cap.width).toBeGreaterThan(left.x);
    expect(mirroredCapX).toBeLessThan(left.x + left.width);
  });
});
