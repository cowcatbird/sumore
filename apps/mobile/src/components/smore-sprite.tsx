import { memo, useId } from 'react';
import { Platform, View } from 'react-native';
import Svg, { Defs, Image, LinearGradient, Mask, Rect, Stop } from 'react-native-svg';

const SMORE_REWARD = require('../../assets/campsite/smore-reward.png');
const nativeAlphaMask = Platform.OS === 'ios' || Platform.OS === 'android'
  ? { maskType: 'alpha' as const } : {};

/** The earned reward, separate from the fresh/burning marshmallow on a stick. */
export const SMoreSprite = memo(function SMoreSprite({ size = 48, decorative = false }: { size?: number; decorative?: boolean }) {
  const uid = `smore-${useId().replace(/:/g, '')}`;
  return (
    <View
      style={{ width: size, height: size, flexShrink: 0 }}
      accessible={!decorative}
      accessibilityRole={decorative ? undefined : 'image'}
      accessibilityLabel={decorative ? undefined : 'S’more reward'}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? 'no-hide-descendants' : 'auto'}>
      <Svg width={size} height={size} viewBox="0 0 491 340" style={{ pointerEvents: 'none' }}>
        <Defs>
          {/* Use the original image's alpha so the tint never paints its transparent margins. */}
          <Mask id={`${uid}-shape`} x={0} y={0} width={491} height={340}
            maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" {...nativeAlphaMask} style={{ maskType: 'alpha' }}>
            <Image href={SMORE_REWARD} width={491} height={340} />
          </Mask>
          <LinearGradient id={`${uid}-shade`} x1="5%" y1="95%" x2="90%" y2="10%">
            <Stop offset="0" stopColor="#071320" stopOpacity={0.3} />
            <Stop offset="0.48" stopColor="#382018" stopOpacity={0.1} />
            <Stop offset="0.78" stopColor="#FFE1AB" stopOpacity={0.03} />
            <Stop offset="1" stopColor="#FFE1AB" stopOpacity={0.14} />
          </LinearGradient>
        </Defs>
        <Image href={SMORE_REWARD} width={491} height={340} />
        <Rect width={491} height={340} fill={`url(#${uid}-shade)`} mask={`url(#${uid}-shape)`} />
      </Svg>
    </View>
  );
});
