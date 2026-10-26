import type { BodyColorId, CharacterAppearance } from './character';
import { fitAtlasImage, type SpriteCrop, type SpriteViewport } from './sprite-atlas';

export type PaintedBodyColor = Exclude<BodyColorId, 'cream'>;

/** The user's transparent sheet is used verbatim, never recolored at runtime. */
export const COLORED_CAMPER_ATLAS = { width: 1111, height: 885 };
export const ORIGINAL_BODY_CROPS: Record<CharacterAppearance['body'], SpriteCrop> = {
  tall: { x: 237, y: 424, w: 132, h: 247 },
  short: { x: 443, y: 459, w: 133, h: 214 },
};

const bodyPanel: Record<PaintedBodyColor, { x: number; y: number }> = {
  red: { x: 0, y: 0 },
  orange: { x: 0, y: 314 },
  yellow: { x: 0, y: 628 },
  green: { x: 628, y: 0 },
  blue: { x: 628, y: 314 },
  pink: { x: 628, y: 628 },
};

// Hand positions are individually measured; they do not share the body grid.
// Fractional crop padding keeps the previous hand/cap centers despite the
// new sheet's subpixel export positions. The PNG pixels are never changed.
const handSources: Record<PaintedBodyColor, {
  crop: SpriteCrop; hand: SpriteCrop; marshmallow: SpriteCrop; capBottom: number;
}> = {
  red: {
    crop: { x: 392, y: 104.5, w: 95, h: 95 },
    hand: { x: 395, y: 154, w: 40, h: 40 },
    marshmallow: { x: 446, y: 104, w: 41, h: 42 }, capBottom: 145,
  },
  orange: {
    crop: { x: 389.15, y: 423.5, w: 95, h: 95 },
    hand: { x: 392, y: 473, w: 41, h: 40 },
    marshmallow: { x: 443, y: 423, w: 42, h: 42 }, capBottom: 464,
  },
  yellow: {
    crop: { x: 389.15, y: 737.5, w: 95, h: 95 },
    hand: { x: 392, y: 787, w: 41, h: 40 },
    marshmallow: { x: 443, y: 737, w: 42, h: 42 }, capBottom: 778,
  },
  green: {
    crop: { x: 1017, y: 109.5, w: 95, h: 95 },
    hand: { x: 1020, y: 159, w: 40, h: 40 },
    marshmallow: { x: 1071, y: 109, w: 41, h: 42 }, capBottom: 150,
  },
  blue: {
    crop: { x: 1017, y: 423.5, w: 95, h: 95 },
    hand: { x: 1020, y: 473, w: 40, h: 40 },
    marshmallow: { x: 1071, y: 423, w: 41, h: 42 }, capBottom: 464,
  },
  pink: {
    crop: { x: 1017, y: 737.5, w: 95, h: 95 },
    hand: { x: 1020, y: 787, w: 40, h: 40 },
    marshmallow: { x: 1071, y: 737, w: 41, h: 42 }, capBottom: 778,
  },
};

export function coloredBodyCrop(color: PaintedBodyColor, body: CharacterAppearance['body']): SpriteCrop {
  // Match the original crop dimensions and head/baseline, so hats do not move
  // when a camper changes color. Keep the sheet's antialiased edge pixels.
  const panel = bodyPanel[color];
  return body === 'tall'
    ? { x: 6 + panel.x, y: 6 + panel.y, w: 132, h: 247 }
    : { x: 195 + panel.x, y: 37 + panel.y, w: 133, h: 214 };
}

export const HAND_VIEWPORT: SpriteViewport = { x: 94, y: 119, width: 57, height: 57 };
export const BURNT_HAND_CROP: SpriteCrop = { x: 416, y: 443, w: 133, h: 132 };
// Only the original burnt cap and its connector, never its white hand.
export const BURNT_CAP_REGION: SpriteCrop = { x: 479, y: 443, w: 70, h: 70 };

/** Project a source-atlas rectangle through the same transform as its image. */
export function atlasRegionViewport(atlas: { width: number; height: number }, crop: SpriteCrop,
  viewport: SpriteViewport, region: SpriteCrop): SpriteViewport {
  const image = fitAtlasImage(atlas.width, atlas.height, crop, viewport);
  const scale = image.width / atlas.width;
  return { x: image.x + region.x * scale, y: image.y + region.y * scale,
    width: region.w * scale, height: region.h * scale };
}

export function coloredHandArt(color: PaintedBodyColor) {
  const { crop, hand, marshmallow, capBottom } = handSources[color];
  // Right-column crops extend one transparent pixel beyond the image. Retain
  // the hand and stick below the last fresh-cap antialias row; the existing
  // burnt cap and connector continue to occupy their original flame anchor.
  const stickBelowCap = { x: crop.x, y: capBottom, w: crop.w, h: crop.y + crop.h - capBottom };
  return {
    crop,
    hand: atlasRegionViewport(COLORED_CAMPER_ATLAS, crop, HAND_VIEWPORT, hand),
    marshmallow: atlasRegionViewport(COLORED_CAMPER_ATLAS, crop, HAND_VIEWPORT, marshmallow),
    stickBelowCap: atlasRegionViewport(COLORED_CAMPER_ATLAS, crop, HAND_VIEWPORT, stickBelowCap),
  };
}
