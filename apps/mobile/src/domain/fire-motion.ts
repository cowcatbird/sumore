/** Deliberate, slow sprite playback. This is frame cycling, not rotation. */
export const BIG_FIRE_FRAME_MS = 300;
export const SMALL_FIRE_FRAME_MS = 380;
export const FIRE_GLOW_MIN = 0.82;
export const FIRE_GLOW_MAX = 1;
export const FIRE_GLOW_STILL = 0.9;
export const FIRE_GLOW_CYCLE_MS = 4600;

/** Invalid timing values must never create a zero-delay animation timer. */
export function spriteFrameDuration(frameMs: number) {
  return Number.isFinite(frameMs) && frameMs >= 1 ? frameMs : BIG_FIRE_FRAME_MS;
}

export function sampleSpriteFrame(elapsed: number, frameMs: number) {
  const t = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  return Math.floor(t / spriteFrameDuration(frameMs)) % 3;
}

/** A seamless, gently irregular wave, sampled once into native animation frames.
 * The endpoints match so a native loop does not flash when it restarts.
 */
export function sampleGlowProgress(progress: number) {
  const t = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  return Math.max(0, Math.min(1,
    0.5 - 0.34 * Math.cos(t * Math.PI * 2) - 0.16 * Math.cos(t * Math.PI * 6),
  ));
}
