import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Animated, AppState, Easing, StyleSheet, View } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';

import { useAppColors } from '@/constants/theme';
import { MAIN_TAB_NAMES } from '@/domain/swipe-tabs';

export type TabPosition = Animated.AnimatedInterpolation<number>;
const TabLightContext = createContext<{ position: TabPosition | null; warmth: Animated.Value | number }>({
  position: null, warmth: 1,
});

/** An almost imperceptible ember shimmer, shared by the orange icons. */
export function TabLightProvider({ position, enabled, reduceMotion, children }: {
  position: TabPosition | null; enabled: boolean; reduceMotion: boolean; children: ReactNode;
}) {
  const [warmth] = useState(() => new Animated.Value(1));
  const [foreground, setForeground] = useState(!AppState.currentState || AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    warmth.setValue(1);
    if (!enabled || reduceMotion || !foreground) return;
    const flicker = Animated.loop(Animated.sequence([
      { toValue: 0.985, duration: 2600 },
      { toValue: 1, duration: 3200 },
    ].map(step => Animated.timing(warmth, {
      ...step, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false,
    }))), {
      // Both ends meet at 1 with zero easing velocity. Continue smoothly
      // without explicitly resetting the animated value between cycles.
      resetBeforeIteration: false,
    });
    flicker.start();
    return () => flicker.stop();
  }, [enabled, foreground, reduceMotion, warmth]);
  return <TabLightContext.Provider value={{ position, warmth }}>{children}</TabLightContext.Provider>;
}

function useTabLight(routeName: string, focused: boolean) {
  const { position, warmth } = useContext(TabLightContext);
  const index = MAIN_TAB_NAMES.findIndex(name => name === routeName);
  return useMemo(() => {
    // The navigator renders active and inactive icon copies. Both must follow
    // the same pager node rather than their discrete `focused` callback value.
    const active = position && index >= 0 ? position.interpolate({
      inputRange: [index - 1, index, index + 1], outputRange: [0, 1, 0], extrapolate: 'clamp',
    }) : Number(focused);
    // The halo exists only between pages. At either settled endpoint, restore
    // the normal selection pill automatically, including cancelled swipes.
    const travelling = typeof active === 'number' ? 0 : active.interpolate({
      inputRange: [0, 0.5, 1], outputRange: [0, 0.65, 0], extrapolate: 'clamp',
    });
    return {
      active,
      inactive: typeof active === 'number' ? 1 - active : Animated.subtract(1, active),
      glow: Animated.multiply(Animated.multiply(active, travelling), warmth),
      flicker: warmth,
    };
  }, [focused, index, position, warmth]);
}

export function TabLightIcon({ routeName, focused, name, activeName = name, size, style }: {
  routeName: string; focused: boolean; name: SymbolViewProps['name']; activeName?: SymbolViewProps['name'];
  size: number; style?: SymbolViewProps['style'];
}) {
  const c = useAppColors();
  const light = useTabLight(routeName, focused);
  const id = useId().replace(/:/g, '');
  return <View style={styles.icon} pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants">
    <Animated.View testID={`tab-light-${routeName}-highlight`}
      style={[styles.highlight, { backgroundColor: c.emberWash, opacity: light.active }]} />
    <Animated.View testID={`tab-light-${routeName}-glow`} style={[styles.glow, { opacity: light.glow }]}>
      <Svg width={72} height={48} viewBox="0 0 72 48">
        <Defs><RadialGradient id={`${id}-ember`} cx="50%" cy="55%" rx="50%" ry="50%">
          <Stop offset="0" stopColor={c.ember} stopOpacity={0.3} />
          <Stop offset="0.4" stopColor={c.emberLow} stopOpacity={0.16} />
          <Stop offset="1" stopColor={c.emberLow} stopOpacity={0} />
        </RadialGradient></Defs>
        <Rect width="72" height="48" fill={`url(#${id}-ember)`} />
      </Svg>
    </Animated.View>
    <Animated.View testID={`tab-light-${routeName}-inactive`} style={[styles.iconLayer, { opacity: light.inactive }]}>
      <SymbolView name={name} size={size} tintColor={c.ink} style={style} />
    </Animated.View>
    <Animated.View testID={`tab-light-${routeName}-active`} style={[styles.iconLayer, { opacity: light.active }]}>
      <Animated.View testID={`tab-light-${routeName}-flicker`} style={{ opacity: light.flicker }}>
        <SymbolView name={activeName} size={size} tintColor={c.ember} style={style} />
      </Animated.View>
    </Animated.View>
  </View>;
}

export function TabLightLabel({ routeName, focused, children }: {
  routeName: string; focused: boolean; children: (color: string) => ReactNode;
}) {
  const c = useAppColors();
  const light = useTabLight(routeName, focused);
  return <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants">
    <Animated.View testID={`tab-light-${routeName}-label-inactive`} style={{ opacity: light.inactive }}>{children(c.inkSoft)}</Animated.View>
    <Animated.View testID={`tab-light-${routeName}-label-active`} style={[StyleSheet.absoluteFill, { opacity: light.active }]}>{children(c.ember)}</Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  icon: { width: 44, height: 26, alignItems: 'center', justifyContent: 'center' },
  highlight: { ...StyleSheet.absoluteFill, borderRadius: 13 },
  iconLayer: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  glow: { position: 'absolute', width: 72, height: 48, left: -14, top: -11 },
});
