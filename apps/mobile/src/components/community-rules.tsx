import { useLayoutEffect, useRef, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import { ActionButton, FormSheet } from '@/components/form-sheet';
import { SettingsActionRow } from '@/components/settings-action-row';
import { formControlStyle } from '@/constants/form-layout';
import { Radius, Space, Type, useAppColors } from '@/constants/theme';
import { useApp } from '@/features/app-store';
import { useModeration } from '@/features/moderation-store';
import { COMMUNITY_RULES_VERSION } from '@/services/moderation';

const rules = [
  'Keep your circle kind. No harassment, threats, hateful language, sexual content, impersonation, or spam.',
  'Do not share someone else’s private information. Keep login keys private, including in reports.',
  'Use names, app labels, and request notes respectfully. Clearly abusive wording may be rejected before sharing.',
  'You can report a person or request and block people in Circle. Reports are reviewed privately, not shown to the person reported. Do not misuse reports to target someone.',
  'Content that breaks these rules may be removed. Repeated or serious abuse may restrict social features. Report counts alone never decide a penalty.',
] as const;
const ruleHeadings = ['Be kind', 'Respect privacy', 'Share thoughtfully', 'Look out for each other', 'Keep it fair'] as const;

/** Readable and dismissible; never gates device controls or account deletion. */
export function CommunityRulesSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { profile } = useApp();
  return <RulesForAccount key={`${profile.id}:${visible ? 'open' : 'closed'}`} visible={visible} onClose={onClose} />;
}

