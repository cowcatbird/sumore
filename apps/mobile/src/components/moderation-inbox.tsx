import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, Text, View } from 'react-native';

import { ActionButton, FormSheet } from '@/components/form-sheet';
import { KeyboardTextInput } from '@/components/keyboard-form';
import { formControlStyle } from '@/constants/form-layout';
import { Radius, Space, Type, useAppColors } from '@/constants/theme';
import { useApp } from '@/features/app-store';
import { useModeration } from '@/features/moderation-store';
import { getModerationQueue, reviewModerationReport, type ModerationReport } from '@/services/moderation';

type QueueFilter = 'open' | 'resolved' | 'dismissed';
type QueueCursor = { createdAt: string; id: string };
type ReviewAction = 'dismiss' | 'remove_content' | 'warn' | 'restrict' | 'restore';
const labels: Record<ReviewAction, string> = {
  dismiss: 'Dismiss report', remove_content: 'Remove reported content', warn: 'Send warning',
  restrict: 'Restrict social features', restore: 'Restore social features',
};
const descriptions: Record<ReviewAction, string> = {
  dismiss: 'Close this report without taking action against the person.',
  remove_content: 'Remove only the reported shared text if it still matches the report. This does not delete their account or decide a time request.',
  warn: 'Send the person your message and close this report. A warning does not restrict their account.',
  restrict: 'Temporarily prevent social actions. Personal screen-time controls, emergency access, reporting, recovery, and account deletion remain available.',
  restore: 'Lift this person’s current social restriction. Removed content is not restored.',
};
const reasonLabels: Record<string, string> = {
  offensive_content: 'Offensive content', harassment: 'Harassment', spam: 'Spam', other: 'Other concern',
};

export function moderationActions(report: ModerationReport): ReviewAction[] {
  if (report.status !== 'open') return report.targetUserId && report.action === 'restrict' ? ['restore'] : [];
  return report.targetUserId ? ['dismiss', 'remove_content', 'warn', 'restrict'] : ['dismiss'];
}

/** Render only documented shared fields, never an arbitrary server object. */
export function reportedAppLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.label !== 'string') return [];
    const label = entry.label.slice(0, 100);
    return [Number.isInteger(entry.minutes) && entry.minutes >= 1 && entry.minutes <= 1440
      ? `${label} · ${entry.minutes} min` : label];
  });
}

