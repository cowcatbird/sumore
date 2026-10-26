import { requireNativeViewManager } from 'expo-modules-core';
import { useState, type ComponentType } from 'react';
import { Platform, Text, View, type ViewProps } from 'react-native';

import { Radius, Space, useAppColors } from '@/constants/theme';
import { PER_APP_LIMIT_EXPLANATION, remainingDailyTime, screenTimeAccessReady } from '@/domain/daily-limit-controls';
import type { ScreenTimeStatus } from '@/types/domain';

function NativeSelectedAppView(props: ViewProps & { refreshKey: number }) {
  const [NativeSelection] = useState(() => requireNativeViewManager('ScreenTimeModule') as ComponentType<ViewProps & { refreshKey: number }>);
  return <NativeSelection {...props} />;
}

/**
 * Geometry of the SwiftUI grid inside ScreenTimeSelectionView, which cannot
 * report its own height back across the bridge. These must stay in step with
 * ScreenTimeSelectionContent: an adaptive LazyVGrid of 88pt-minimum columns,
 * 12pt column spacing, 16pt row spacing, 104pt rows, 8pt vertical padding, and
 * a 104pt report block (plus its 12pt stack spacing) when a report is shown.
 */
const IOS_GRID_MIN_COLUMN = 88;
const IOS_GRID_ROW_HEIGHT = 104;
// The Android native view is unchanged by the iOS token-label layout fix.
const ANDROID_GRID_MIN_COLUMN = 76;
const ANDROID_GRID_ROW_HEIGHT = 82;
const GRID_COLUMN_GAP = 12;
const GRID_ROW_GAP = 16;
const GRID_VERTICAL_PADDING = 16;
const GRID_REPORT_HEIGHT = 116;

/** Columns a phone-width card fits, used until onLayout reports a real width. */
const GRID_ASSUMED_COLUMNS = 3;

export function selectedAppsGridHeight(count: number, width: number, showsReport: boolean) {
  // Mirrors GridItem(.adaptive(minimum:)): fit as many whole columns as the
  // measured width allows. Before the first layout pass the width is unknown,
  // so assume a phone rather than render nothing — a grid that waits for
  // measurement is a grid that never appears if layout reports zero.
  const minimumColumn = Platform.OS === 'ios' ? IOS_GRID_MIN_COLUMN : ANDROID_GRID_MIN_COLUMN;
  const rowHeight = Platform.OS === 'ios' ? IOS_GRID_ROW_HEIGHT : ANDROID_GRID_ROW_HEIGHT;
  const columns = width > 0
    ? Math.max(1, Math.floor((width + GRID_COLUMN_GAP) / (minimumColumn + GRID_COLUMN_GAP)))
    : GRID_ASSUMED_COLUMNS;
  const rows = Math.max(1, Math.ceil(count / columns));
  return GRID_VERTICAL_PADDING + rows * rowHeight + (rows - 1) * GRID_ROW_GAP
    + (showsReport ? GRID_REPORT_HEIGHT : 0);
}

export function SelectedApps({ status, refreshKey }: { status: ScreenTimeStatus; refreshKey: number }) {
  const c = useAppColors();
  const [gridWidth, setGridWidth] = useState(0);
  const count = status.selection.applications + status.selection.categories + status.selection.webDomains;
  if (!count) return null;
  // Only register the view after the installed native engine advertises it.
  // OTA updates on an older binary must never attempt to mount a missing view.
  return <View style={{ gap: 12, padding: Space.md, borderRadius: Radius.fold,
    borderWidth: 1, borderColor: c.seam, backgroundColor: c.woolDeep }}>
    <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, lineHeight: 23, fontWeight: '700' }}>Selected apps</Text>
    {status.limitMode === 'perApp' && <Text style={{ color: c.inkSoft, fontSize: 13, lineHeight: 19 }}>Individual daily allowances are shown under each app. {PER_APP_LIMIT_EXPLANATION}</Text>}
    {Platform.OS !== 'web' && status.selectionDisplayAvailable
      ? <View onLayout={event => setGridWidth(event.nativeEvent.layout.width)}>
          <NativeSelectedAppView refreshKey={refreshKey}
            style={{ width: '100%', height: selectedAppsGridHeight(count, gridWidth, Platform.OS === 'ios' && status.reportAvailable === true) }} />
        </View>
      : <Text style={{ color: c.inkSoft, fontSize: 13, lineHeight: 20 }}>{status.selection.applications} apps · {status.selection.categories} categories · {status.selection.webDomains} sites. Update the installed app to see icons here.</Text>}
  </View>;
}

export function DailyTimeProgress({ status }: { status: ScreenTimeStatus }) {
  const c = useAppColors();
  const progress = remainingDailyTime(status);
  if (!status.blockingEnabled || status.mode !== 'daily' || (Platform.OS === 'ios' && status.reportAvailable === true)) return null;
  const noticeStyle = { color: c.inkSoft, fontSize: 13, lineHeight: 20, padding: Space.md,
    backgroundColor: c.woolDeep, borderWidth: 1, borderColor: c.seam, borderRadius: Radius.fold };
  if (!screenTimeAccessReady(status, Platform.OS)) return <Text style={noticeStyle}>Restore app access before relying on your saved limit. Remaining time cannot be confirmed.</Text>;
  // status.dailyUsageNote already reports this, right under the summary. Saying
  // it again in a bordered card was the same sentence twice on one screen.
  if (!progress) return status.dailyUsageNote ? null
    : <Text style={noticeStyle}>Time left isn’t available on this device. Your limit still applies.</Text>;
  const combined = status.limitMode === 'perApp';
  const label = combined ? 'Combined remaining allowance across individual app limits' : 'Total daily time remaining';
  const remainingLabel = `${Math.ceil(progress.remaining)} minutes left${combined ? ' across separate app allowances; not transferable between apps' : ''}`;
  return <View style={{ gap: 12, padding: Space.md, borderRadius: Radius.fold,
    borderWidth: 1, borderColor: c.seam, backgroundColor: c.wool }}>
    <Text style={{ color: c.ink, fontSize: 24, lineHeight: 31, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{Math.ceil(progress.remaining)} of {progress.total} min{combined ? ' combined' : ''} left today</Text>
    {combined && <Text style={{ color: c.inkSoft, fontSize: 13, lineHeight: 19 }}>This adds up separate allowances; it is not one pool of time. An app can be blocked while another still has time.</Text>}
    <View accessibilityRole="progressbar" accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: progress.total, now: progress.remaining, text: remainingLabel }}
      aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.remaining}
      aria-valuetext={remainingLabel}
      style={{ height: 10, borderRadius: 5, backgroundColor: c.seam, overflow: 'hidden' }}>
      <View style={{ width: `${progress.fraction * 100}%`, height: '100%', borderRadius: 5, backgroundColor: c.ember }} />
    </View>
    {status.temporaryAccessExpiresAt && <Text style={{ color: c.inkSoft, fontSize: 12 }}>Extra time is separate from your daily allowance.</Text>}
  </View>;
}
