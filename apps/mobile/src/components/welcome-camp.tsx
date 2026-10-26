import { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, Path, RadialGradient, Stop } from 'react-native-svg';

import { CharacterSprite } from '@/components/character-sprite';
import { FIRE_ANCHORS, FIRE_ART_HEIGHT, FIRE_FRAMES } from '@/components/fire-frames';
import { useAppColors } from '@/constants/theme';

/** A quiet first impression using the same artwork as the real campsite.
 * Static by design: no startup timers, animation or reduced-motion exception. */
export function WelcomeCamp() {
  const c = useAppColors();
  const glowId = `welcome-glow-${useId().replace(/:/g, '')}`;
  const anchor = FIRE_ANCHORS[0];
  return <View pointerEvents="none" accessible={false} accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants" style={styles.scene}>
    <Svg width="100%" height="100%" viewBox="0 0 320 176" style={StyleSheet.absoluteFill}>
      <Defs><RadialGradient id={glowId}>
        <Stop offset="0" stopColor={c.ember} stopOpacity={0.19} />
        <Stop offset="1" stopColor={c.ember} stopOpacity={0} />
      </RadialGradient></Defs>
      <Ellipse cx={160} cy={117} rx={154} ry={84} fill={`url(#${glowId})`} />
      <Ellipse cx={160} cy={156} rx={102} ry={13} fill={c.ink} opacity={0.04} />
      {[[40, 32], [99, 17], [252, 27], [281, 72]].map(([x, y]) =>
        <Circle key={`${x}-${y}`} cx={x} cy={y} r={1.5} fill={c.inkSoft} opacity={0.45} />)}
    </Svg>
    <View style={styles.cow}><CharacterSprite appearance={{ body: 'tall', color: 'blue', hat: 'cow' }} size={82} animated={false} /></View>
    <View style={styles.bird}><CharacterSprite appearance={{ body: 'short', color: 'orange', hat: 'duck' }} size={86} animated={false} /></View>
    <View style={styles.cat}><CharacterSprite appearance={{ body: 'short', color: 'pink', hat: 'cat' }} facing="left" size={86} animated={false} /></View>
    <Svg width="100%" height="100%" viewBox="0 0 320 176" style={StyleSheet.absoluteFill}>
      <G transform={`translate(160 166) scale(${84 / FIRE_ART_HEIGHT})`}>
        <G transform={`translate(${-anchor.anchorX} ${-anchor.anchorY})`}>
          {FIRE_FRAMES[0].map((path, index) => <Path key={index} {...path} />)}
        </G>
      </G>
    </Svg>
  </View>;
}

const styles = StyleSheet.create({
  scene: { width: '100%', maxWidth: 320, height: 176, alignSelf: 'center' },
  cow: { position: 'absolute', top: 0, left: '50%', marginLeft: -41 },
  bird: { position: 'absolute', top: 44, left: '8%' },
  cat: { position: 'absolute', top: 44, right: '8%' },
});
