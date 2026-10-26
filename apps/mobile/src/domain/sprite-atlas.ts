export type SpriteCrop = { x: number; y: number; w: number; h: number };
export type SpriteViewport = { x: number; y: number; width: number; height: number };

/** The equivalent of an SVG xMidYMid/meet viewport, using a flat Image.
 * Nested Svg x/y props are not implemented by react-native-svg on iOS.
 * A caller clips this image to `viewport`, keeping the atlas pixels intact.
 */
export function fitAtlasImage(
  atlasWidth: number,
  atlasHeight: number,
  crop: SpriteCrop,
  viewport: SpriteViewport,
): SpriteViewport {
  const scale = Math.min(viewport.width / crop.w, viewport.height / crop.h);
  return {
    x: viewport.x + (viewport.width - crop.w * scale) / 2 - crop.x * scale,
    y: viewport.y + (viewport.height - crop.h * scale) / 2 - crop.y * scale,
    width: atlasWidth * scale,
    height: atlasHeight * scale,
  };
}

export const MARSHMALLOW_FLAME_CROP: SpriteCrop = { x: 211, y: 125, w: 605, h: 760 };
const FLAME_VIEWPORT: SpriteViewport = { x: 128, y: 99, width: 27, height: 34 };
export const CHARACTER_MIRROR_X = 151;

/** Keep the independently animated flame attached to its static stick. */
export function marshmallowFlameViewport(facing: 'left' | 'right'): SpriteViewport {
  return {
    ...FLAME_VIEWPORT,
    x: facing === 'left'
      ? CHARACTER_MIRROR_X - FLAME_VIEWPORT.x - FLAME_VIEWPORT.width
      : FLAME_VIEWPORT.x,
  };
}

export const MARSHMALLOW_EFFECT_PADDING = 20;

/** Room for firelight beyond the flame, without moving its stick attachment. */
export function marshmallowEffectViewport(facing: 'left' | 'right'): SpriteViewport {
  const flame = marshmallowFlameViewport(facing);
  return {
    x: flame.x - MARSHMALLOW_EFFECT_PADDING,
    y: flame.y - MARSHMALLOW_EFFECT_PADDING,
    width: flame.width + MARSHMALLOW_EFFECT_PADDING * 2,
    height: flame.height + MARSHMALLOW_EFFECT_PADDING * 2,
  };
}
