import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { AccessibilityInfo, Animated, AppState, Platform } from 'react-native';

import { subscribeSpriteFrames } from '@/components/sprite-frame-clock';
import {
  FIRE_GLOW_CYCLE_MS, FIRE_GLOW_MAX, FIRE_GLOW_MIN,
  FIRE_GLOW_STILL, sampleGlowProgress,
  spriteFrameDuration,
} from '@/domain/fire-motion';

/** Do not keep drawing a hidden route or fight a user's Reduce Motion setting.
 * This gate only reacts to lifecycle changes, never to animation frames.
 */
export function useVisibleAnimation(enabled: boolean, play: () => () => void) {
  useFocusEffect(useCallback(() => {
    if (!enabled) return;
    let alive = true;
    let reduced = true; // Stay still until the accessibility preference is known.
    let preferenceChanged = false;
    let active = AppState.currentState === 'active';
    let stop: (() => void) | undefined;

    const reconcile = () => {
      if (alive && active && !reduced) {
        if (!stop) stop = play();
      } else if (stop) {
        stop();
        stop = undefined;
      }
    };
    const motionSub = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      preferenceChanged = true;
      reduced = value;
      reconcile();
    });
    const stateSub = AppState.addEventListener('change', value => {
      active = value === 'active';
      reconcile();
    });
    AccessibilityInfo.isReduceMotionEnabled().then(value => {
      // An accessibility event is newer than this initial asynchronous query.
      if (!alive || preferenceChanged) return;
      reduced = value;
      reconcile();
    }).catch(() => { /* If the preference is unavailable, leave the scene still. */ });

    return () => {
      alive = false;
      reconcile();
      motionSub.remove();
      stateSub.remove();
    };
  }, [enabled, play]));
}

/** Use only inside a small fire component: its parent scene never gets a tick. */
export function useSpriteFrame(frameMs: number, enabled = true): number {
  const [frame, setFrame] = useState(0);
  const duration = spriteFrameDuration(frameMs);
  const play = useCallback(() => {
    const unsubscribe = subscribeSpriteFrames(duration, setFrame);
    return () => {
      unsubscribe();
      setFrame(0);
    };
  }, [duration]);
  useVisibleAnimation(enabled, play);
  return frame;
}

/** Animate an Animated.View's opacity, not SVG gradient props. On phones the
 * whole loop runs on the native driver, with no React renders or JS frame ticks.
 */
export function useFireGlow(enabled = true): Animated.Value {
  const [glow] = useState(() => new Animated.Value(FIRE_GLOW_STILL));
  const play = useCallback(() => {
    glow.setValue(FIRE_GLOW_MIN);
    const loop = Animated.loop(Animated.timing(glow, {
      toValue: FIRE_GLOW_MAX,
      duration: FIRE_GLOW_CYCLE_MS,
      easing: sampleGlowProgress,
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false,
    }));
    loop.start();
    return () => {
      loop.stop();
      glow.setValue(FIRE_GLOW_STILL);
    };
  }, [glow]);
  useVisibleAnimation(enabled, play);
  return glow;
}
