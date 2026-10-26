/** The water-only band in the original 1080px beach painting. Wavelets leave
 * generous margins around the palm, horizon and curved sandy shoreline. */
export const BEACH_WATER = { x: 0, y: 762, width: 1080, height: 164 } as const;

export type WaterRipple = { x: number; y: number; width: number; bend: number; weight: number };
export const WATER_DRIFT_X = 9;
export const WATER_DRIFT_Y = 5;

export const WATER_LAYERS: readonly { duration: number; ripples: readonly WaterRipple[] }[] = [
  { duration: 9200, ripples: [
    { x: 451, y: 12, width: 103, bend: 1.8, weight: 1.3 },
    { x: 543, y: 30, width: 132, bend: 2.3, weight: 1.8 },
    { x: 410, y: 55, width: 149, bend: 3, weight: 2 },
    { x: 544, y: 84, width: 176, bend: 3, weight: 2.3 },
    { x: 381, y: 120, width: 197, bend: 4, weight: 2.5 },
    { x: 769, y: 65, width: 128, bend: 2.5, weight: 1.5 },
    { x: 890, y: 134, width: 144, bend: 3.4, weight: 1.8 },
    { x: 21, y: 100, width: 89, bend: 2.5, weight: 1.6 },
  ] },
  { duration: 12600, ripples: [
    { x: 536, y: 18, width: 88, bend: 1.8, weight: 1.4 },
    { x: 437, y: 41, width: 121, bend: 2.2, weight: 1.7 },
    { x: 532, y: 65, width: 151, bend: 3, weight: 2.1 },
    { x: 396, y: 97, width: 158, bend: 3.2, weight: 2.2 },
    { x: 558, y: 137, width: 160, bend: 3.4, weight: 2.6 },
    { x: 831, y: 33, width: 155, bend: 2, weight: 1.3 },
    { x: 765, y: 106, width: 184, bend: 3, weight: 1.9 },
    { x: 32, y: 146, width: 85, bend: 3, weight: 1.8 },
  ] },
];

export function waterRipplePath({ x, y, width, bend }: WaterRipple) {
  return `M ${x} ${y} C ${x + width * 0.25} ${y - bend}, ${x + width * 0.42} ${y + bend}, ${x + width * 0.62} ${y} S ${x + width * 0.86} ${y - bend}, ${x + width} ${y}`;
}
