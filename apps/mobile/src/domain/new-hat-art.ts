import type { SpriteCrop } from './sprite-atlas';

/** Original 1000 × 500 transparent hats-extra.png, kept byte-for-byte intact.
 * referenceHead records the white guide in the user's earlier gray sheet.
 * Its full exposed headband guide measures 158 × 152 at (546, 75); the
 * other seven guides are exact 250-pixel grid translations of that shape.
 * Anchoring to those guides preserves asymmetric brims and propeller blades
 * instead of incorrectly centering the entire accessory over the camper.
 */
export const NEW_HAT_ART = {
  beanie: {
    crop: { x: 24, y: 25, w: 194, h: 124 },
    referenceHead: { x: 46, y: 75, w: 158, h: 152 },
  },
  bucket: {
    crop: { x: 265, y: 37, w: 219, h: 107 },
    referenceHead: { x: 296, y: 75, w: 158, h: 152 },
  },
  headband: {
    crop: { x: 542, y: 98, w: 166, h: 45 },
    referenceHead: { x: 546, y: 75, w: 158, h: 152 },
  },
  propeller: {
    crop: { x: 787, y: 34, w: 202, h: 136 },
    referenceHead: { x: 796, y: 75, w: 158, h: 152 },
  },
  wizard: {
    crop: { x: 15, y: 260, w: 219, h: 126 },
    referenceHead: { x: 46, y: 325, w: 158, h: 152 },
  },
  pirate: {
    crop: { x: 241, y: 284, w: 274, h: 118 },
    referenceHead: { x: 296, y: 325, w: 158, h: 152 },
  },
  clown: {
    crop: { x: 535, y: 297, w: 185, h: 154 },
    referenceHead: { x: 546, y: 325, w: 158, h: 152 },
  },
  viking: {
    crop: { x: 775, y: 279, w: 198, h: 122 },
    referenceHead: { x: 796, y: 325, w: 158, h: 152 },
  },
} as const satisfies Record<string, { crop: SpriteCrop; referenceHead: SpriteCrop }>;

export type NewHatId = keyof typeof NEW_HAT_ART;
