import { useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActionButton } from '@/components/form-sheet';
import { useAppColors } from '@/constants/theme';
import { useApp } from '@/features/app-store';
import { clearRecoveryNotice, getRecoveryNotice, subscribeRecoveryNotice } from '@/services/account-access';

/** Lives outside the auth forms so successful recovery cannot swallow warnings. */
export function RecoveryNotice() {
  const notice = useSyncExternalStore(subscribeRecoveryNotice, getRecoveryNotice, getRecoveryNotice);
  const { profile } = useApp();
  const c = useAppColors();
  const insets = useSafeAreaInsets();
  if (!notice || notice.userId !== profile.id) return null;
  return <View style={{ padding: 14, paddingTop: insets.top + 10, backgroundColor: c.wool, gap: 10 }}>
    <Text accessibilityRole="alert" style={{ color: notice.warning ? c.ember : c.ink }}>{notice.message}</Text>
    <ActionButton label="Got it" onPress={clearRecoveryNotice} />
  </View>;
}
