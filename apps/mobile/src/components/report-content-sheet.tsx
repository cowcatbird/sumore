import * as Crypto from 'expo-crypto';
import * as Clipboard from 'expo-clipboard';
import { useLayoutEffect, useRef, useState } from 'react';
import { Keyboard, Pressable, Text, View, type TextStyle, type ViewStyle } from 'react-native';

import { ActionButton, FormSheet } from '@/components/form-sheet';
import { KeyboardTextInput } from '@/components/keyboard-form';
import { FormLayout, formControlStyle } from '@/constants/form-layout';
import { Radius, Space, Type, useAppColors } from '@/constants/theme';
import { useApp } from '@/features/app-store';
import { useModeration, type ReportTarget } from '@/features/moderation-store';
import { communityReportEmail, openCommunityReportEmail, type ReportEmailResult } from '@/services/moderation-email';

const reasons = [
  ['offensive_content', 'Offensive name or app label'],
  ['harassment', 'Harassment or threats'],
  ['spam', 'Spam'],
  ['other', 'Something else'],
] as const;
type Reason = (typeof reasons)[number][0];
type SavedReportEmail = { reportId: string; targetDisplayName: string; kind: 'person' | 'request'; reason: Reason; details: string };
const emailResultText: Record<ReportEmailResult, string> = {
  opened: 'Finish reviewing and sending in your email app. Delivery to support is not confirmed.',
  cancelled: 'Email cancelled. Your private report reference is saved, but no email was confirmed sent.',
  saved: 'Draft saved in your email app. Send it when you’re ready. Delivery to support is not confirmed.',
  accepted: 'Your email app accepted the send request. Delivery to support is not confirmed.',
};