function RulesForAccount({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const c = useAppColors();
  const moderation = useModeration();
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const active = useRef(false);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const accepted = !!moderation.status && moderation.status.acceptedRulesVersion === moderation.status.rulesVersion;
  const rulesChanged = !!moderation.status && moderation.status.rulesVersion !== COMMUNITY_RULES_VERSION;
  const body = { ...Type.bodySmall, color: c.inkSoft };
  const accept = async () => {
    if (!checked || submitting.current || accepted || moderation.preview) return;
    submitting.current = true; setError(null);
    try { await moderation.acceptRules(); }
    catch (caught) { if (active.current) setError(caught instanceof Error ? caught.message : 'Acceptance could not be confirmed. Refresh before trying again.'); }
    finally { submitting.current = false; }
  };
  return <FormSheet title="Community rules" visible={visible} onClose={() => { if (!submitting.current) onClose(); }} busy={moderation.accepting}>
    <Text style={{ ...Type.heading, color: c.ink }}>A little kindness around the campfire.</Text>
    <View>
      {rules.map((rule, index) => <View key={rule} style={{ paddingVertical: Space.md, gap: Space.xs,
        borderBottomWidth: index < rules.length - 1 ? 1 : 0, borderBottomColor: c.seam }}>
        <Text accessibilityRole="header" style={{ ...Type.control, color: c.ink }}>{ruleHeadings[index]}</Text>
        <Text style={body}>{rule}</Text>
      </View>)}
    </View>
    <View style={{ padding: Space.md, gap: Space.xs, borderRadius: Radius.fold, backgroundColor: c.woolDeep }}>
      <Text style={{ ...Type.control, color: c.ink }}>Your personal controls stay yours</Text>
      <Text style={body}>You can still manage this phone’s limits, use emergency access, leave or block a circle member, and delete your account if social features are restricted.</Text>
    </View>
    <Text style={body}>Questions or appeals: cowcatbird.dev@gmail.com</Text>
    {moderation.preview && <Text style={body}>You can read the rules here. Acceptance and report sending are unavailable in this browser; nothing is sent to the server.</Text>}
    {moderation.loading && <Text accessibilityLiveRegion="polite" style={body}>Checking community status…</Text>}
    {rulesChanged && <Text accessibilityRole="alert" style={{ ...body, color: c.scarlet }}>The community rules changed. Update sumore before accepting them.</Text>}
    {moderation.error && <>
      <Text accessibilityRole="alert" style={{ ...body, color: c.scarlet }}>{moderation.error}</Text>
      <ActionButton label="Refresh community status" disabled={moderation.loading || moderation.accepting} onPress={() => { void moderation.refresh(); }} />
    </>}
    {accepted ? <Text accessibilityLiveRegion="polite" style={{ ...body, color: c.emerald }}>You’ve accepted the current community rules.</Text> : <>
      <Pressable accessibilityRole="checkbox" accessibilityLabel="I agree to the community rules"
        accessibilityState={{ checked, disabled: moderation.accepting || moderation.preview }} disabled={moderation.accepting || moderation.preview}
        onPress={() => setChecked(value => !value)}
        style={({ pressed }) => ({ ...formControlStyle, flexDirection: 'row', gap: Space.sm, alignItems: 'center',
          backgroundColor: checked ? c.emberWash : c.wool, borderColor: checked ? c.ember : c.seam, borderWidth: 1,
          opacity: moderation.accepting || moderation.preview ? 0.55 : pressed ? 0.86 : 1 })}>
        <View accessible={false} style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 1.5,
          borderColor: checked ? c.ember : c.edge, backgroundColor: checked ? c.ember : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
          {checked && <View style={{ width: 7, height: 12, borderRightWidth: 2, borderBottomWidth: 2, borderColor: c.onFlame, transform: [{ rotate: '45deg' }], marginTop: -3 }} />}
        </View>
        <Text style={{ ...Type.control, color: c.ink, flex: 1 }}>I agree to the community rules</Text>
      </Pressable>
      <ActionButton label={moderation.accepting ? 'Saving acceptance…' : 'Accept community rules'} primary
        disabled={!checked || !moderation.status || moderation.accepting || moderation.loading || !!moderation.error || moderation.preview || rulesChanged}
        onPress={() => { void accept(); }} />
      <Text style={body}>Acceptance is only needed for social sharing. Your personal controls remain available.</Text>
    </>}
    {error && <Text accessibilityRole="alert" style={{ ...body, color: c.scarlet }}>{error}</Text>}
  </FormSheet>;
}

export function CommunityRulesButton() {
  const { profile } = useApp();
  return <ButtonForAccount key={profile.id} />;
}

function ButtonForAccount() {
  const [open, setOpen] = useState(false);
  return <View>
    <SettingsActionRow label="Community rules" icon={{ ios: 'hand.raised', android: 'verified_user', web: 'verified_user' }} onPress={() => setOpen(true)} />
    <CommunityRulesSheet visible={open} onClose={() => setOpen(false)} />
  </View>;
}

export function CommunityRulesNotice() {
  const { profile } = useApp();
  return <NoticeForAccount key={profile.id} />;
}

function NoticeForAccount() {
  const moderation = useModeration();
  const c = useAppColors();
  const [open, setOpen] = useState(false);
  const [appealError, setAppealError] = useState<string | null>(null);
  const accepted = !!moderation.status && moderation.status.acceptedRulesVersion === moderation.status.rulesVersion;
  const restriction = moderation.status?.restriction;
  const notices = moderation.status?.notices ?? [];
  const body = { ...Type.bodySmall, color: c.inkSoft };
  const appeal = async () => {
    setAppealError(null);
    try { await Linking.openURL('mailto:cowcatbird.dev@gmail.com?subject=Community%20moderation%20appeal'); }
    catch { setAppealError('Could not open email. Contact cowcatbird.dev@gmail.com to appeal. Do not send your login key.'); }
  };
  if (accepted && !restriction && notices.length === 0 && !moderation.error) return null;
  return <View style={{ padding: Space.md, borderRadius: Radius.blanket, backgroundColor: c.wool,
    borderTopWidth: 2, borderTopColor: restriction ? c.scarlet : c.edge, gap: Space.xs }}>
    <Text accessibilityRole="header" style={{ ...Type.control, color: c.ink }}>{restriction ? 'Social sharing is paused' : notices.length ? 'Community update' : 'Keep your circle kind'}</Text>
    {restriction && <>
      <Text style={body}>{restriction.reason}</Text>
      <Text style={body}>{restriction.until ? `Until ${new Date(restriction.until).toLocaleString()}.` : 'Contact support if you believe this is a mistake.'}</Text>
      <Text style={body}>Your personal limits, emergency access, leave/block controls, and account deletion are still available.</Text>
    </>}
    {notices.map(notice => <Text key={notice.id} style={body}>{notice.message}</Text>)}
    {!accepted && <Text style={body}>{moderation.preview
      ? 'Read the community rules. Reporting and acceptance are available in the installed app.'
      : 'Read and accept our short community rules before sharing with your circle.'}</Text>}
    {moderation.error && <Text accessibilityRole="alert" style={body}>{moderation.error}</Text>}
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: Space.md }}>
      <NoticeAction label="Community rules" prominent onPress={() => setOpen(true)} />
      {!moderation.preview && <NoticeAction label="Refresh status" disabled={moderation.loading || moderation.accepting} onPress={() => { void moderation.refresh(); }} />}
      {(restriction || notices.length > 0) && <NoticeAction label="Appeal by email" onPress={() => { void appeal(); }} />}
    </View>
    {appealError && <Text accessibilityRole="alert" style={body}>{appealError}</Text>}
    <CommunityRulesSheet visible={open} onClose={() => setOpen(false)} />
  </View>;
}

/** Quiet text actions keep the notice from competing with Circle's main action. */
function NoticeAction({ label, onPress, disabled = false, prominent = false }: {
  label: string; onPress: () => void; disabled?: boolean; prominent?: boolean;
}) {
  const c = useAppColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress}
    style={({ pressed }) => ({ minHeight: 44, paddingVertical: Space.sm, justifyContent: 'center', opacity: disabled ? 0.55 : pressed ? 0.86 : 1 })}>
    <Text style={{ ...Type.bodySmall, fontWeight: prominent ? '700' : '400', color: prominent ? c.ember : c.inkSoft }}>{label}</Text>
  </Pressable>;
}
