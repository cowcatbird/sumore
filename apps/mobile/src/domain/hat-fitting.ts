import type { CharacterAppearance, HatId } from './character';
import { ACCESSORY_HAT_ART } from './accessory-hat-art';
import { NEW_HAT_ART } from './new-hat-art';
import type { SpriteCrop } from './sprite-atlas';

/** Crop rectangles from the three unmodified source atlases. */
export const HAT_CROPS: Record<Exclude<HatId, 'none'>, SpriteCrop> = {
  cowboy: { x: 271, y: 22, w: 218, h: 128 },
  cow: { x: 516, y: 47, w: 224, h: 183 },
  cat: { x: 780, y: 0, w: 204, h: 250 },
  sunglasses: { x: 36, y: 118, w: 183, h: 73 },
  duck: { x: 76, y: 255, w: 101, h: 114 },
  'top-hat': { x: 265, y: 270, w: 213, h: 121 },
  halo: { x: 551, y: 282, w: 143, h: 76 },
  crown: { x: 775, y: 263, w: 200, h: 148 },
  beanie: NEW_HAT_ART.beanie.crop,
  bucket: NEW_HAT_ART.bucket.crop,
  headband: NEW_HAT_ART.headband.crop,
  propeller: NEW_HAT_ART.propeller.crop,
  wizard: NEW_HAT_ART.wizard.crop,
  pirate: NEW_HAT_ART.pirate.crop,
  clown: NEW_HAT_ART.clown.crop,
  viking: NEW_HAT_ART.viking.crop,
  'cat-ears': ACCESSORY_HAT_ART['cat-ears'].crop,
  sunflower: ACCESSORY_HAT_ART.sunflower.crop,
  lollipop: ACCESSORY_HAT_ART.lollipop.crop,
  'bubble-gum': ACCESSORY_HAT_ART['bubble-gum'].crop,
  'googly-eyes': ACCESSORY_HAT_ART['googly-eyes'].crop,
  'disguise-glasses': ACCESSORY_HAT_ART['disguise-glasses'].crop,
};

/** Original PNG alpha only; guide heads are never included in the artwork. */
export function hatAtlasGeometry(hat: HatId) {
  if (Object.hasOwn(ACCESSORY_HAT_ART, hat)) return { width: 794, height: 317, sheet: 'accessories' as const };
  if (Object.hasOwn(NEW_HAT_ART, hat)) return { width: 1000, height: 500, sheet: 'extra' as const };
  return { width: 1250, height: 500, sheet: 'original' as const };
}

const REFERENCE_HAT_ART = { ...NEW_HAT_ART, ...ACCESSORY_HAT_ART };
/** Both body sprites display a 65-unit-wide head. Match the supplied guide's
 * width, center, and top, keeping the artwork's original asymmetric offset. */
function referenceFitting(hat: keyof typeof REFERENCE_HAT_ART, offsetY = 0) {
  const { crop, referenceHead } = REFERENCE_HAT_ART[hat];
  const scale = 65 / referenceHead.w;
  return {
    width: crop.w * scale,
    bottom: (crop.y + crop.h - referenceHead.y) * scale + offsetY,
    offsetX: (crop.x + crop.w / 2 - referenceHead.x - referenceHead.w / 2) * scale,
  };
}

/** Android SVG clip/mask paths cache native geometry. Remount that small
 * surface when its geometry changes, not on lighting or animation updates.
 */
export function characterGeometryKey(appearance: CharacterAppearance, facing: 'left' | 'right', burnt: boolean) {
  return `${appearance.body}:${appearance.color ?? 'cream'}:${appearance.hat}:${facing}:${burnt ? 'burnt' : 'fresh'}`;
}

/** Per-accessory attachment points measured against the sprite's round head.
 * `bottom` is relative to the top of the head, not the image/transparent page.
 * Hoods cover the head; brims sit on it; a halo intentionally floats above it.
 */
export const HAT_FITTING: Record<Exclude<HatId, 'none'>, { width: number; bottom: number; offsetX: number }> = {
  cowboy: { width: 94, bottom: 24, offsetX: 0 },
  // Center the round hood, not its protruding muzzle. A 3-unit right nudge
  // retains opaque coverage of both original camper heads at this scale.
  cow: { width: 96, bottom: 57, offsetX: 2 },
  cat: { width: 77, bottom: 64, offsetX: 2 },
  sunglasses: { width: 70, bottom: 40, offsetX: 0 },
  duck: { width: 42, bottom: 10, offsetX: 1 },
  'top-hat': { width: 76, bottom: 13, offsetX: 0 },
  halo: { width: 69, bottom: -1, offsetX: 0 },
  crown: { width: 73, bottom: 24, offsetX: 0 },
  beanie: referenceFitting('beanie'),
  bucket: referenceFitting('bucket'),
  headband: referenceFitting('headband'),
  // Lift the brim slightly while preserving the reference's right overhang.
  propeller: referenceFitting('propeller', -4),
  wizard: referenceFitting('wizard'),
  pirate: referenceFitting('pirate'),
  clown: referenceFitting('clown'),
  viking: referenceFitting('viking'),
  'cat-ears': referenceFitting('cat-ears'),
  sunflower: referenceFitting('sunflower'),
  lollipop: referenceFitting('lollipop'),
  'bubble-gum': referenceFitting('bubble-gum'),
  'googly-eyes': referenceFitting('googly-eyes'),
  'disguise-glasses': referenceFitting('disguise-glasses'),
};

export function fitHat(hat: Exclude<HatId, 'none'>, headTop: number, aspectRatio: number) {
  const fitting = HAT_FITTING[hat];
  const height = fitting.width / aspectRatio;
  return { width: fitting.width, height, x: 75.5 + fitting.offsetX - fitting.width / 2, y: headTop + fitting.bottom - height };
}

/** The reference keeps the cat's tilted face and tail orientation even when
 * the camper holds a marshmallow to the left. Other hats retain their fit. */
export function counterMirrorHat(hat: HatId, facing: 'left' | 'right') {
  return hat === 'cat' && facing === 'left';
}