export function ModerationInbox() {
  const { profile } = useApp();
  const { status, loading, error, refresh, preview } = useModeration();
  const c = useAppColors();
  // Hide the report UI while inactive/backgrounded. Returning to the app also
  // replaces the queue session and rechecks server access.
  const [foreground, setForeground] = useState(!AppState.currentState || AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      setForeground(state === 'active');
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  if (preview) return <Text style={{ ...Type.body, color: c.inkSoft }}>The private review inbox is only available to authorized moderators in the connected app.</Text>;
  if (!foreground) return null;
  if (loading) return <ActivityIndicator accessibilityLabel="Checking moderator access" color={c.ember} />;
  if (error || !status) return <View style={{ gap: Space.md }}>
    <Text accessibilityRole="alert" style={{ ...Type.body, color: c.inkSoft }}>{error || 'Moderator access could not be confirmed.'}</Text>
    <ActionButton label="Check access" onPress={() => { void refresh(); }} />
  </View>;
  if (!status.isModerator) return <Text style={{ ...Type.body, color: c.inkSoft }}>This account does not have access to community review.</Text>;
  return <QueueSession key={profile.id} ownerId={profile.id} />;
}

function QueueSession({ ownerId }: { ownerId: string }) {
  const c = useAppColors();
  const [filter, setFilter] = useState<QueueFilter>('open');
  const [cursors, setCursors] = useState<(QueueCursor | null)[]>([null]);
  const cursor = cursors[cursors.length - 1];
  const [queue, setQueue] = useState<{ filter: QueueFilter; cursor: QueueCursor | null; reports: ModerationReport[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ report: ModerationReport; action: ReviewAction } | null>(null);
  const [note, setNote] = useState('');
  const [days, setDays] = useState(7);
  const active = useRef(false);
  const requestVersion = useRef(0);
  const submitting = useRef(false);
  const currentSelection = useRef(selection);
  useLayoutEffect(() => { currentSelection.current = selection; });
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; requestVersion.current += 1; };
  }, []);

  const readQueue = useCallback(async (version: number) => {
    try {
      const reports = cursor ? await getModerationQueue(ownerId, filter, cursor) : await getModerationQueue(ownerId, filter);
      if (active.current && requestVersion.current === version) setQueue({ filter, cursor, reports });
    } catch (caught) {
      if (active.current && requestVersion.current === version) setError(caught instanceof Error ? caught.message : 'Reports could not be loaded. Try again.');
    } finally {
      if (active.current && requestVersion.current === version) setLoading(false);
    }
  }, [ownerId, filter, cursor]);
  const loadQueue = async (clearError = true) => {
    if (!active.current) return;
    const version = ++requestVersion.current;
    setQueue(null); setLoading(true);
    if (clearError) setError(null);
    await readQueue(version);
  };
  useEffect(() => { void readQueue(++requestVersion.current); }, [readQueue]);

  const chooseAction = (report: ModerationReport, action: ReviewAction) => {
    if (!active.current || submitting.current || loading || !moderationActions(report).includes(action)) return;
    const next = { report, action };
    currentSelection.current = next;
    setSelection(next); setNote(''); setDays(7); setError(null); setNotice(null);
  };
  const closeSelection = () => { currentSelection.current = null; setSelection(null); setNote(''); };
  const changePage = (direction: 'next' | 'previous') => {
    if (!active.current || submitting.current || loading) return;
    const last = queue?.reports[queue.reports.length - 1];
    if (direction === 'next'
      ? queue?.filter !== filter || queue.cursor !== cursor || queue.reports.length < 100 || !last
      : cursors.length < 2) return;
    requestVersion.current += 1; closeSelection(); setNotice(null); setQueue(null); setLoading(true); setError(null);
    setCursors(direction === 'next' && last ? [...cursors, { createdAt: last.createdAt, id: last.id }] : cursors.slice(0, -1));
  };
  const confirm = async () => {
    if (!active.current || submitting.current || !selection || currentSelection.current !== selection) return;
    const { report, action } = selection;
    if (!queue?.reports.some(row => row.id === report.id && row.version === report.version)
      || !moderationActions(report).includes(action) || note.trim().length > 500
      || ((action === 'warn' || action === 'restrict' || action === 'restore') && !note.trim())) return;
    submitting.current = true; setWorking(true); setError(null); setNotice(null);
    try {
      await reviewModerationReport(ownerId, {
        reportId: report.id, expectedVersion: report.version, action, moderatorNote: note.trim(),
        restrictionDays: action === 'restrict' ? days : null,
      });
      if (!active.current) return;
      closeSelection();
      setNotice('Review saved.');
      await loadQueue();
    } catch (caught) {
      if (!active.current) return;
      closeSelection();
      setError(caught instanceof Error ? caught.message : 'The review could not be confirmed. Refresh the queue before trying again.');
      // Refresh data after a conflict or uncertain timeout; never retry the
      // action itself or reuse an old report version automatically.
      await loadQueue(false);
    } finally {
      submitting.current = false;
      if (active.current) setWorking(false);
    }
  };
  const reports = queue?.filter === filter && queue.cursor === cursor ? queue.reports : [];
  const noteRequired = selection?.action === 'warn' || selection?.action === 'restrict' || selection?.action === 'restore';
  const surface = { padding: Space.md, borderRadius: Radius.blanket, borderWidth: 1, borderColor: c.seam, backgroundColor: c.wool, gap: Space.md };
  return <View style={{ gap: Space.lg }}>
    <Text style={{ ...Type.bodySmall, color: c.inkSoft }}>Review each report yourself. A report is an allegation, not proof. Report counts never trigger penalties automatically.</Text>
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: c.seam, gap: Space.sm }}>
      {(['open', 'resolved', 'dismissed'] as const).map(value => <Pressable key={value} accessibilityRole="tab"
        accessibilityLabel={`${value[0].toUpperCase()}${value.slice(1)} reports`} accessibilityState={{ selected: value === filter, disabled: working }}
        disabled={working} onPress={() => { if (!submitting.current && value !== filter) {
          requestVersion.current += 1; closeSelection(); setNotice(null); setQueue(null); setLoading(true); setError(null); setCursors([null]); setFilter(value);
        } }}
        style={({ pressed }) => ({ flex: 1, minHeight: 48, padding: Space.xs, alignItems: 'center', justifyContent: 'center',
          borderBottomWidth: 3, borderBottomColor: value === filter ? c.ember : 'transparent', opacity: working ? 0.55 : pressed ? 0.86 : 1 })}>
        <Text style={{ ...Type.control, color: value === filter ? c.ember : c.inkSoft, textAlign: 'center' }}>{value[0].toUpperCase()}{value.slice(1)}</Text>
      </Pressable>)}
    </View>
    <View style={{ gap: Space.xs }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: Space.sm }}>
        <Text style={{ ...Type.bodySmall, color: c.inkSoft }}>Page {cursors.length} · up to 100 reports per page</Text>
        <QueueAction label={loading ? 'Refreshing reports…' : 'Refresh reports'} disabled={loading || working}
          onPress={() => { if (!submitting.current) { closeSelection(); void loadQueue(); } }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: Space.sm }}>
        <QueueAction label="Previous page" disabled={loading || working || cursors.length < 2} onPress={() => changePage('previous')} />
        <QueueAction label="Next page" disabled={loading || working || reports.length < 100} onPress={() => changePage('next')} />
      </View>
    </View>
    {error && <Text accessibilityRole="alert" style={{ ...Type.bodySmall, color: c.scarlet, backgroundColor: c.emberWash, padding: Space.sm, borderRadius: Radius.tin }}>{error}</Text>}
    {notice && <Text accessibilityLiveRegion="polite" style={{ ...Type.bodySmall, color: c.emerald }}>{notice}</Text>}
    {loading ? <ActivityIndicator accessibilityLabel="Loading reports" color={c.ember} /> : !error && reports.length === 0
      ? <Text style={{ ...Type.body, color: c.inkSoft }}>No {filter} reports{cursors.length > 1 ? ' on this page. Go back to an earlier page or refresh.' : '.'}</Text> : null}
    {reports.map(report => <View key={`${report.id}:${report.version}`} style={surface}>
      <View style={{ gap: Space.xs }}>
        <Text accessibilityRole="header" style={{ ...Type.heading, color: c.ink }}>{report.targetDisplayName}</Text>
        <Text style={{ ...Type.bodySmall, color: c.inkSoft }}>{reasonLabels[report.reason] || 'Reported concern'} · {new Date(report.createdAt).toLocaleDateString()}</Text>
      </View>
      {!report.targetUserId && <Text style={{ ...Type.bodySmall, color: c.inkSoft }}>This account has been deleted.{report.status === 'open' ? ' Only dismissing the report is available.' : ' No account actions are available.'}</Text>}
      <ReportSnapshot report={report} />
      <View style={{ gap: Space.xs }}>
        <Text style={{ ...Type.control, color: c.ink }}>Reporter’s explanation</Text>
        <Text selectable style={{ ...Type.body, color: c.inkSoft }}>{report.details || 'No additional details.'}</Text>
      </View>
      <Text selectable style={{ ...Type.bodySmall, color: c.inkSoft }}>Report {report.id} · revision {report.version}{report.action ? ` · ${labels[report.action as ReviewAction] || 'Reviewed'}` : ''}</Text>
      {moderationActions(report).length > 0 && <View style={{ borderTopWidth: 1, borderTopColor: c.seam, paddingTop: Space.sm, gap: Space.sm }}>
        {moderationActions(report).map(action => <ActionButton key={action} label={labels[action]} disabled={working || loading}
          onPress={() => chooseAction(report, action)} danger={action === 'restrict' || action === 'remove_content'} />)}
      </View>}
    </View>)}
    <FormSheet title={selection ? labels[selection.action] : 'Review report'} visible={!!selection} busy={working}
      onClose={() => { if (!submitting.current) closeSelection(); }}>
      {selection && <>
        <Text style={{ ...Type.heading, color: c.ink }}>{selection.report.targetDisplayName}</Text>
        <Text style={{ ...Type.body, color: c.inkSoft }}>{descriptions[selection.action]}</Text>
        {selection.action === 'remove_content' && <Text style={{ ...Type.body, color: c.ink }}>
          {selection.report.kind === 'person'
            ? 'This replaces the captured display name with “Camper” and clears all captured optional shared app labels, only if they are still unchanged.'
            : 'This clears the captured request note and category only if unchanged. Its minutes, approval, and any granted time stay unchanged.'}
        </Text>}
        <ReportSnapshot report={selection.report} />
        {selection.action === 'restrict' && <View style={{ gap: Space.sm }}>
          <Text style={{ ...Type.control, color: c.ink }}>Restriction length</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm }}>
            {[1, 7, 30].map(value => <Pressable key={value} accessibilityRole="radio" accessibilityLabel={`${value} ${value === 1 ? 'day' : 'days'}`}
              accessibilityState={{ selected: days === value, disabled: working }} disabled={working} onPress={() => setDays(value)}
              style={({ pressed }) => ({ ...formControlStyle, flex: 1, minWidth: 80, alignItems: 'center', borderWidth: 1,
                borderColor: days === value ? c.ember : c.seam, backgroundColor: days === value ? c.emberWash : c.wool,
                opacity: working ? 0.55 : pressed ? 0.86 : 1 })}>
              <Text style={{ ...Type.control, color: days === value ? c.ember : c.ink, textAlign: 'center' }}>{value} {value === 1 ? 'day' : 'days'}</Text>
            </Pressable>)}
          </View>
        </View>}
        <Text style={{ ...Type.control, color: c.ink }}>{noteRequired ? 'Message to this person (required)' : 'Review note (optional)'}</Text>
        <Text style={{ ...Type.bodySmall, color: c.inkSoft }}>Explain the rule and decision. Do not include the reporter’s identity or private information.{noteRequired ? ' The person will see this message and can appeal to support.' : ''}</Text>
        <KeyboardTextInput accessibilityLabel="Moderator review message" multiline textAlignVertical="top" editable={!working}
          value={note} onChangeText={setNote} maxLength={500} placeholder="Reason for this decision" placeholderTextColor={c.inkSoft}
          selectionColor={c.ember}
          style={{ ...formControlStyle, ...Type.body, minHeight: 120, color: c.ink, backgroundColor: c.woolDeep, borderWidth: 1, borderColor: c.seam }} />
        <Text style={{ ...Type.meter, color: c.inkSoft, alignSelf: 'flex-end' }}>{note.length}/500</Text>
        <ActionButton label={working ? 'Saving review…' : `Confirm: ${labels[selection.action].toLowerCase()}`} primary
          disabled={working || (noteRequired && !note.trim()) || note.trim().length > 500} onPress={() => { void confirm(); }} />
      </>}
    </FormSheet>
  </View>;
}