/** Embeddable inside an existing sheet: never opens another native modal. */
export function ReportContentForm({ target, onBusyChange, onBlock, onDone }: {
  target: ReportTarget; onBusyChange: (busy: boolean) => void; onBlock?: () => void; onDone: () => void;
}) {
  const { profile, circleShop } = useApp();
  const moderation = useModeration();
  const c = useAppColors();
  const [reason, setReason] = useState<Reason | null>(null);
  const [detail, setDetail] = useState('');
  const [pending, setPending] = useState(false);
  const [copying, setCopying] = useState(false);
  const [draftFrozen, setDraftFrozen] = useState(false);
  const [savedEmail, setSavedEmail] = useState<SavedReportEmail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const receipt = useRef<string | null>(null);
  const submittedDraft = useRef<{ reason: Reason; detail: string } | null>(null);
  const savedEmailRef = useRef<SavedReportEmail | null>(null);
  const mounted = useRef(false);
  const [identity] = useState(() => ({ ownerId: profile.id, groupId: circleShop?.id,
    targetUserId: target.targetUserId, requestId: target.requestId, kind: target.kind }));
  const current = useRef({ ownerId: profile.id, groupId: circleShop?.id, target, preview: moderation.preview });
  useLayoutEffect(() => { current.current = { ownerId: profile.id, groupId: circleShop?.id, target, preview: moderation.preview }; });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const stale = target.ownerId !== profile.id || identity.ownerId !== profile.id || identity.groupId !== circleShop?.id
    || target.circleId !== circleShop?.id || identity.targetUserId !== target.targetUserId
    || identity.requestId !== target.requestId || identity.kind !== target.kind;
  const isCurrent = () => mounted.current && !current.current.preview
    && current.current.ownerId === identity.ownerId && current.current.groupId === identity.groupId
    && current.current.target.ownerId === identity.ownerId && current.current.target.circleId === identity.groupId
    && current.current.target.targetUserId === identity.targetUserId && current.current.target.requestId === identity.requestId
    && current.current.target.kind === identity.kind;
  const body = { ...Type.bodySmall, color: c.inkSoft };
  const submit = async () => {
    if (submitting.current || !reason || moderation.preview || !mounted.current) return;
    if (!isCurrent()) { setError('Your account or circle changed. Close this sheet and choose the content again.'); return; }
    submitting.current = true; setPending(true); onBusyChange(true); setError(null); setNotice(null); Keyboard.dismiss();
    try {
      if (!savedEmailRef.current) {
        receipt.current ??= Crypto.randomUUID();
        submittedDraft.current ??= { reason, detail: detail.trim() };
        setDraftFrozen(true);
        const saved = await moderation.report(target, submittedDraft.current.reason, submittedDraft.current.detail, receipt.current);
        if (!isCurrent()) return;
        savedEmailRef.current = { reportId: saved.reportId, targetDisplayName: target.displayName, kind: target.kind,
          reason: submittedDraft.current.reason, details: submittedDraft.current.detail };
        setSavedEmail(savedEmailRef.current);
      }
      if (!isCurrent()) return;
      const result = await openCommunityReportEmail(savedEmailRef.current, isCurrent);
      if (isCurrent()) setNotice(emailResultText[result]);
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : savedEmailRef.current
        ? 'Could not open your email app. Your report reference is saved; reopen the email or copy its details.'
        : 'Your report could not be confirmed. Please try again later.');
    } finally {
      submitting.current = false;
      if (mounted.current) { setPending(false); onBusyChange(false); }
    }
  };
  const copyEmail = async () => {
    if (submitting.current || !isCurrent() || !savedEmailRef.current) return;
    submitting.current = true; setPending(true); setCopying(true); onBusyChange(true); setError(null);
    try {
      const email = communityReportEmail(savedEmailRef.current);
      await Clipboard.setStringAsync(`To: ${email.recipients.join(', ')}\nSubject: ${email.subject}\n\n${email.body}`);
      if (isCurrent()) setNotice('Copied email details. Paste them into an email to cowcatbird.dev@gmail.com and send it yourself. Nothing was emailed automatically.');
    } catch {
      if (isCurrent()) setError('Could not copy the email. Contact cowcatbird.dev@gmail.com and include the report reference shown here.');
    } finally {
      submitting.current = false;
      if (mounted.current) { setPending(false); setCopying(false); onBusyChange(false); }
    }
  };
  if (savedEmail) return <>
    <View style={[styles.receipt, { backgroundColor: c.wool, borderColor: c.seam }]}>
      <Text accessibilityLiveRegion="polite" style={{ ...Type.control, color: c.ink }}>A private copy of this report is saved for review.</Text>
      <Text selectable style={{ ...Type.meter, color: c.inkSoft }}>Report reference: {savedEmail.reportId}</Text>
    </View>
    <Text style={body}>No email is sent automatically. Review the draft addressed to cowcatbird.dev@gmail.com, then send it from your email app. Support can see your email address; it is not shown to the person you report.</Text>
    {notice && <Text accessibilityLiveRegion="polite" style={body}>{notice}</Text>}
    {error && <Text accessibilityRole="alert" style={{ ...body, color: c.scarlet }}>{error}</Text>}
    {stale && <Text accessibilityRole="alert" style={{ ...body, color: c.scarlet }}>Your account or circle changed. Close this sheet before continuing.</Text>}
    <ActionButton label={pending && !copying ? 'Opening report email…' : 'Reopen report email'} primary disabled={pending || stale || moderation.preview} onPress={() => { void submit(); }} />
    <ActionButton label={copying ? 'Copying email details…' : 'Copy email details'} disabled={pending || stale || moderation.preview} onPress={() => { void copyEmail(); }} />
    <Text style={body}>Reporting does not automatically block this person or punish their account.</Text>
    {!onBlock && <Text style={body}>To block this person, open their options in Circle. Blocking also leaves their circle.</Text>}
    {onBlock && <ActionButton label={`Block ${target.displayName}`} danger disabled={pending || stale} onPress={() => { if (!submitting.current && isCurrent()) onBlock(); }} />}
    <ActionButton label="Done" disabled={pending} onPress={() => { if (!submitting.current) onDone(); }} />
  </>;
  return <>
    <View style={styles.copy}>
      <Text style={{ ...Type.body, color: c.ink }}>Report {target.kind === 'request' ? 'this request' : target.displayName}. Your identity stays private from the person you report.</Text>
      <Text style={body}>We’ll save a private copy and open an email to cowcatbird.dev@gmail.com for you to review and send. Support can see your email address. Don’t include login keys or anyone’s private information.</Text>
    </View>
    <View style={styles.field}>
      <Text accessibilityRole="header" style={{ ...Type.control, color: c.ink }}>Reason</Text>
      <View accessibilityRole="radiogroup" style={[styles.reasons, { borderColor: c.seam, backgroundColor: c.wool }]}>
        {reasons.map(([value, label], index) => <Pressable key={value} accessibilityRole="radio"
          accessibilityLabel={value === 'offensive_content' && target.kind === 'request' ? 'Offensive request text' : label}
          accessibilityState={{ selected: reason === value, disabled: pending || draftFrozen }}
          disabled={pending || draftFrozen} onPress={() => setReason(value)}
          style={({ pressed }) => [styles.reason, index < reasons.length - 1 && styles.reasonSeam,
            { borderColor: c.seam, backgroundColor: reason === value || pressed ? c.emberWash : c.wool }]}>
          <View accessible={false} style={[styles.radio, { borderColor: reason === value ? c.ember : c.edge }]}>
            {reason === value && <View style={[styles.radioDot, { backgroundColor: c.ember }]} />}
          </View>
          <Text style={[styles.reasonLabel, { color: c.ink }]}>{value === 'offensive_content' && target.kind === 'request' ? 'Offensive request text' : label}</Text>
        </Pressable>)}
      </View>
    </View>
    <View style={styles.field}>
      <Text accessibilityRole="header" style={{ ...Type.control, color: c.ink }}>Details <Text style={body}>(optional)</Text></Text>
      <KeyboardTextInput accessibilityLabel="Report details (optional)" multiline maxLength={500}
        value={detail} onChangeText={setDetail} editable={!pending && !draftFrozen} placeholder="Anything else we should know? (optional)"
        placeholderTextColor={c.inkSoft} textAlignVertical="top"
        style={[styles.details, { borderColor: c.seam, backgroundColor: c.wool, color: c.ink }]} />
      <Text style={[styles.counter, { color: c.inkSoft }]}>{detail.length}/500</Text>
    </View>
    {moderation.preview && <Text style={body}>This browser cannot save real moderation reports or open report emails. No report will be sent.</Text>}
    {stale && <Text accessibilityRole="alert" style={{ ...body, color: c.scarlet }}>Your account or circle changed. Close this sheet and choose the content again.</Text>}
    {error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ ...body, color: c.scarlet }}>{error}</Text>}
    {error && draftFrozen && <Text style={body}>Retry sends the same report with the same receipt, so it is not counted twice. Close and reopen to change your draft.</Text>}
    <ActionButton label={pending ? 'Preparing report email…' : error && draftFrozen ? 'Retry same report' : 'Open report email'} primary
      disabled={pending || !reason || stale || moderation.preview} onPress={() => { void submit(); }} />
  </>;
}

