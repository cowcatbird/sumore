import { memo, useCallback, useId, useMemo, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { useVisibleAnimation } from '@/components/use-fire-motion';
import { BEACH_WATER, WATER_DRIFT_X, WATER_DRIFT_Y, WATER_LAYERS, waterRipplePath } from '@/domain/beach-water';
import { CAMPSITE, sceneRect } from '@/domain/campsite-layout';

/** Two tiny, static SVG strips drift as native views. No per-frame React state,
 * full-scene redraw, moving bitmap, or animated native SVG gradient/mask. */
export const BeachWater = memo(function BeachWater({ width, enabled }: { width: number; enabled: boolean }) {
  const { x, y, width: artWidth, height } = BEACH_WATER;
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={[styles.water, sceneRect(width, x, y, artWidth, height)]}>
    {WATER_LAYERS.map((_, index) => <RippleLayer key={index} index={index} unit={width / CAMPSITE.width} enabled={enabled} />)}
  </View>;
});

function RippleLayer({ index, unit, enabled }: { index: number; unit: number; enabled: boolean }) {
  const [phase] = useState(() => new Animated.Value(0));
  const play = useCallback(() => {
    phase.setValue(0);
    const loop = Animated.loop(Animated.timing(phase, {
      toValue: 1,
      duration: WATER_LAYERS[index].duration,
      easing: Easing.linear,
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false,
    }));
    loop.start();
    return () => { loop.stop(); phase.setValue(0); };
  }, [index, phase]);
  useVisibleAnimation(enabled, play);
  const motion = useMemo(() => {
    const direction = index === 0 ? 1 : -1;
    return {
      opacity: phase.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [0.25, 0.65, 0.42, 0.15, 0.25] }),
      transform: [
        { translateX: phase.interpolate({ inputRange: [0, 0.25, 0.5, 0.75, 1], outputRange: [0, WATER_DRIFT_X * unit * direction, 0, -WATER_DRIFT_X * unit * direction, 0] }) },
        { translateY: phase.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, WATER_DRIFT_Y * unit, 0] }) },
      ],
    };
  }, [index, phase, unit]);
  return <Animated.View style={[StyleSheet.absoluteFill, motion]}><RippleDrawing index={index} /></Animated.View>;
}

const RippleDrawing = memo(function RippleDrawing({ index }: { index: number }) {
  const gradient = `beach-water-${useId().replace(/:/g, '')}`;
  return <Svg width="100%" height="100%" viewBox={`0 0 ${BEACH_WATER.width} ${BEACH_WATER.height}`}>
    <Defs>
      <LinearGradient id={gradient} x1="0%" y1="0%" x2="100%" y2="0%">
        <Stop offset="0" stopColor="#9FC7DE" stopOpacity={0} />
        <Stop offset="0.3" stopColor="#9FC7DE" stopOpacity={0.35} />
        <Stop offset="0.6" stopColor="#D0E0E6" stopOpacity={0.5} />
        <Stop offset="1" stopColor="#9FC7DE" stopOpacity={0} />
      </LinearGradient>
    </Defs>
    {WATER_LAYERS[index].ripples.map((ripple, i) => <Path key={i} d={waterRipplePath(ripple)}
      fill="none" stroke={`url(#${gradient})`} strokeWidth={ripple.weight} strokeLinecap="round" />)}
  </Svg>;
});

const styles = StyleSheet.create({
  water: { position: 'absolute', overflow: 'hidden' },
});
