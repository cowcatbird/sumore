import { memo, useId, useMemo, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, G, Image, LinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { CharacterSprite } from '@/components/character-sprite';
import { BeachWater } from '@/components/beach-water';
import { FIRE_ANCHORS, FIRE_ART_HEIGHT, FIRE_FRAMES } from '@/components/fire-frames';
import { useFireGlow, useSpriteFrame } from '@/components/use-fire-motion';
import { CAMPSITE, CAMPFIRE_ORIGIN, camperRect, campsitePositions, sceneRect } from '@/domain/campsite-layout';
import { defaultAppearance, type CharacterAppearance } from '@/domain/character';
import { BIG_FIRE_FRAME_MS } from '@/domain/fire-motion';
import type { CampfireSeat } from '@/types/domain';

const BACKGROUNDS = {
  forest: require('../../assets/campsite/background.png'),
  beach: require('../../assets/campsite/background-beach.png'),
  snow: require('../../assets/campsite/background-snow.png'),
};
type CampsiteBackground = keyof typeof BACKGROUNDS;
const { width: WIDTH, height: HEIGHT, skyCrop: SKY_CROP } = CAMPSITE;
const FIRE = CAMPFIRE_ORIGIN;
const VIEWBOX = `0 ${SKY_CROP} ${WIDTH} ${HEIGHT - SKY_CROP}`;
const stars = [
  [52, 400, 1.7], [128, 456, 2.5], [201, 367, 1.6], [275, 418, 2],
  [349, 489, 1.5], [432, 378, 2.6], [509, 458, 1.8], [588, 393, 1.5],
  [667, 485, 2.3], [751, 363, 1.8], [823, 435, 2.8], [906, 388, 1.4],
  [1002, 452, 2], [65, 567, 1.8], [172, 530, 1.3], [236, 611, 2.5],
  [306, 551, 1.4], [786, 535, 1.4], [854, 584, 2], [911, 494, 1.7],
  [28, 480, 1.2], [394, 426, 1.2], [558, 514, 1.4], [714, 424, 1.1],
  [961, 347, 1.2], [1046, 393, 1.5], [193, 701, 1.2], [841, 675, 1.3],
];

/** Only the small fire canvas redraws when its sprite frame changes. */
export const BigFire = memo(function BigFire({ frame, x, y, height = 285 }: { frame: number; x: number; y: number; height?: number }) {
  const selected = ((frame % FIRE_FRAMES.length) + FIRE_FRAMES.length) % FIRE_FRAMES.length;
  const anchor = FIRE_ANCHORS[selected];
  return <G transform={`translate(${x} ${y}) scale(${height / FIRE_ART_HEIGHT})`}>
    <G transform={`translate(${-anchor.anchorX} ${-anchor.anchorY})`}>
      {FIRE_FRAMES[selected].map((path, i) => <Path key={i} {...path} />)}
    </G>
  </G>;
});

function AnimatedBigFire({ enabled }: { enabled: boolean }) {
  const frame = useSpriteFrame(BIG_FIRE_FRAME_MS, enabled);
  return <Svg width="100%" height="100%" viewBox="380 950 320 335"><BigFire frame={frame} x={540} y={1270} /></Svg>;
}

/** Native mask buffers use ROOT canvas size. Keep each camper in a tiny root;
 * native-view opacity supplies flicker without redrawing the shaded sprites. */
export function CampsiteScene({ seats, appearance, paused = false, exampleLooks, background = 'forest', onPressYourCamper }: {
  seats: CampfireSeat[]; appearance: CharacterAppearance; paused?: boolean; exampleLooks?: readonly CharacterAppearance[]; background?: CampsiteBackground; onPressYourCamper?: () => void;
}) {
  const [width, setWidth] = useState(0);
  const glow = useFireGlow(!paused);
  const camperOpacity = useMemo(() => glow.interpolate({ inputRange: [0.82, 1], outputRange: [0.93, 1], extrapolate: 'clamp' }), [glow]);
  const positions = campsitePositions(Math.min(seats.length, 6));
  const person = (seat: CampfireSeat, i: number) => {
    const p = positions[i];
    const look = seat.isYou ? appearance : exampleLooks?.[i] ?? seat.character?.appearance ?? defaultAppearance;
    const distance = Math.hypot(p.x - FIRE.x, (p.y - FIRE.y) * 1.4);
    const rect = camperRect(width, p);
    return <View key={seat.id} pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={[styles.layer, rect, { opacity: camperOpacity }]}>
        <CharacterSprite appearance={look} burnt={seat.askedToday} lighting={0.8 / (1 + distance / 750)}
          facing={p.x > FIRE.x ? 'left' : 'right'} size={rect.width} animated={!paused} />
      </Animated.View>
      <View style={[styles.nameTag, sceneRect(width, p.x - 84, p.y + 15, 168, 44)]}>
        <Text numberOfLines={1} style={[styles.name, { fontSize: 26 * width / WIDTH, color: seat.isYou ? '#FFE0AC' : '#D5DFDA' }]}>
          {seat.isYou ? 'you' : seat.displayName.split(/\s+/)[0].slice(0, 12)}
        </Text>
      </View>
      {seat.askedToday && <Text numberOfLines={1} style={[styles.freshTomorrow, sceneRect(width, p.x - 120, p.y + 60, 240, 36), { fontSize: 22 * width / WIDTH }]}>fresh tomorrow</Text>}
    </View>;
  };
  return <View style={styles.scene} onLayout={event => { const next = event.nativeEvent.layout.width; setWidth(previous => previous === next ? previous : next); }}
    accessible={!onPressYourCamper} accessibilityLabel={`Moonlit ${background} campsite, ${seats.length} ${seats.length === 1 ? 'camper' : 'campers'}, flickering firelight`}>
    <View pointerEvents="none" style={StyleSheet.absoluteFill}><CampsiteBackdrop background={background} /></View>
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: glow }]}><StarField background={background} /></Animated.View>
    {width > 0 && <>
      {background === 'beach' && <BeachWater width={width} enabled={!paused} />}
      <Animated.View pointerEvents="none" style={[styles.layer, sceneRect(width, 0, 850, 1080, 850), { opacity: glow }]}><GroundLight /></Animated.View>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}><GroundShadows count={seats.length} /></View>
      {seats.slice(0, 6).map((seat, i) => positions[i].y < FIRE.y ? person(seat, i) : null)}
      <View pointerEvents="none" style={[styles.layer, sceneRect(width, 380, 950, 320, 335)]}><AnimatedBigFire enabled={!paused} /></View>
      {seats.slice(0, 6).map((seat, i) => positions[i].y >= FIRE.y ? person(seat, i) : null)}
      {onPressYourCamper && seats.slice(0, 6).map((seat, i) => seat.isYou ? (
        <Pressable key={`edit-${seat.id}`} accessibilityRole="button" accessibilityLabel="Edit your camper at the campfire"
          accessibilityHint="Opens hats, colors and campsites" onPress={onPressYourCamper}
          hitSlop={8} style={[styles.layer, camperRect(width, positions[i]), { minWidth: 44, minHeight: 44 }]} />
      ) : null)}
    </>}
  </View>;
}

