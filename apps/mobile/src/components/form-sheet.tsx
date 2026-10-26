import { type PropsWithChildren } from 'react';
import { Keyboard, Modal, Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { KeyboardForm } from '@/components/keyboard-form';
import { Space, useAppColors } from '@/constants/theme';
import { FormLayout, formControlStyle } from '@/constants/form-layout';

/** One scrollable, keyboard-aware form per modal, including on small phones. */
export function FormSheet({ title, visible, onClose, busy = false, children }: PropsWithChildren<{
  title: string; visible: boolean; onClose: () => void; busy?: boolean;
}>) {
  const c = useAppColors();
  const close = () => { if (!busy) { Keyboard.dismiss(); onClose(); } };
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <SafeAreaProvider style={{ flex: 1, backgroundColor: c.ground }}>
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1 }}>
        <View style={{ flex: 1, width: '100%', maxWidth: 600, alignSelf: 'center' }} accessibilityViewIsModal>
          <View style={{ padding: Space.md, gap: Space.md, flexDirection: 'row', alignItems: 'center' }}>
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 22, fontWeight: '700', flex: 1 }}>{title}</Text>
            <ActionButton label="Close" onPress={close} disabled={busy} />
          </View>
          <KeyboardForm contentContainerStyle={{ padding: Space.lg, paddingBottom: 60, gap: FormLayout.sectionGap }}>
            {children}
          </KeyboardForm>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  </Modal>;
}

export function ActionButton({ label, onPress, disabled = false, primary = false, danger = false }: {
  label: string; onPress: () => void; disabled?: boolean; primary?: boolean; danger?: boolean;
}) {
  const c = useAppColors();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={{ ...formControlStyle, alignItems: 'center', justifyContent: 'center',
      backgroundColor: primary ? c.ember : c.wool, borderColor: c.seam, borderWidth: primary ? 0 : 1, opacity: disabled ? 0.5 : 1 }}>
    <Text style={{ color: danger ? c.scarlet : primary ? c.onFlame : c.ink, fontWeight: '600', fontSize: 15, textAlign: 'center' }}>{label}</Text>
  </Pressable>;
}
