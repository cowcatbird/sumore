import { memo, useId } from 'react';
import { Platform, View } from 'react-native';
import Svg, { ClipPath, Defs, Ellipse, G, Image, LinearGradient, Mask, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { type CharacterAppearance, type HatId } from '@/domain/character';
import { atlasRegionViewport, BURNT_CAP_REGION, BURNT_HAND_CROP, COLORED_CAMPER_ATLAS, coloredBodyCrop, coloredHandArt, HAND_VIEWPORT, ORIGINAL_BODY_CROPS, type PaintedBodyColor } from '@/domain/colored-camper-art';
import { useSpriteFrame } from '@/components/use-fire-motion';
import { SMALL_FIRE_FRAME_MS } from '@/domain/fire-motion';
import { characterGeometryKey, counterMirrorHat, fitHat, HAT_CROPS, hatAtlasGeometry } from '@/domain/hat-fitting';
import { hatLighting } from '@/domain/hat-lighting';
import { CHARACTER_MIRROR_X, fitAtlasImage, MARSHMALLOW_EFFECT_PADDING, MARSHMALLOW_FLAME_CROP, marshmallowEffectViewport, marshmallowFlameViewport, type SpriteCrop, type SpriteViewport } from '@/domain/sprite-atlas';

// All supplied sheets have their own transparent silhouettes. Rectangular
// atlas crops only exclude neighboring sprites; no hand-traced edge masks.
const BODY = require('../../assets/campsite/sprites2.png');
const COLORED_CAMPERS = require('../../assets/campsite/colored-campers.png');
const HAT_ATLASES = {
  original: require('../../assets/campsite/hats.png'),
  extra: require('../../assets/campsite/hats-extra.png'),
  accessories: require('../../assets/campsite/hats-accessories.png'),
};
const STICKS = require('../../assets/campsite/hand-and-marshmellow.png');
const LOGO = require('../../assets/campsite/sumore.png');
const FLAMES = [
  require('../../assets/campsite/marshmellow-fire-subtle-frame-1.png'),
  require('../../assets/campsite/marshmellow-fire-subtle-frame-2.png'),
  require('../../assets/campsite/marshmellow-fire-subtle-frame-3.png'),
];
// Web needs the CSS property; the native component also accepts an explicit prop.
const nativeAlphaMask = Platform.OS === 'ios' || Platform.OS === 'android'
  ? { maskType: 'alpha' as const } : {};

// Source-atlas coordinates trace only the white hand interiors. The gray ring,
// stick and either marshmallow remain the original, untinted image pixels.
const handInteriors = {
  fresh: {
    bounds: { x: 256, y: 513, width: 36, height: 35 },
    path: 'M277.5 513.5L280.5 514.5L282.5 515.5L284.5 516.5L285.5 517.5L286.5 518.5L287.5 519.5L288.5 520.5L289.5 521.5L289.5 522.5L290.5 523.5L290.5 524.5L290.5 525.5L291.5 526.5L291.5 527.5L291.5 528.5L291.5 529.5L291.5 530.5L291.5 531.5L291.5 532.5L291.5 533.5L291.5 534.5L291.5 535.5L291.5 536.5L291.5 537.5L291.5 538.5L290.5 539.5L290.5 540.5L289.5 541.5L288.5 542.5L287.5 543.5L285.5 544.5L283.5 545.5L280.5 546.5L273.5 547.5L269.5 547.5L264.5 546.5L261.5 545.5L260.5 544.5L259.5 543.5L259.5 542.5L258.5 541.5L258.5 540.5L257.5 539.5L257.5 538.5L257.5 537.5L256.5 536.5L256.5 535.5L256.5 534.5L256.5 533.5L257.5 532.5L257.5 531.5L257.5 530.5L257.5 529.5L257.5 528.5L258.5 527.5L258.5 526.5L258.5 525.5L259.5 524.5L259.5 523.5L259.5 522.5L260.5 521.5L261.5 520.5L262.5 519.5L263.5 518.5L264.5 517.5L265.5 516.5L266.5 515.5L268.5 514.5L269.5 513.5Z',
  },
  burnt: {
    bounds: { x: 430, y: 521, width: 36, height: 35 },
    path: 'M448.5 521.5L452.5 522.5L454.5 523.5L456.5 524.5L458.5 525.5L459.5 526.5L460.5 527.5L461.5 528.5L462.5 529.5L462.5 530.5L463.5 531.5L463.5 532.5L464.5 533.5L464.5 534.5L464.5 535.5L465.5 536.5L465.5 537.5L465.5 538.5L465.5 539.5L465.5 540.5L465.5 541.5L465.5 542.5L465.5 543.5L465.5 544.5L465.5 545.5L464.5 546.5L464.5 547.5L464.5 548.5L463.5 549.5L462.5 550.5L461.5 551.5L460.5 552.5L458.5 553.5L456.5 554.5L452.5 555.5L438.5 555.5L435.5 554.5L434.5 553.5L433.5 552.5L432.5 551.5L432.5 550.5L431.5 549.5L431.5 548.5L431.5 547.5L430.5 546.5L430.5 545.5L430.5 544.5L430.5 543.5L430.5 542.5L430.5 541.5L430.5 540.5L430.5 539.5L431.5 538.5L431.5 537.5L431.5 536.5L431.5 535.5L432.5 534.5L432.5 533.5L432.5 532.5L433.5 531.5L433.5 530.5L434.5 529.5L435.5 528.5L436.5 527.5L437.5 526.5L438.5 525.5L439.5 524.5L441.5 523.5L442.5 522.5L444.5 521.5Z',
  },
};
export const hatCrops = HAT_CROPS;

function AtlasImage({ source, atlasWidth, atlasHeight, crop, clipId, ...viewport }: SpriteViewport & {
  source: number; atlasWidth: number; atlasHeight: number; crop: SpriteCrop; clipId: string;
}) {
  // Explicit nonzero uses Android's rebuilt union path, instead of its cached
  // evenodd GroupView path. Otherwise a cow can retain the sunglasses' crop.
  return <Image href={source} {...fitAtlasImage(atlasWidth, atlasHeight, crop, viewport)}
    clipRule="nonzero" clipPath={`url(#${clipId})`} />;
}

/** Use the supplied hand artwork with a lighter base beneath its firelight. */
function ColoredMarshmallowStick({ color, burnt, uid }: { color: PaintedBodyColor; burnt: boolean; uid: string }) {
  const art = coloredHandArt(color);
  const burntCap = atlasRegionViewport({ width: 794, height: 1123 }, BURNT_HAND_CROP, HAND_VIEWPORT, BURNT_CAP_REGION);
  const hand = <AtlasImage source={COLORED_CAMPERS}
    atlasWidth={COLORED_CAMPER_ATLAS.width} atlasHeight={COLORED_CAMPER_ATLAS.height}
    crop={art.crop} {...HAND_VIEWPORT} clipId={`${uid}-colored-stick-clip`} />;
  return <G>
    <Defs>
      <ClipPath id={`${uid}-colored-stick-clip`}><Rect {...HAND_VIEWPORT} /></ClipPath>
      <ClipPath id={`${uid}-colored-stick-below-cap`}><Rect {...art.stickBelowCap} /></ClipPath>
      <ClipPath id={`${uid}-burnt-cap-clip`}><Rect {...burntCap} /></ClipPath>
      <Mask id={`${uid}-colored-hand`} {...art.hand}
        maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" {...nativeAlphaMask} style={{ maskType: 'alpha' }}>
        {hand}
      </Mask>
    </Defs>
    {burnt ? <>
      <G clipRule="nonzero" clipPath={`url(#${uid}-colored-stick-below-cap)`}>{hand}</G>
      <AtlasImage source={STICKS} atlasWidth={794} atlasHeight={1123} crop={BURNT_HAND_CROP}
        {...HAND_VIEWPORT} clipId={`${uid}-burnt-cap-clip`} />
    </> : hand}
    {/* Lighten the hand's base color first, not the strength of its shadows. */}
    <Rect {...art.hand} fill="#FFFFFF" opacity={0.28} mask={`url(#${uid}-colored-hand)`} />
    <Rect {...art.hand} fill={`url(#${uid}-shade)`} opacity={0.75} mask={`url(#${uid}-colored-hand)`} />
  </G>;
}

export function BrandLogo({ size = 40 }: { size?: number }) {
  return <Svg width={size} height={size} viewBox="94 100 320 300" accessibilityLabel="sumore logo">
    <Image href={LOGO} width={500} height={500} />
  </Svg>;
}

export function HatSprite({ hat, size = 64, shaded = false }: { hat: HatId; size?: number; shaded?: boolean }) {
  const uid = useId().replace(/:/g, '');
  const shading = hatLighting(hat);
  if (hat === 'none') return <Svg key={hat} width={size} height={size} viewBox="0 0 64 64">
    <Rect x={18} y={14} width={28} height={39} rx={14} fill="#F6EEDC" />
  </Svg>;
  const crop = hatCrops[hat];
  const atlas = hatAtlasGeometry(hat);
  const HATS = HAT_ATLASES[atlas.sheet];
  return <Svg key={hat} width={size} height={size} viewBox={`${crop.x} ${crop.y} ${crop.w} ${crop.h}`}>
    {/* A square viewport letterboxes wide hats. Clip the atlas itself so that
        neighboring sprites cannot appear in that otherwise empty space. */}
    <Defs>
      <ClipPath id={`${uid}-thumbnail-clip`}>
        <Rect x={crop.x} y={crop.y} width={crop.w} height={crop.h} />
      </ClipPath>
      {shaded && <>
        <Mask id={`${uid}-thumbnail-mask`} x={crop.x} y={crop.y} width={crop.w} height={crop.h}
          maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" {...nativeAlphaMask} style={{ maskType: 'alpha' }}>
          <Image href={HATS} width={atlas.width} height={atlas.height} clipRule="nonzero" clipPath={`url(#${uid}-thumbnail-clip)`} />
        </Mask>
        <LinearGradient id={`${uid}-thumbnail-shade`} x1="0%" y1="30%" x2="100%" y2="65%">
          <Stop offset="0" stopColor="#04101D" stopOpacity={0.58} />
          <Stop offset="0.38" stopColor="#0B1C2A" stopOpacity={0.3} />
          <Stop offset="0.73" stopColor="#FFBF69" stopOpacity={0.12} />
          <Stop offset="1" stopColor="#FFB04A" stopOpacity={0.28} />
        </LinearGradient>
      </>}
    </Defs>
    <Image href={HATS} width={atlas.width} height={atlas.height} clipRule="nonzero" clipPath={`url(#${uid}-thumbnail-clip)`} />
    {shaded && <Rect x={crop.x} y={crop.y} width={crop.w} height={crop.h}
      fill={`url(#${uid}-thumbnail-shade)`} opacity={shading.directionalOpacity} mask={`url(#${uid}-thumbnail-mask)`} />}
  </Svg>;
}

/** Original or user-painted sprite art under the same directional firelight. */
export const CharacterDrawing = memo(function CharacterDrawing({ appearance, burnt = false, lighting = 0.8, facing = 'right', showMarshmallow = true }: {
  appearance: CharacterAppearance; burnt?: boolean; lighting?: number; facing?: 'left' | 'right'; showMarshmallow?: boolean;
}) {
  const uid = useId().replace(/:/g, '');
  const originalCrop = ORIGINAL_BODY_CROPS[appearance.body];
  const color = appearance.color ?? 'cream';
  const crop = color === 'cream' ? originalCrop : coloredBodyCrop(color, appearance.body);
  const bodyAtlas = color === 'cream' ? { width: 794, height: 1123 } : COLORED_CAMPER_ATLAS;
  const bodyWidth = 65;
  const bodyHeight = bodyWidth * originalCrop.h / originalCrop.w;
  const top = 194 - bodyHeight;
  const bodyViewport = { x: 43, y: top, width: bodyWidth, height: bodyHeight };
  const body = <AtlasImage source={color === 'cream' ? BODY : COLORED_CAMPERS}
    atlasWidth={bodyAtlas.width} atlasHeight={bodyAtlas.height} crop={crop}
    {...bodyViewport} clipId={`${uid}-body-clip`} />;
  const hat = appearance.hat;
  const shading = hatLighting(hat);
  const preserveCatOrientation = counterMirrorHat(hat, facing);
  const hatCrop = hat === 'none' ? null : hatCrops[hat];
  const placement = hat !== 'none' && hatCrop ? fitHat(hat, top, hatCrop.w / hatCrop.h) : { x: 0, y: 0, width: 0, height: 0 };
  const hatAtlas = hatAtlasGeometry(hat);
  const HATS = HAT_ATLASES[hatAtlas.sheet];
  const handCrop = burnt
    ? BURNT_HAND_CROP : { x: 243, y: 434, w: 132, h: 132 };
  const handViewport = HAND_VIEWPORT;
  const handInterior = burnt ? handInteriors.burnt : handInteriors.fresh;
  const handAtlas = fitAtlasImage(794, 1123, handCrop, handViewport);
  const handScale = handAtlas.width / 794;

  return <G transform={facing === 'left' ? `translate(${CHARACTER_MIRROR_X} 0) scale(-1 1)` : undefined}>
    <Defs>
      {/* Declare clips outside masks: native Mask does not parse child definitions. */}
      <ClipPath id={`${uid}-body-clip`}><Rect {...bodyViewport} /></ClipPath>
      <ClipPath id={`${uid}-hand-clip`}><Rect {...handViewport} /></ClipPath>
      <ClipPath id={`${uid}-hand-fill-clip`}><Path d={handInterior.path} /></ClipPath>
      {hatCrop && <ClipPath id={`${uid}-hat-clip`}>
        <Rect {...placement} />
      </ClipPath>}
      <Mask id={`${uid}-body`} x={40} y={top - 1} width={72} height={bodyHeight + 3}
        maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" {...nativeAlphaMask} style={{ maskType: 'alpha' }}>{body}</Mask>
      <LinearGradient id={`${uid}-shade`} x1="0%" y1="30%" x2="100%" y2="65%">
        <Stop offset="0" stopColor="#0A1927" stopOpacity={0.77 - lighting * 0.18} />
        <Stop offset="0.36" stopColor="#183040" stopOpacity={0.33} />
        <Stop offset="0.72" stopColor="#FFD18B" stopOpacity={0.17 + lighting * 0.23} />
        <Stop offset="1" stopColor="#FFAD41" stopOpacity={0.52 + lighting * 0.14} />
      </LinearGradient>
      <LinearGradient id={`${uid}-hat-shade`} x1={preserveCatOrientation ? '100%' : '0%'} y1="30%" x2={preserveCatOrientation ? '0%' : '100%'} y2="65%">
        <Stop offset="0" stopColor="#04101D" stopOpacity={0.73} />
        <Stop offset="0.38" stopColor="#0B1C2A" stopOpacity={0.46} />
        <Stop offset="0.73" stopColor="#FFBF69" stopOpacity={0.1 + lighting * 0.18} />
        <Stop offset="1" stopColor="#FFB04A" stopOpacity={0.27 + lighting * 0.23} />
      </LinearGradient>
      {hatCrop && <Mask id={`${uid}-hat`} x={placement.x - 1} y={placement.y - 1} width={placement.width + 2} height={placement.height + 2}
        maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" {...nativeAlphaMask} style={{ maskType: 'alpha' }}>
        <AtlasImage source={HATS} atlasWidth={hatAtlas.width} atlasHeight={hatAtlas.height} crop={hatCrop} {...placement} clipId={`${uid}-hat-clip`} />
      </Mask>}
    </Defs>
    <Ellipse cx={77} cy={195} rx={37} ry={8} fill="#02070B" opacity={0.42} />
    {body}
    <Rect x={41} y={top - 1} width={70} height={bodyHeight + 3} fill={`url(#${uid}-shade)`} mask={`url(#${uid}-body)`} />
    {hatCrop && <G transform={preserveCatOrientation ? `translate(${CHARACTER_MIRROR_X} 0) scale(-1 1)` : undefined}>
      <AtlasImage source={HATS} atlasWidth={hatAtlas.width} atlasHeight={hatAtlas.height} crop={hatCrop} {...placement} clipId={`${uid}-hat-clip`} />
      <G mask={`url(#${uid}-hat)`}>
        <Rect {...placement} fill="#071320" opacity={shading.ambientOpacity} />
        <Rect {...placement} fill={`url(#${uid}-hat-shade)`} opacity={shading.directionalOpacity} />
      </G>
    </G>}
    {showMarshmallow && (color !== 'cream' ? <ColoredMarshmallowStick color={color} burnt={burnt} uid={uid} /> : <>
      <AtlasImage source={STICKS} atlasWidth={794} atlasHeight={1123} crop={handCrop}
        {...handViewport} clipId={`${uid}-hand-clip`} />
      {/* Use the bitmap's exact crop transform, including the burnt pose's
          letterboxing. Match the colored hands' directional firelight. */}
      <G transform={`translate(${handAtlas.x} ${handAtlas.y}) scale(${handScale})`}>
        <G clipRule="nonzero" clipPath={`url(#${uid}-hand-fill-clip)`}>
          <Rect {...handInterior.bounds} fill={`url(#${uid}-shade)`} opacity={0.75} />
        </G>
      </G>
    </>)}
  </G>;
});

/** Only this tiny surface redraws for a marshmallow flame frame change.
 * Body/hat masks stay on the separate, static character SVG.
 */
function MarshmallowFlame({ size, facing, animated }: { size: number; facing: 'left' | 'right'; animated: boolean }) {
  const frame = useSpriteFrame(SMALL_FIRE_FRAME_MS, animated);
  const uid = useId().replace(/:/g, '');
  const flame = marshmallowFlameViewport(facing);
  const viewport = marshmallowEffectViewport(facing);
  const scale = size / 160;
  const localViewport = { x: MARSHMALLOW_EFFECT_PADDING, y: MARSHMALLOW_EFFECT_PADDING, width: flame.width, height: flame.height };
  const glowX = localViewport.x + flame.width / 2;
  const glowY = localViewport.y + flame.height - 3;
  return <View pointerEvents="none" style={{ position: 'absolute', left: viewport.x * scale, top: viewport.y * scale,
    width: viewport.width * scale, height: viewport.height * scale }}>
    <Svg width="100%" height="100%" viewBox={`0 0 ${viewport.width} ${viewport.height}`}>
      <Defs>
        <ClipPath id={`${uid}-flame-clip`}><Rect {...localViewport} /></ClipPath>
        <RadialGradient id={`${uid}-ember-glow`}>
          <Stop offset="0" stopColor="#FFCB75" stopOpacity={0.3} />
          <Stop offset="0.35" stopColor="#FFAA43" stopOpacity={0.14} />
          <Stop offset="0.7" stopColor="#FF852B" stopOpacity={0.04} />
          <Stop offset="1" stopColor="#FF852B" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={glowX} cy={glowY} rx={28} ry={22} fill={`url(#${uid}-ember-glow)`} />
      <G transform={facing === 'left' ? `translate(${viewport.width} 0) scale(-1 1)` : undefined}>
        {/* Keep all three native images mounted: changing href every frame can
            leave an empty frame while the next bitmap loads on a phone. */}
        {FLAMES.map((source, index) => <G key={index} opacity={index === frame ? 1 : 0}>
          <AtlasImage source={source} atlasWidth={1024} atlasHeight={1024} crop={MARSHMALLOW_FLAME_CROP}
            {...localViewport} clipId={`${uid}-flame-clip`} />
        </G>)}
      </G>
    </Svg>
  </View>;
}

export const CharacterSprite = memo(function CharacterSprite({ appearance, burnt = false, size = 160, lighting = 0.8, facing = 'right', showMarshmallow = true, animated = true }: {
  appearance: CharacterAppearance; burnt?: boolean; size?: number; lighting?: number; facing?: 'left' | 'right'; showMarshmallow?: boolean; animated?: boolean;
}) {
  return <View accessibilityLabel={`${appearance.color ?? 'cream'} ${appearance.body} camper, ${appearance.hat} hat, ${burnt ? 'burnt' : 'fresh'} marshmallow`}
    // A left-facing flame starts at x=-4. Clip individual atlas images, not the
    // camper's layout box: the flame and its soft glow legitimately overhang it.
    style={{ width: size, height: size * 1.375, overflow: 'visible' }}>
    {/* Reset Android's native image, clip and mask caches together on a real
        appearance change. iOS/web retain their existing rendering lifecycle. */}
    <Svg key={Platform.OS === 'android' ? characterGeometryKey(appearance, facing, burnt) : undefined}
      width={size} height={size * 1.375} viewBox="0 0 160 220">
      <CharacterDrawing appearance={appearance} burnt={burnt} lighting={lighting} facing={facing} showMarshmallow={showMarshmallow} />
    </Svg>
    {burnt && showMarshmallow && <MarshmallowFlame size={size} facing={facing} animated={animated} />}
  </View>;
});
