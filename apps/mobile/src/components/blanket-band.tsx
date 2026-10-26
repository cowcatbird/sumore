import { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { AppColorsDark } from '@/constants/theme';

/** Shared firelight divider, from burnt orange to warm peach. */
export function BlanketBand({ height = 6, inset = false }: { height?: number; inset?: boolean }) {
  const gradientId = `ember-band-${useId().replace(/:/g, '')}`;

  return (
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      pointerEvents="none" style={[styles.band, inset && styles.inset, { height }]}>
      <Svg width="100%" height="100%" viewBox="0 0 100 1" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <Stop offset="0%" stopColor={AppColorsDark.emberLow} />
            <Stop offset="100%" stopColor={AppColorsDark.ember} />
          </LinearGradient>
        </Defs>
        <Rect width={100} height={1} fill={`url(#${gradientId})`} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  band: { alignSelf: 'stretch', width: '100%', overflow: 'hidden', backgroundColor: AppColorsDark.emberLow },
  inset: { borderRadius: 999 },
});
