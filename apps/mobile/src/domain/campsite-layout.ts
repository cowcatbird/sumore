/** One coordinate system for the painting and every native-view layer. */
export const CAMPSITE = { width: 1080, height: 1700, skyCrop: 350 } as const;
export const CAMPFIRE_ORIGIN = { x: 540, y: 1270 } as const;
export const CAMPER_SLOTS = [
  { x: 362, y: 1135, scale: 1.5 },
  { x: 709, y: 1144, scale: 1.56 },
  { x: 212, y: 1290, scale: 1.7 },
  { x: 857, y: 1310, scale: 1.74 },
  { x: 387, y: 1446, scale: 1.8 },
  { x: 720, y: 1451, scale: 1.8 },
] as const;

export function campsitePositions(count: number) {
  if (count === 1) return [CAMPER_SLOTS[2]];
  if (count === 2) return [CAMPER_SLOTS[2], CAMPER_SLOTS[3]];
  return CAMPER_SLOTS.slice(0, Math.min(6, Math.max(0, count)));
}

export function sceneRect(width: number, x: number, y: number, w: number, h: number) {
  const unit = Math.max(0, width) / CAMPSITE.width;
  return { left: x * unit, top: (y - CAMPSITE.skyCrop) * unit, width: w * unit, height: h * unit };
}

export function camperRect(width: number, slot: typeof CAMPER_SLOTS[number]) {
  return sceneRect(width, slot.x - 76 * slot.scale, slot.y - 194 * slot.scale, 160 * slot.scale, 220 * slot.scale);
}
