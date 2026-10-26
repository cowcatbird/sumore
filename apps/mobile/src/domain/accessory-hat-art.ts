import type { SpriteCrop } from './sprite-atlas';

/** The user's unmodified 794 × 317 transparent accessory sheet.
 * These head bounds come from the matching gray reference, including its
 * unobstructed second-row guides. Mouth/cheek accessories retain their offset
 * from the head rather than being centered like a conventional hat.
 */
export const ACCESSORY_HAT_ART = {
  'cat-ears': {
    crop: { x: 20, y: 17, w: 121, h: 90 },
    referenceHead: { x: 29, y: 47, w: 101, h: 97 },
  },
  sunflower: {
    crop: { x: 170, y: 29, w: 72, h: 73 },
    referenceHead: { x: 188, y: 47, w: 101, h: 97 },
  },
  lollipop: {
    crop: { x: 414, y: 104, w: 55, h: 49 },
    referenceHead: { x: 346, y: 47, w: 102, h: 97 },
  },
  'bubble-gum': {
    crop: { x: 565, y: 92, w: 61, h: 60 },
    referenceHead: { x: 505, y: 47, w: 101, h: 97 },
  },
  'googly-eyes': {
    crop: { x: 683, y: 75, w: 74, h: 33 },
    referenceHead: { x: 664, y: 47, w: 101, h: 97 },
  },
  'disguise-glasses': {
    crop: { x: 18, y: 223, w: 125, h: 84 },
    referenceHead: { x: 29, y: 206, w: 101, h: 97 },
  },
} as const satisfies Record<string, { crop: SpriteCrop; referenceHead: SpriteCrop }>;
