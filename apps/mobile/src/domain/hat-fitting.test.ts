import { describe, expect, it } from 'vitest';

import { BODY_COLORS, HATS, type HatId } from './character';
import { ACCESSORY_HAT_ART } from './accessory-hat-art';
import { characterGeometryKey, counterMirrorHat, fitHat, HAT_CROPS, HAT_FITTING, hatAtlasGeometry } from './hat-fitting';
import { NEW_HAT_ART } from './new-hat-art';
import { CHARACTER_MIRROR_X, fitAtlasImage } from './sprite-atlas';

type FittedHat = Exclude<HatId, 'none'>;

// The dimensions of the supplied atlas crops, kept here as test inputs so this
// domain suite does not import a React Native renderer or load PNG modules.
const aspectRatios: Record<FittedHat, number> = {
  cowboy: 218 / 128,
  cow: 224 / 183,
  cat: 204 / 250,
  sunglasses: 183 / 73,
  duck: 101 / 114,
  'top-hat': 213 / 121,
  halo: 143 / 76,
  crown: 200 / 148,
  beanie: 194 / 124,
  bucket: 219 / 107,
  headband: 166 / 45,
  propeller: 202 / 136,
  wizard: 219 / 126,
  pirate: 274 / 118,
  clown: 185 / 154,
  viking: 198 / 122,
  'cat-ears': 121 / 90,
  sunflower: 72 / 73,
  lollipop: 55 / 49,
  'bubble-gum': 61 / 60,
  'googly-eyes': 74 / 33,
  'disguise-glasses': 125 / 84,
};

// Both body sprites share the same foot baseline and displayed width.
const headTops = {
  short: 194 - 65 * 214 / 133,
  tall: 194 - 65 * 247 / 132,
};
const headBounds = { left: 43, right: 108, depth: 53 };

