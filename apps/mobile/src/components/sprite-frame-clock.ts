import { sampleSpriteFrame, spriteFrameDuration } from '@/domain/fire-motion';

type FrameListener = (frame: number) => void;
type SpriteClock = {
  started: number;
  frame: number;
  listeners: Set<FrameListener>;
  timer: ReturnType<typeof setInterval>;
};

// Only visible/foreground animations subscribe. Six burnt campers share one
// 380ms timer, while the main fire retains its separate 300ms cadence. Unlike
// a permanent animation loop, the last unsubscribe removes the timer and clock.
const clocks = new Map<number, SpriteClock>();

export function subscribeSpriteFrames(frameMs: number, listener: FrameListener): () => void {
  const duration = spriteFrameDuration(frameMs);
  let clock = clocks.get(duration);
  if (!clock) {
    const started = Date.now();
    const listeners = new Set<FrameListener>();
    const next: SpriteClock = {
      started,
      frame: 0,
      listeners,
      timer: setInterval(() => {
        const frame = sampleSpriteFrame(Date.now() - started, duration);
        if (frame === next.frame) return;
        next.frame = frame;
        for (const notify of listeners) notify(frame);
      }, duration),
    };
    clock = next;
    clocks.set(duration, clock);
  }
  // Register a unique subscription even if callers reuse the same callback.
  const notify: FrameListener = frame => listener(frame);
  clock.listeners.add(notify);
  listener(clock.frame);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    clock.listeners.delete(notify);
    if (clock.listeners.size === 0) {
      clearInterval(clock.timer);
      if (clocks.get(duration) === clock) clocks.delete(duration);
    }
  };
}
