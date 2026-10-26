import * as Clipboard from 'expo-clipboard';
import { useRef, useState } from 'react';
import { Keyboard, Text, View } from 'react-native';
import { useAppTour } from '@/components/app-tour';
import { ActionButton, FormSheet } from '@/components/form-sheet';
import { KeyboardTextInput } from '@/components/keyboard-form';
import { PublicInfoLinks } from '@/components/public-info-links';
import { SectionHeading } from '@/components/section-heading';
import { SettingsActionRow } from '@/components/settings-action-row';
import { useAppColors } from '@/constants/theme';
import { formControlStyle, formSectionStyle } from '@/constants/form-layout';
import { isLocalArtPreview } from '@/features/local-art-preview';
import { FEEDBACK_ADDRESS, openProblemReportEmail, problemReportEmail } from '@/services/feedback';

export function HelpFeedbackControls() {
  const c = useAppColors();
  const { openTour } = useAppTour();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const openEmail = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setNotice(''); Keyboard.dismiss();
    try {
      if (isLocalArtPreview) { setNotice('Email sending is unavailable here. Copy your report and send it from your email app. No email was sent.'); return; }
      const result = await openProblemReportEmail(draft);
      setNotice(result === 'cancelled' ? 'Email cancelled. Your draft is still here.'
        : result === 'saved' ? 'Saved in your mail app. Your draft is also kept here.'
        : result === 'accepted' ? 'Your mail app accepted the report. Thank you!'
        : 'Finish sending in your email app. Your draft is kept here.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open your email app. Your draft is still here.'); }
    finally { submitting.current = false; setBusy(false); }
  };
  const copyReport = async () => {
    try {
      const email = problemReportEmail(draft);
      await Clipboard.setStringAsync(`To: ${FEEDBACK_ADDRESS}\nSubject: ${email.subject}\n\n${email.body}`);
      setNotice('Copied. Paste into an email to cowcatbird.dev@gmail.com.');
    } catch { setNotice('Could not copy. Your draft is still here.'); }
  };
  return <View style={formSectionStyle}>
    <SectionHeading title="Help & feedback" />
    <SettingsActionRow label="App tour" icon={{ ios: 'map', android: 'explore', web: 'explore' }} onPress={() => { Keyboard.dismiss(); openTour(); }} />
    <SettingsActionRow label="Report a problem" icon={{ ios: 'bubble.left', android: 'chat_bubble_outline', web: 'chat_bubble_outline' }} onPress={() => { setNotice(''); setOpen(true); }} />
    <View style={{ paddingHorizontal: formControlStyle.paddingHorizontal, paddingTop: 4 }}>
      <PublicInfoLinks />
    </View>
    <FormSheet title="Report a problem" visible={open} onClose={() => setOpen(false)} busy={busy}>
      <Text style={{ color: c.inkSoft }}>{isLocalArtPreview
        ? 'Tell us what happened, then copy your report into an email to cowcatbird.dev@gmail.com. Don’t include passwords or login keys.'
        : 'Tell us what happened. We’ll open an email to cowcatbird.dev@gmail.com for you to review and send. Don’t include passwords or login keys.'}</Text>
        <KeyboardTextInput accessibilityLabel="Describe the problem" multiline maxLength={4000} value={draft} onChangeText={setDraft} editable={!busy}
          placeholder="What were you doing when it happened?" placeholderTextColor={c.inkSoft} textAlignVertical="top"
          style={{ ...formControlStyle, minHeight: 150, maxHeight: 240, borderWidth: 1, borderColor: c.seam, backgroundColor: c.wool, color: c.ink, fontSize: 16 }} />
        <Text style={{ color: c.inkSoft, fontSize: 12 }}>{draft.length}/4,000 · Includes app version and platform only.</Text>
        <ActionButton label={busy ? 'Opening…' : 'Open email'} primary disabled={busy || draft.trim().length < 10} onPress={() => { void openEmail(); }} />
        <ActionButton label="Copy report" disabled={busy || draft.trim().length < 10} onPress={() => { void copyReport(); }} />
      {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: c.inkSoft }}>{notice}</Text>}
    </FormSheet>
  </View>;
}