describe('hat fitting', () => {
  it('has attachment data for every selectable accessory, but not None', () => {
    const expected = HATS.map(({ id }) => id).filter((id) => id !== 'none').sort();
    expect(Object.keys(HAT_FITTING).sort()).toEqual(expected);
    expect(Object.keys(aspectRatios).sort()).toEqual(expected);
    expect(Object.keys(HAT_CROPS).sort()).toEqual(expected);
    // None is handled by the renderer and excluded from fitHat's argument type.
    expect(Object.hasOwn(HAT_FITTING, 'none')).toBe(false);
  });

  it('keeps every crop within its own source sheet and at its approved aspect ratio', () => {
    for (const hat of Object.keys(HAT_CROPS) as FittedHat[]) {
      const crop = HAT_CROPS[hat];
      const atlas = hatAtlasGeometry(hat);
      expect(crop.w / crop.h).toBe(aspectRatios[hat]);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.w).toBeLessThanOrEqual(atlas.width);
      expect(crop.y + crop.h).toBeLessThanOrEqual(atlas.height);
    }
  });

  it('selects the transparent additional sheet without synthetic silhouette paths', () => {
    for (const { id } of HATS) {
      const expected = Object.hasOwn(ACCESSORY_HAT_ART, id)
        ? { width: 794, height: 317, sheet: 'accessories' }
        : Object.hasOwn(NEW_HAT_ART, id)
          ? { width: 1000, height: 500, sheet: 'extra' }
          : { width: 1250, height: 500, sheet: 'original' };
      expect(hatAtlasGeometry(id)).toEqual(expected);
    }
  });

  it('maps every original guide to the head, with only the approved propeller lift', () => {
    for (const [id, art] of Object.entries({ ...NEW_HAT_ART, ...ACCESSORY_HAT_ART })) {
      const hat = id as keyof typeof NEW_HAT_ART | keyof typeof ACCESSORY_HAT_ART;
      const { crop, referenceHead } = art;
      const offsetY = hat === 'propeller' ? -4 : 0;
      for (const top of Object.values(headTops)) {
        const viewport = fitHat(hat, top, crop.w / crop.h);
        const atlas = hatAtlasGeometry(hat);
        const image = fitAtlasImage(atlas.width, atlas.height, crop, viewport);
        const scale = image.width / atlas.width;
        expect(scale).toBeCloseTo(65 / referenceHead.w);
        expect(image.x + referenceHead.x * scale).toBeCloseTo(headBounds.left);
        expect(image.x + (referenceHead.x + referenceHead.w) * scale).toBeCloseTo(headBounds.right);
        expect(image.x + (referenceHead.x + referenceHead.w / 2) * scale).toBeCloseTo(75.5);
        expect(image.y + referenceHead.y * scale).toBeCloseTo(top + offsetY);
        expect(viewport.width).toBeCloseTo(crop.w * scale);
        expect(viewport.y + viewport.height - top).toBeCloseTo((crop.y + crop.h - referenceHead.y) * scale + offsetY);
      }
    }
  });

  it('keeps the propeller brim overhang instead of recentering its whole crop', () => {
    const { crop, referenceHead } = NEW_HAT_ART.propeller;
    expect(referenceHead).toEqual({ x: 796, y: 75, w: 158, h: 152 });
    const scale = 65 / 158;
    expect(HAT_FITTING.propeller).toEqual({ width: 202 * scale, bottom: 95 * scale - 4, offsetX: 13 * scale });
    expect(HAT_FITTING.propeller.offsetX).toBeGreaterThan(5);
    for (const top of Object.values(headTops)) {
      const viewport = fitHat('propeller', top, crop.w / crop.h);
      const image = fitAtlasImage(1000, 500, crop, viewport);
      // The source guide center is 875; the accessory's bounds center is 888.
      expect(image.x + 875 * scale).toBeCloseTo(75.5);
      expect(viewport.x + viewport.width / 2).toBeCloseTo(75.5 + 13 * scale);
      expect(CHARACTER_MIRROR_X - image.x - 875 * scale).toBeCloseTo(75.5);
    }
  });

  it.each(['short', 'tall'] as const)('lifts the propeller four units on the %s body without resizing or shifting it sideways', body => {
    const { crop, referenceHead } = NEW_HAT_ART.propeller;
    const scale = 65 / referenceHead.w;
    const previous = {
      x: headBounds.left + (crop.x - referenceHead.x) * scale,
      y: headTops[body] + (crop.y - referenceHead.y) * scale,
      width: crop.w * scale,
      height: crop.h * scale,
    };
    const current = fitHat('propeller', headTops[body], aspectRatios.propeller);
    expect(current.x).toBeCloseTo(previous.x);
    expect(current.width).toBeCloseTo(previous.width);
    expect(current.height).toBeCloseTo(previous.height);
    expect(current.y - previous.y).toBeCloseTo(-4);
  });

  describe.each(Object.keys(aspectRatios) as FittedHat[])('%s', (hat) => {
    it('has finite, sensible attachment values', () => {
      const fitting = HAT_FITTING[hat];
      for (const value of Object.values(fitting)) expect(Number.isFinite(value)).toBe(true);
      expect(fitting.width).toBeGreaterThanOrEqual(30);
      expect(fitting.width).toBeLessThanOrEqual(hat === 'pirate' ? 114 : 100);
      // Face/cheek decorations follow the off-center reference, not a brim.
      expect(Math.abs(fitting.offsetX)).toBeLessThanOrEqual(Object.hasOwn(ACCESSORY_HAT_ART, hat) ? 30 : 10);
      expect(fitting.bottom).toBeGreaterThanOrEqual(-20);
      expect(fitting.bottom).toBeLessThanOrEqual(100);
    });

    it('preserves the sprite proportions and fits inside both character viewports', () => {
      for (const headTop of Object.values(headTops)) {
        const fitted = fitHat(hat, headTop, aspectRatios[hat]);
        for (const value of Object.values(fitted)) expect(Number.isFinite(value)).toBe(true);
        expect(fitted.width / fitted.height).toBeCloseTo(aspectRatios[hat]);
        expect(fitted.height).toBeGreaterThan(0);
        expect(fitted.height).toBeLessThanOrEqual(110);
        expect(fitted.x).toBeGreaterThanOrEqual(0);
        expect(fitted.x + fitted.width).toBeLessThanOrEqual(160);
        expect(fitted.y).toBeGreaterThanOrEqual(0);
        expect(fitted.y + fitted.height).toBeLessThanOrEqual(194);
        expect(fitted.x + fitted.width / 2).toBeCloseTo(75.5 + HAT_FITTING[hat].offsetX);
      }
    });

    it('keeps the same head attachment when switching between short and tall', () => {
      const short = fitHat(hat, headTops.short, aspectRatios[hat]);
      const tall = fitHat(hat, headTops.tall, aspectRatios[hat]);
      expect(tall.x).toBe(short.x);
      expect(tall.width).toBe(short.width);
      expect(tall.height).toBe(short.height);
      expect(tall.y - short.y).toBeCloseTo(headTops.tall - headTops.short);
      expect(short.y + short.height - headTops.short).toBeCloseTo(HAT_FITTING[hat].bottom);
      expect(tall.y + tall.height - headTops.tall).toBeCloseTo(HAT_FITTING[hat].bottom);
    });

    it('keeps the bottom attachment stable if the crop aspect ratio changes', () => {
      const original = fitHat(hat, headTops.short, aspectRatios[hat]);
      const wider = fitHat(hat, headTops.short, aspectRatios[hat] * 1.25);
      expect(wider.x).toBe(original.x);
      expect(wider.width).toBe(original.width);
      expect(wider.height).toBeLessThan(original.height);
      expect(wider.y + wider.height).toBeCloseTo(original.y + original.height);
    });
  });

  it.each([
    ['cowboy', 83],
    ['cow', 79],
    ['sunglasses', 51],
    ['duck', 34],
    ['halo', 61],
  ] as const)('enlarges %s beyond its previous fit', (hat, previousWidth) => {
    expect(HAT_FITTING[hat].width).toBeGreaterThan(previousWidth);
  });

  it('preserves the approved top hat fit and crown width', () => {
    expect(HAT_FITTING['top-hat']).toEqual({ width: 76, bottom: 13, offsetX: 0 });
    expect(HAT_FITTING.crown.width).toBe(73);
  });

  it('matches the reference cat with the tail above the lower torso', () => {
    for (const headTop of Object.values(headTops)) {
      const cat = fitHat('cat', headTop, aspectRatios.cat);
      expect(cat.x + cat.width / 2).toBeGreaterThan((headBounds.left + headBounds.right) / 2);
      expect(cat.width).toBeLessThan(80);
      expect(cat.y + cat.height - headTop).toBeGreaterThan(headBounds.depth);
      expect(cat.y + cat.height - headTop).toBeLessThan(70);
    }
  });

  it('keeps the cat artwork unmirrored for a left-facing camper without changing other hats', () => {
    expect(counterMirrorHat('cat', 'left')).toBe(true);
    expect(counterMirrorHat('cat', 'right')).toBe(false);
    for (const { id } of HATS.filter(({ id }) => id !== 'cat')) {
      expect(counterMirrorHat(id, 'left')).toBe(false);
      expect(counterMirrorHat(id, 'right')).toBe(false);
    }
  });

  it('spans the entire head with the cow hood on either body', () => {
    for (const headTop of Object.values(headTops)) {
      const cow = fitHat('cow', headTop, aspectRatios.cow);
      expect(cow.x).toBeLessThan(headBounds.left);
      expect(cow.x + cow.width).toBeGreaterThan(headBounds.right);
      expect(cow.y).toBeLessThan(headTop);
      expect(cow.y + cow.height).toBeGreaterThanOrEqual(headTop + headBounds.depth);
    }
  });

  it('nudges only the cow hood three units toward its muzzle without changing its size or height', () => {
    expect(HAT_FITTING.cow).toEqual({ width: 96, bottom: 57, offsetX: 2 });
    for (const headTop of Object.values(headTops)) {
      const cow = fitHat('cow', headTop, aspectRatios.cow);
      const previous = { x: 75.5 - 1 - 96 / 2, y: headTop + 57 - 96 / aspectRatios.cow };
      expect(cow.x - previous.x).toBe(3);
      expect(cow.y).toBe(previous.y);
      expect(cow.width).toBe(96);
      expect(cow.height).toBeCloseTo(78.428571);
      for (const facing of ['left', 'right'] as const) {
        // Mirror the optical correction with the artwork, so the round part
        // still covers the head when the protruding muzzle faces left.
        const left = facing === 'left' ? CHARACTER_MIRROR_X - cow.x - cow.width : cow.x;
        const previousLeft = facing === 'left' ? CHARACTER_MIRROR_X - previous.x - cow.width : previous.x;
        expect(left - previousLeft).toBe(facing === 'left' ? -3 : 3);
        expect(left).toBeLessThan(headBounds.left);
        expect(left + cow.width).toBeGreaterThan(headBounds.right);
      }
    }
  });

  it('preserves every original non-cow attachment when adding accessories', () => {
    const unchanged = Object.fromEntries(Object.entries(HAT_FITTING)
      .filter(([id]) => id !== 'cow' && !Object.hasOwn(NEW_HAT_ART, id) && !Object.hasOwn(ACCESSORY_HAT_ART, id)));
    expect(unchanged).toEqual({
      cowboy: { width: 94, bottom: 24, offsetX: 0 },
      cat: { width: 77, bottom: 64, offsetX: 2 },
      sunglasses: { width: 70, bottom: 40, offsetX: 0 },
      duck: { width: 42, bottom: 10, offsetX: 1 },
      'top-hat': { width: 76, bottom: 13, offsetX: 0 },
      halo: { width: 69, bottom: -1, offsetX: 0 },
      crown: { width: 73, bottom: 24, offsetX: 0 },
    });
  });

  it('extends the sunglasses past both sides of the head', () => {
    for (const headTop of Object.values(headTops)) {
      const sunglasses = fitHat('sunglasses', headTop, aspectRatios.sunglasses);
      expect(sunglasses.x).toBeLessThan(headBounds.left);
      expect(sunglasses.x + sunglasses.width).toBeGreaterThan(headBounds.right);
      expect(sunglasses.y).toBeGreaterThan(headTop);
      expect(sunglasses.y + sunglasses.height).toBeLessThan(headTop + headBounds.depth);
      expect(sunglasses.width).toBeLessThan(75);
    }
  });

  it('lowers the halo toward the head while retaining a floating gap', () => {
    for (const headTop of Object.values(headTops)) {
      const halo = fitHat('halo', headTop, aspectRatios.halo);
      expect(halo.y + halo.height).toBeLessThan(headTop);
      expect(halo.y + halo.height).toBeGreaterThan(headTop - 7);
    }
  });

  it('seats the cowboy and crown deeper than the unchanged top hat', () => {
    for (const headTop of Object.values(headTops)) {
      const topHat = fitHat('top-hat', headTop, aspectRatios['top-hat']);
      for (const hat of ['cowboy', 'top-hat', 'crown'] as const) {
        const brim = fitHat(hat, headTop, aspectRatios[hat]);
        expect(brim.y).toBeLessThan(headTop);
        expect(brim.y + brim.height).toBeGreaterThan(headTop);
        if (hat !== 'top-hat') {
          expect(brim.y + brim.height).toBeGreaterThan(topHat.y + topHat.height);
          expect(brim.y + brim.height - headTop).toBeGreaterThan(16);
        }
      }
    }
  });
});

