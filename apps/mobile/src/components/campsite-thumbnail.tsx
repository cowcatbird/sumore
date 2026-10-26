import { memo, useId } from 'react';
import { Image, type ImageSourcePropType, StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';

/** Static night lighting over the original crop, never over labels or prices. */
export const CampsiteThumbnail = memo(function CampsiteThumbnail({ source, sourceWidth = 1080 }: { source: ImageSourcePropType; sourceWidth?: number }) {
  const uid = `campsite-thumb-${useId().replace(/:/g, '')}`;
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.frame}>
    {/* Preserve source pixels while clipping any transparent export padding. */}
    <Image source={source} resizeMode="cover" style={[styles.art, { width: `${sourceWidth / 1080 * 100}%` }]} />
    <Svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
      <Defs>
        <LinearGradient id={`${uid}-distance`} x1="0%" y1="0%" x2="0%" y2="100%">
          <Stop offset="0" stopColor="#020710" stopOpacity={0.4} />
          <Stop offset="0.45" stopColor="#020710" stopOpacity={0.55} />
          <Stop offset="1" stopColor="#020710" stopOpacity={0.23} />
        </LinearGradient>
        <RadialGradient id={`${uid}-night`} cx="50%" cy="70%" r="75%">
          <Stop offset="0" stopColor="#020A13" stopOpacity={0.04} />
          <Stop offset="0.5" stopColor="#020A13" stopOpacity={0.2} />
          <Stop offset="1" stopColor="#01060D" stopOpacity={0.62} />
        </RadialGradient>
      </Defs>
      <Rect width={100} height={100} fill={`url(#${uid}-distance)`} />
      <Rect width={100} height={100} fill={`url(#${uid}-night)`} />
    </Svg>
  </View>;
});

const styles = StyleSheet.create({
  frame: { width: '100%', height: 132, overflow: 'hidden', backgroundColor: '#07111A' },
  art: { width: '100%', height: '100%' },
});
