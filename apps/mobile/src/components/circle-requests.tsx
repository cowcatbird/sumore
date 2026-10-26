import { SymbolView } from 'expo-symbols';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LocalPreviewBanner } from '@/components/local-preview-banner';
import { HelpButton } from '@/components/help-button';
import { ReportContentSheet } from '@/components/report-content-sheet';
import { formControlStyle } from '@/constants/form-layout';
import { Radius, Shadow, Space, Type, stripeFor, useAppColors, type AppPalette } from '@/constants/theme';
import { useApp } from '@/features/app-store';
import { useLocalArtPreview } from '@/features/local-art-preview';
import type { ReportTarget } from '@/features/moderation-store';
import type { Decision } from '@/types/domain';

export function RequestsHelp() {
  return <HelpButton title="Extra-time requests">
    <Text>Approve or deny your friends’ requests.</Text>
    <Text>Your friend must have sumore open to accept or deny your request.</Text>
  </HelpButton>;
}

export function CircleRequests() {
  const { profile, circleShop, busy, error, incomingRequests, decideRequest } = useApp();
  const [savedReport, setSavedReport] = useState<{ ownerId: string; circleId?: string; target: ReportTarget | null }>(
    () => ({ ownerId: profile.id, circleId: circleShop?.id, target: null }));
  const currentReport = savedReport.ownerId === profile.id && savedReport.circleId === circleShop?.id;
  if (!currentReport) setSavedReport({ ownerId: profile.id, circleId: circleShop?.id, target: null });
  const report = currentReport ? savedReport.target : null;
  const setReport = (target: ReportTarget | null) => setSavedReport({ ownerId: profile.id, circleId: circleShop?.id, target });
  const preview = useLocalArtPreview();
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const decide = async (requestId: string, decision: Decision) => {
    try {
      await decideRequest(requestId, decision);
    } catch {
      // The store renders the friendly error.
    }
  };

  return (
    <View style={styles.content}>
        <LocalPreviewBanner actionLabel="Reload requests" onAction={preview?.refillRequests} />

        {error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}

        {incomingRequests.map((request) => (
          <View key={request.id} style={styles.ask}>
            <View style={styles.askTop}>
              <View style={[styles.tag, { borderColor: c[stripeFor(request.friend.id)] }]}>
                <Text style={styles.tagInitials}>{request.friend.initials}</Text>
              </View>
              <View style={styles.askWho}>
                <Text style={styles.askName}>{request.friend.displayName}</Text>
              </View>
              <View style={styles.waiting}>
                <Text style={styles.waitingText}>Pending</Text>
              </View>
            </View>

            <View style={styles.amount}>
              <Text style={styles.amountNumber}>{request.minutes}</Text>
              <View style={styles.amountCopy}>
                <Text style={styles.amountUnit}>more minutes</Text>
              </View>
            </View>

            {request.reason ? <Text style={styles.reason}>“{request.reason}”</Text> : null}

            {circleShop && <Pressable accessibilityRole="button" accessibilityLabel={`Report request from ${request.friend.displayName}`}
              style={{ alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center' }}
              onPress={() => setReport({ ownerId: profile.id, circleId: circleShop.id, targetUserId: request.friend.id,
                displayName: request.friend.displayName, kind: 'request', requestId: request.id })}>
              <Text style={{ ...Type.bodySmall, color: c.inkSoft }}>Report request</Text>
            </Pressable>}

            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => decide(request.id, 'denied')}
                style={({ pressed }) => [styles.notTonight, busy && styles.disabled, pressed && styles.pressed]}>
                <SymbolView
                  name={{ ios: 'moon.stars.fill', android: 'bedtime', web: 'bedtime' }}
                  size={16}
                  tintColor={c.ink}
                />
                <Text style={styles.notTonightText}>Deny</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={() => decide(request.id, 'approved')}
                style={({ pressed }) => [styles.passOver, busy && styles.disabled, pressed && styles.pressed]}>
                <SymbolView
                  name={{ ios: 'flame.fill', android: 'local_fire_department', web: 'local_fire_department' }}
                  size={16}
                  tintColor={c.onFlame}
                />
                <Text style={styles.passOverText}>Approve</Text>
              </Pressable>
            </View>
          </View>
        ))}

        {incomingRequests.length === 0 && (
          <View style={styles.empty}>
            <View style={styles.emptyMark}>
              <SymbolView
                name={{ ios: 'moon.zzz.fill', android: 'bedtime', web: 'bedtime' }}
                size={26}
                tintColor={c.inkSoft}
              />
            </View>
            <Text style={styles.emptyTitle}>No requests</Text>
          </View>
        )}
        <ReportContentSheet target={report} onClose={() => setReport(null)} />
    </View>
  );
}

const createStyles = (c: AppPalette) =>
  StyleSheet.create({
    content: { gap: Space.md },

    ask: {
      padding: Space.md,
      backgroundColor: c.wool,
      borderRadius: Radius.blanket,
      borderWidth: 1,
      borderColor: c.seam,
      gap: Space.md,
      ...Shadow.rest,
    },
    askTop: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
    tag: {
      width: 44,
      height: 44,
      borderRadius: Radius.tin,
      borderWidth: 1.5,
      backgroundColor: c.woolDeep,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tagInitials: { ...Type.stamp, color: c.ink, letterSpacing: 0.6 },
    askWho: { flex: 1, gap: 2 },
    askName: { ...Type.control, color: c.ink },
    waiting: {
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: Radius.coal,
      borderWidth: 1,
      borderColor: c.emberLow,
      backgroundColor: c.emberWash,
    },
    waitingText: { ...Type.stamp, color: c.toast },

    amount: { flexDirection: 'row', alignItems: 'center', gap: Space.md },
    amountNumber: { ...Type.beacon, color: c.ember },
    amountCopy: { flex: 1 },
    amountUnit: { ...Type.heading, color: c.ink },

    reason: { ...Type.body, color: c.ink, fontStyle: 'italic' },

    actions: { flexDirection: 'row', gap: Space.sm },
    notTonight: {
      ...formControlStyle,
      flex: 1,
      backgroundColor: c.woolDeep,
      borderWidth: 1,
      borderColor: c.seam,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
    },
    notTonightText: { ...Type.control, color: c.ink },
    passOver: {
      ...formControlStyle,
      flex: 1,
      backgroundColor: c.ember,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      ...Shadow.lit,
    },
    passOverText: { ...Type.control, color: c.onFlame },
    pressed: { opacity: 0.86, transform: [{ scale: 0.995 }] },
    disabled: { opacity: 0.55 },

    empty: { alignItems: 'center', paddingVertical: Space.lg, gap: Space.xs },
    emptyMark: {
      width: 58,
      height: 58,
      borderRadius: Radius.coal,
      backgroundColor: c.woolDeep,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Space.xs,
    },
    emptyTitle: { ...Type.heading, color: c.ink },

    error: {
      ...Type.bodySmall,
      color: c.scarlet,
      backgroundColor: c.emberWash,
      borderRadius: Radius.tin,
      padding: Space.sm,
    },
  });