const CampsiteBackdrop = memo(function CampsiteBackdrop({ background }: { background: CampsiteBackground }) {
  const uid = useId().replace(/:/g, '');
  const beach = background === 'beach';
  return <Svg width="100%" height="100%" viewBox={VIEWBOX}>
    <Defs>
      <LinearGradient id={`${uid}-sky`} x1={0} y1={350} x2={0} y2={560} gradientUnits="userSpaceOnUse">
        <Stop offset="0" stopColor="#03080E" /><Stop offset="1" stopColor="#03080E" stopOpacity={0} />
      </LinearGradient>
      <LinearGradient id={`${uid}-distance`} x1={0} y1={350} x2={0} y2={beach ? 1350 : 1450} gradientUnits="userSpaceOnUse">
        <Stop offset="0" stopColor="#020710" stopOpacity={beach ? 0.38 : 0.3} /><Stop offset="0.38" stopColor="#020710" stopOpacity={beach ? 0.6 : 0.55} />
        <Stop offset="0.7" stopColor="#020710" stopOpacity={beach ? 0.45 : 0.33} /><Stop offset="1" stopColor="#020710" stopOpacity={beach ? 0.32 : 0.14} />
      </LinearGradient>
      <RadialGradient id={`${uid}-night`} cx="50%" cy="66%" r="65%">
        <Stop offset="0" stopColor="#020A13" stopOpacity={0.08} /><Stop offset="0.55" stopColor="#020A13" stopOpacity={0.26} />
        <Stop offset="1" stopColor="#01060D" stopOpacity={beach ? 0.83 : 0.79} />
      </RadialGradient>
    </Defs>
    {/* The snow export has 59 transparent pixels past the 1080px artwork.
        Keep its source scale; the scene viewport clips that empty right edge. */}
    <Image href={BACKGROUNDS[background]} width={background === 'snow' ? 1139 : 1080} height={1920} />
    {background === 'forest' && <Path d="M 660 607 L 671.5 620 L 679.5 630 L 686.5 640 L 693.5 650 L 700.5 660 L 707.5 670 L 713.5 680 L 719.5 690 L 725.5 700 L 730 707"
      fill="none" stroke="#A2A2AD" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
    <Rect width={WIDTH} height={HEIGHT} fill={`url(#${uid}-distance)`} />
    <Rect width={WIDTH} height={HEIGHT} fill={`url(#${uid}-night)`} />
    <Rect y={350} width={WIDTH} height={210} fill={`url(#${uid}-sky)`} />
  </Svg>;
});

const StarField = memo(function StarField({ background }: { background: CampsiteBackground }) {
  // Snow already contains its stars. The beach moon and palm sit higher than
  // the mountain tree line, so its added stars stay above that artwork.
  const skyStars = background === 'snow' ? []
    : background === 'beach' ? stars.map(([x, y, radius]) => [x, 350 + (y - 350) * 0.55, radius]) : stars;
  return <Svg width="100%" height="100%" viewBox={VIEWBOX}>
    {skyStars.map(([x, y, radius], i) => <G key={i} opacity={0.35 + (1 + Math.sin(i * 1.73)) * 0.17}>
      {radius > 2.4 && <>
        <Circle cx={x} cy={y} r={radius * 3} fill="#BCCEEB" opacity={0.07} />
        <Path d={`M ${x - 6} ${y} H ${x + 6} M ${x} ${y - 6} V ${y + 6}`} stroke="#DCE7FC" strokeWidth={0.7} opacity={0.45} />
      </>}
      <Circle cx={x} cy={y} r={radius} fill={i % 3 ? '#CADBF5' : '#FFE8C1'} />
    </G>)}
    <G opacity={0.36}>
      <Circle cx={511} cy={966} r={3.2} fill="#FFE19A" /><Circle cx={584} cy={943} r={2.6} fill="#FFAE57" />
      <Circle cx={542} cy={917} r={2} fill="#FFD484" />
    </G>
  </Svg>;
});

const GroundLight = memo(function GroundLight() {
  const uid = useId().replace(/:/g, '');
  return <Svg width="100%" height="100%" viewBox="0 850 1080 850">
    <Defs>
      <RadialGradient id={`${uid}-warm`}>
        <Stop offset="0" stopColor="#FFCF7A" stopOpacity={0.43} /><Stop offset="0.27" stopColor="#FFAD44" stopOpacity={0.32} />
        <Stop offset="0.63" stopColor="#CB601E" stopOpacity={0.15} /><Stop offset="1" stopColor="#BA4F16" stopOpacity={0} />
      </RadialGradient>
      <RadialGradient id={`${uid}-ember`}>
        <Stop offset="0" stopColor="#FFB74E" stopOpacity={0.6} /><Stop offset="0.5" stopColor="#FF7A20" stopOpacity={0.16} />
        <Stop offset="1" stopColor="#FF7A20" stopOpacity={0} />
      </RadialGradient>
    </Defs>
    <Ellipse cx={540} cy={1230} rx={490} ry={367} fill={`url(#${uid}-warm)`} />
    <Ellipse cx={540} cy={1270} rx={233} ry={85} fill={`url(#${uid}-ember)`} />
    <Ellipse cx={540} cy={1140} rx={194} ry={220} fill={`url(#${uid}-ember)`} opacity={0.55} />
  </Svg>;
});

const GroundShadows = memo(function GroundShadows({ count }: { count: number }) {
  const uid = useId().replace(/:/g, '');
  return <Svg width="100%" height="100%" viewBox={VIEWBOX}>
    <Defs><RadialGradient id={`${uid}-shadow`}>
      <Stop offset="0" stopColor="#02070C" stopOpacity={0.75} /><Stop offset="0.45" stopColor="#02070C" stopOpacity={0.48} />
      <Stop offset="1" stopColor="#02070C" stopOpacity={0} />
    </RadialGradient></Defs>
    {campsitePositions(Math.min(count, 6)).map((p, i) => {
      const dx = p.x - FIRE.x, dy = p.y - FIRE.y;
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      const length = 130 + Math.min(120, Math.hypot(dx, dy) * 0.28);
      return <G key={i} transform={`translate(${p.x} ${p.y}) rotate(${angle})`}>
        <Ellipse cx={length * 0.48} cy={0} rx={length * 0.75} ry={48 * p.scale} fill={`url(#${uid}-shadow)`} opacity={0.83} />
      </G>;
    })}
  </Svg>;
});

const styles = StyleSheet.create({
  scene: { width: '100%', aspectRatio: WIDTH / (HEIGHT - SKY_CROP), overflow: 'hidden' },
  layer: { position: 'absolute' },
  nameTag: { position: 'absolute', alignItems: 'center', justifyContent: 'center', backgroundColor: '#071015B8', borderRadius: 22 },
  name: { fontWeight: '600', textAlign: 'center' },
  freshTomorrow: { position: 'absolute', textAlign: 'center', color: '#C5AC97' },
});
