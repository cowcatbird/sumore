import { type ReactNode, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { BlanketBand } from '@/components/blanket-band';
import { Space, Type, useAppColors, type AppPalette } from '@/constants/theme';

type ScreenHeaderProps = { title: string; subtitle?: string; action?: ReactNode };

/**
 * Title, optional subtitle, and the woven band beneath. No eyebrow: the
 * heading carries its own weight, and a tracked label above it only competed.
 */
export function ScreenHeader({ title, subtitle, action }: ScreenHeaderProps) {
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);

  return (
    <View style={styles.header}>
      <View style={styles.headingRow}>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
        {action}
      </View>
      {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      <View style={styles.band}><BlanketBand /></View>
    </View>
  );
}

const createStyles = (c: AppPalette) =>
  StyleSheet.create({
    header: { paddingTop: Space.md, paddingBottom: Space.xs, gap: Space.sm },
    headingRow: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
    title: { ...Type.title, color: c.ink, flex: 1 },
    subtitle: { ...Type.body, color: c.inkSoft, maxWidth: 330 },
    band: { borderRadius: 3, overflow: 'hidden' },
  });