/** Request reports get their own sheet; member reports reuse the member sheet. */
export function ReportContentSheet({ target, onClose }: { target: ReportTarget | null; onClose: () => void }) {
  const { profile, circleShop } = useApp();
  if (!target || target.ownerId !== profile.id || target.circleId !== circleShop?.id) return null;
  return <ActiveReportSheet key={`${target.ownerId}:${target.circleId}:${target.requestId ?? target.targetUserId}`} target={target} onClose={onClose} />;
}

function ActiveReportSheet({ target, onClose }: { target: ReportTarget; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const close = () => { if (!submitting.current) onClose(); };
  return <FormSheet title="Report request" visible onClose={close} busy={busy}>
    <ReportContentForm target={target} onBusyChange={value => { submitting.current = value; setBusy(value); }} onDone={close} />
  </FormSheet>;
}

const styles = {
  copy: { gap: Space.xs },
  field: { gap: Space.xs },
  receipt: { gap: Space.xs, padding: Space.md, borderWidth: 1, borderRadius: Radius.fold },
  reasons: { borderWidth: 1, borderRadius: Radius.fold, overflow: 'hidden' },
  reason: {
    minHeight: FormLayout.controlHeight,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  reasonSeam: { borderBottomWidth: 1 },
  reasonLabel: { ...Type.body, flex: 1 },
  radio: { width: 20, height: 20, borderRadius: Radius.coal, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 8, height: 8, borderRadius: Radius.coal },
  details: { ...formControlStyle, ...Type.body, minHeight: 120, maxHeight: 200, borderWidth: 1 },
  counter: { ...Type.meter, textAlign: 'right' },
} satisfies Record<string, TextStyle | ViewStyle>;
