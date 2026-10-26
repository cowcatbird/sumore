import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Pressable, Text, View } from 'react-native';

import { formControlStyle } from '@/constants/form-layout';
import { Radius, Space, Type, useAppColors } from '@/constants/theme';

/** A quiet, full-width entry into a Setup sheet; the whole row is the target. */
export function SettingsActionRow({ label, icon, onPress, disabled = false, danger = false }: {
  label: string; icon: SymbolViewProps['name']; onPress: () => void; disabled?: boolean; danger?: boolean;
}) {
  const c = useAppColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ ...formControlStyle, flexDirection: 'row', alignItems: 'center', gap: Space.sm,
      backgroundColor: pressed ? c.woolDeep : c.wool, borderColor: c.seam, borderWidth: 1,
      opacity: disabled ? 0.5 : pressed ? 0.88 : 1 })}>
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ width: 26, height: 26, borderRadius: Radius.tin, alignItems: 'center', justifyContent: 'center', backgroundColor: c.emberWash }}>
      <SymbolView name={icon} size={17} tintColor={danger ? c.scarlet : c.ember} />
    </View>
    <Text style={{ ...Type.control, color: c.ink, fontWeight: '600', flex: 1, flexShrink: 1 }}>{label}</Text>
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <SymbolView name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={14} tintColor={c.inkSoft} />
    </View>
  </Pressable>;
}
