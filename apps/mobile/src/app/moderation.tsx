import { router } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/form-sheet';
import { ModerationInbox } from '@/components/moderation-inbox';
import { ScreenHeader } from '@/components/screen-header';
import { MaxContentWidth, Space, useAppColors } from '@/constants/theme';

/** Hidden from the tab bar. The inbox verifies moderator access independently
 * of the Setup link, so navigating directly to this route grants nothing. */
export default function ModerationScreen() {
  const c = useAppColors();
  return <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: c.ground }}>
    <ScrollView contentInsetAdjustmentBehavior="never" showsVerticalScrollIndicator={false}
      contentContainerStyle={{ width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center',
        paddingHorizontal: Space.lg, paddingBottom: Space.xxl, gap: Space.lg }}>
      <ScreenHeader title="Community review" subtitle="Private moderation inbox" />
      <View style={{ alignSelf: 'flex-start' }}><ActionButton label="Back to Setup" onPress={() => router.replace('/settings')} /></View>
      <ModerationInbox />
    </ScrollView>
  </SafeAreaView>;
}