describe('Android appearance-change crop regression', () => {
  it('never reuses native geometry across colors, hats, body types, facing, or marshmallow states', () => {
    const keys: string[] = [];
    for (const body of ['short', 'tall'] as const) {
      for (const { id: color } of BODY_COLORS) {
        for (const { id: hat } of HATS) {
          for (const facing of ['left', 'right'] as const) {
            for (const burnt of [false, true]) {
              const appearance = { body, color, hat };
              const key = characterGeometryKey(appearance, facing, burnt);
              keys.push(key);
              // A new object from polling the same saved look must not remount.
              expect(characterGeometryKey({ ...appearance }, facing, burnt)).toBe(key);
            }
          }
        }
      }
    }
    expect(keys).toHaveLength(BODY_COLORS.length * HATS.length * 2 * 2 * 2);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps native geometry when an older camper receives an explicit cream color', () => {
    for (const body of ['short', 'tall'] as const) {
      for (const { id: hat } of HATS) {
        for (const facing of ['left', 'right'] as const) {
          for (const burnt of [false, true]) {
            const appearance = { body, hat };
            expect(characterGeometryKey({ ...appearance, color: 'cream' }, facing, burnt))
              .toBe(characterGeometryKey(appearance, facing, burnt));
          }
        }
      }
    }
  });

  it('replaces the sunglasses eye-strip crop when switching to the cow hood', () => {
    for (const body of ['short', 'tall'] as const) {
      const eyeStrip = fitHat('sunglasses', headTops[body], aspectRatios.sunglasses);
      const hood = fitHat('cow', headTops[body], aspectRatios.cow);
      expect(eyeStrip.width).toBe(70);
      expect(eyeStrip.height).toBeCloseTo(27.923497);
      expect(hood.width).toBe(96);
      expect(hood.height).toBeCloseTo(78.428571);
      expect(hood.y).toBeLessThan(eyeStrip.y);
      expect(hood.y + hood.height).toBeGreaterThan(eyeStrip.y + eyeStrip.height);
      for (const facing of ['left', 'right'] as const) {
        expect(characterGeometryKey({ body, hat: 'cow' }, facing, false))
          .not.toBe(characterGeometryKey({ body, hat: 'sunglasses' }, facing, false));
      }
    }
  });

  it.each([57, 100, 160, 240])('preserves every full hat crop and directional fit at %ipx', size => {
    for (const body of ['short', 'tall'] as const) {
      for (const hat of Object.keys(HAT_CROPS) as FittedHat[]) {
        const crop = HAT_CROPS[hat];
        const atlas = hatAtlasGeometry(hat);
        const placement = fitHat(hat, headTops[body], crop.w / crop.h);
        const image = fitAtlasImage(atlas.width, atlas.height, crop, placement);
        const atlasScale = image.width / atlas.width;
        const displayScale = size / 160;
        for (const facing of ['left', 'right'] as const) {
          const mirrored = facing === 'left' && !counterMirrorHat(hat, facing);
          const projectX = (x: number) => (mirrored ? CHARACTER_MIRROR_X - x : x) * displayScale;
          const sourceXs = [crop.x, crop.x + crop.w].map(x => projectX(image.x + x * atlasScale)).sort((a, b) => a - b);
          const clipXs = [placement.x, placement.x + placement.width].map(projectX).sort((a, b) => a - b);
          expect(sourceXs[0]).toBeCloseTo(clipXs[0]);
          expect(sourceXs[1]).toBeCloseTo(clipXs[1]);
          expect((image.y + crop.y * atlasScale) * displayScale).toBeCloseTo(placement.y * displayScale);
          expect((image.y + (crop.y + crop.h) * atlasScale) * displayScale)
            .toBeCloseTo((placement.y + placement.height) * displayScale);
          expect(sourceXs[1] - sourceXs[0]).toBeCloseTo(placement.width * displayScale);
          expect(image.height / atlas.height).toBeCloseTo(atlasScale);
        }
      }
    }
  });
});
