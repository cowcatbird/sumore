import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KeyboardForm } from '@/components/keyboard-form';
import { LocalPreviewBanner } from '@/components/local-preview-banner';
import { LocalPreviewScreenTimeControls } from '@/components/local-preview-screen-time-controls';
import { ScreenHeader } from '@/components/screen-header';
import { ScreenTimeControls } from '@/components/screen-time-controls';
import { Space, useAppColors } from '@/constants/theme';
import { isLocalArtPreview } from '@/features/local-art-preview';

export default function ScreenTimeScreen() {
  const c = useAppColors();
  return <SafeAreaView edges={['top']} style={[styles.page, { backgroundColor: c.ground }]}>
    <KeyboardForm contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="never" showsVerticalScrollIndicator={false}>
      <ScreenHeader title="Screen Time" />
      <LocalPreviewBanner />
      {isLocalArtPreview ? <LocalPreviewScreenTimeControls /> : <ScreenTimeControls />}
    </KeyboardForm>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingHorizontal: Space.lg, paddingBottom: Space.xl, gap: Space.md },
});
