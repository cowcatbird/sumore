import { type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Space, Type, useAppColors } from '@/constants/theme';
import { FormLayout } from '@/constants/form-layout';

/** Quiet section divider. Reserve the orange band for page and sheet titles. */
export function SectionHeading({ title, action }: { title: string; action?: ReactNode }) {
  const c = useAppColors();
  return (
    <View style={[styles.header, { borderTopColor: c.seam }]}>
      <View style={styles.row}>
        <Text accessibilityRole="header" style={[styles.title, { color: c.ink }]}>{title}</Text>
        {action}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { borderTopWidth: 1, paddingTop: FormLayout.dividerPadding },
  // Keep the same title baseline whether or not a 44pt help target is present.
  row: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: Space.xs },
  title: { ...Type.heading, flex: 1 },
});
