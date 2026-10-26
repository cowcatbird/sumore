import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Radius, Type, stripeFor, useAppColors, type AppPalette } from '@/constants/theme';
import type { Friend } from '@/types/domain';

/**
 * A person as a stamped tin tag hung on a wire.
 *
 * The wire is the point: the tags hang from one shared line at the same
 * height, so the group reads as equals in tension rather than as a stack with
 * someone on top. Slack when nobody is asking, drawn taut when a request is
 * live.
 */
export function TinTagWire({ friends, taut = false }: { friends: Friend[]; taut?: boolean }) {
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);

  if (!friends.length) return null;

  return (
    <View style={styles.wrap}>
      <View style={[styles.wire, taut && styles.wireTaut]} />
      <View style={styles.tags}>
        {friends.map((friend) => (
          <View key={friend.id} style={styles.hang}>
            <View style={[styles.hook, taut && styles.hookTaut]} />
            <View style={[styles.tag, { borderColor: c[stripeFor(friend.id)] }]}>
              <Text style={styles.initials}>{friend.initials}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const createStyles = (c: AppPalette) =>
  StyleSheet.create({
    wrap: { paddingTop: 2 },
    wire: { height: 1, backgroundColor: c.edge, marginBottom: 1, opacity: 0.7 },
    wireTaut: { backgroundColor: c.ember, opacity: 1 },
    tags: { flexDirection: 'row', gap: 10 },
    hang: { alignItems: 'center' },
    hook: { width: 1, height: 7, backgroundColor: c.edge },
    hookTaut: { backgroundColor: c.emberLow },
    tag: {
      minWidth: 34,
      height: 34,
      paddingHorizontal: 6,
      borderRadius: Radius.tin,
      borderWidth: 1.5,
      backgroundColor: c.wool,
      alignItems: 'center',
      justifyContent: 'center',
    },
    initials: { ...Type.stamp, color: c.ink, letterSpacing: 0.6 },
  });
