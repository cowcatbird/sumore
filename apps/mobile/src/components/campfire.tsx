import { View } from 'react-native';
import Svg, { Ellipse, Rect } from 'react-native-svg';

import { BigFire, CampsiteScene } from '@/components/campsite-scene';
import { useSpriteFrame } from '@/components/use-fire-motion';
import { BIG_FIRE_FRAME_MS } from '@/domain/fire-motion';
import { useCharacter } from '@/features/character-store';
import { useApp } from '@/features/app-store';
import type { CampfireSeat } from '@/types/domain';
import type { CharacterAppearance } from '@/domain/character';
import type { BackgroundId } from '@/domain/circle-shop';

export function Campfire({ seats, compact = false, paused = false, exampleLooks, background, onPressYourCamper }: { seats: CampfireSeat[]; compact?: boolean; paused?: boolean; exampleLooks?: readonly CharacterAppearance[]; background?: BackgroundId; onPressYourCamper?: () => void }) {
  const { appearance } = useCharacter();
  const { circleShop } = useApp();
  if (!compact) return <CampsiteScene seats={seats} appearance={appearance} paused={paused} exampleLooks={exampleLooks} background={background ?? circleShop?.background ?? 'forest'} onPressYourCamper={onPressYourCamper} />;
  return <CompactCampfire paused={paused} />;
}

function CompactCampfire({ paused }: { paused: boolean }) {
  const bigFrame = useSpriteFrame(BIG_FIRE_FRAME_MS, !paused);
  return <View style={{ width: '100%', aspectRatio: 2.2 }}>
    <Svg width="100%" height="100%" viewBox="0 0 240 110">
      <Ellipse cx={120} cy={101} rx={51} ry={7} fill="#AE7B3D" opacity={0.25} />
      <Rect x={83} y={88} width={75} height={10} rx={5} fill="#674326" />
      <BigFire frame={bigFrame} x={120} y={96} height={88} />
    </Svg>
  </View>;
}