/** Keep queue navigation quiet without reducing its touch target. */
function QueueAction({ label, disabled, onPress }: { label: string; disabled: boolean; onPress: () => void }) {
  const c = useAppColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: Space.xs, paddingVertical: Space.sm, justifyContent: 'center',
      borderRadius: Radius.tin, backgroundColor: pressed && !disabled ? c.woolDeep : 'transparent', opacity: disabled ? 0.55 : 1 })}>
    <Text style={{ ...Type.bodySmall, fontWeight: '700', color: disabled ? c.inkSoft : c.ember }}>{label}</Text>
  </Pressable>;
}

function ReportSnapshot({ report }: { report: ModerationReport }) {
  const c = useAppColors();
  const sharedLabels = reportedAppLabels(report.snapshot.sharedLabels);
  return <View style={{ gap: Space.xs, padding: Space.md, backgroundColor: c.woolDeep, borderRadius: Radius.fold }}>
    <Text style={{ ...Type.control, color: c.ink }}>Shared content when reported</Text>
    <Text selectable style={{ ...Type.body, color: c.inkSoft }}>Name: {report.snapshot.displayName}</Text>
    {report.kind === 'request' && <Text selectable style={{ ...Type.body, color: c.inkSoft }}>Request note: {report.snapshot.requestReason || 'No note.'}</Text>}
    {report.kind === 'request' && report.snapshot.requestCategoryLabel && <Text selectable style={{ ...Type.body, color: c.inkSoft }}>Request category: {report.snapshot.requestCategoryLabel}</Text>}
    {sharedLabels.length > 0 && <Text selectable style={{ ...Type.body, color: c.inkSoft }}>Shared app labels: {sharedLabels.join(', ')}</Text>}
    <Text style={{ ...Type.bodySmall, color: c.inkSoft }}>A saved snapshot, not necessarily what is visible now.</Text>
  </View>;
}
