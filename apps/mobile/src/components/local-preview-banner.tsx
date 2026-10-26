import { Pressable, Text, View } from 'react-native';

import { Radius, Space, Type, useAppColors } from '@/constants/theme';
import { useLocalArtPreview } from '@/features/local-art-preview';

/** Optional local controls without a development banner. */
export function LocalPreviewBanner({ actionLabel, onAction }: { actionLabel?: string; onAction?: () => void }) {
  const preview = useLocalArtPreview();
  const c = useAppColors();
  if (!preview || !actionLabel || !onAction) return null;
  return <View style={{ gap: Space.xs }}>
    {actionLabel && onAction && <Pressable accessibilityRole="button" onPress={onAction}
      style={{ minHeight: 44, paddingHorizontal: Space.sm, borderWidth: 1, borderColor: c.seam,
        borderRadius: Radius.tin, alignSelf: 'flex-start', justifyContent: 'center' }}>
      <Text style={{ ...Type.bodySmall, color: c.ember }}>{actionLabel}</Text>
    </Pressable>}
  </View>;
}
