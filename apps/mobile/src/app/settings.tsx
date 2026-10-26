import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Keyboard, Pressable, StyleSheet, Text, type TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { AppUpdateNotice } from '@/components/app-update-notice';
import { AccountControls } from '@/components/account-controls';
import { HelpFeedbackControls } from '@/components/help-feedback-controls';
import { LocalPreviewBanner } from '@/components/local-preview-banner';
import { KeyboardForm, KeyboardTextInput } from '@/components/keyboard-form';
import { ScreenHeader } from '@/components/screen-header';
import { SectionHeading } from '@/components/section-heading';
import { SettingsActionRow } from '@/components/settings-action-row';
import { CommunityRulesButton, CommunityRulesNotice } from '@/components/community-rules';
import { MaxContentWidth, Radius, Space, Type, useAppColors, type AppPalette } from '@/constants/theme';
import { FormLayout, formControlStyle, formSectionStyle } from '@/constants/form-layout';
import { isValidDisplayName, MAX_DISPLAY_NAME_LENGTH } from '@/domain/profile';
import { useApp } from '@/features/app-store';
import { isLocalArtPreview } from '@/features/local-art-preview';
import { useModeration } from '@/features/moderation-store';
import {
  getNotificationReadiness,
  notificationErrorMessage,
  notificationErrorReadiness,
  notificationStatusLabel,
  registerForPushNotifications,
  scheduleNotificationPreview,
} from '@/services/notifications';
import type { NotificationReadiness } from '@/types/domain';

export default function SettingsScreen() {
  const { busy, clearError, error, profile, updateProfile } = useApp();
  const moderation = useModeration();
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);

  const saveProfile = async () => {
    if (submitting.current || busy || !isValidDisplayName(displayName)) return;
    submitting.current = true;
    setSaving(true);
    Keyboard.dismiss();
    try {
      await updateProfile(displayName);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch {
      // The store renders the friendly error.
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  };

  return (
    <SafeAreaView edges={['top']} style={styles.page}>
      <KeyboardForm
        inputRef={inputRef}
        style={styles.page}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}>
        <ScreenHeader title="Setup" />

        <LocalPreviewBanner />

        <View style={styles.section}>
          <View style={styles.sectionHeading}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Name</Text>
          </View>
          <View style={styles.nameControls}>
            <KeyboardTextInput
              ref={inputRef}
              autoCapitalize="words"
              autoComplete="name"
              accessibilityLabel="Your name"
              editable={!busy && !saving}
              maxLength={MAX_DISPLAY_NAME_LENGTH * 2}
              onChangeText={(value) => {
                clearError();
                setSaved(false);
                setDisplayName(value);
              }}
              placeholder="Your name"
              placeholderTextColor={c.inkSoft}
              selectionColor={c.ember}
              returnKeyType="done"
              onSubmitEditing={saveProfile}
              style={styles.input}
              value={displayName}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={saving ? 'Saving your profile' : saved ? 'Saved' : 'Save profile'}
              accessibilityState={{ disabled: busy || saving || !isValidDisplayName(displayName), busy: saving }}
              disabled={busy || saving || !isValidDisplayName(displayName)}
              onPress={saveProfile}
              style={({ pressed }) => [
                styles.primary,
                (busy || saving || !isValidDisplayName(displayName)) && styles.disabled,
                pressed && styles.pressed,
              ]}>
              {(busy || saving) && <ActivityIndicator color={c.onFlame} />}
              <Text accessibilityLiveRegion="polite" style={styles.primaryText}>{saving ? 'Saving…' : saved ? 'Saved' : 'Save'}</Text>
            </Pressable>
          </View>
          {!isValidDisplayName(displayName) && <Text accessibilityLiveRegion="polite" style={styles.validation}>Enter a name with 1 to {MAX_DISPLAY_NAME_LENGTH} characters.</Text>}
          {error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.notice, styles.error]}>{error}</Text>}
        </View>

        <NotificationSettings key={`notifications:${profile.id}`} ownerId={profile.id} />

        <AccountControls />
        <View style={styles.section}>
          <SectionHeading title="Community" />
          {moderation.status?.acceptedRulesVersion === moderation.status?.rulesVersion
            && moderation.status && !moderation.status.restriction && !moderation.status.notices.length && !moderation.error
            ? <CommunityRulesButton /> : <CommunityRulesNotice />}
          {!moderation.preview && !moderation.error && moderation.status?.isModerator && <SettingsActionRow
            label="Review reports" icon={{ ios: 'shield', android: 'shield', web: 'shield' }}
            onPress={() => router.push('/moderation')} />}
        </View>
        <HelpFeedbackControls key={profile.id} />

        <AppUpdateNotice />
      </KeyboardForm>
    </SafeAreaView>
  );
}

/** Keyed by account: an old account's operation cannot update its replacement. */
export function NotificationSettings({ ownerId }: { ownerId: string }) {
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<NotificationReadiness>('unknown');
  const [working, setWorking] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    if (isLocalArtPreview) return;
    mounted.current = true;
    const refresh = () => {
      if (pending.current || (AppState.currentState && AppState.currentState !== 'active')) return;
      const version = ++generation.current;
      getNotificationReadiness(ownerId).then(value => {
        if (mounted.current && generation.current === version) setStatus(value);
      }).catch(() => {
        if (mounted.current && generation.current === version) setStatus('unknown');
      });
    };
    refresh();
    const subscription = AppState.addEventListener('change', next => {
      // iOS permission dialogs temporarily report inactive, not background.
      if (next === 'background') generation.current += 1;
      else if (next === 'active') refresh();
    });
    return () => { mounted.current = false; generation.current += 1; subscription.remove(); };
  }, [ownerId]);

  const begin = () => {
    if (!mounted.current || pending.current || AppState.currentState === 'background') return null;
    pending.current = true;
    setWorking(true); setNotice(null);
    const version = ++generation.current;
    return () => mounted.current && generation.current === version;
  };
  const finish = (current: () => boolean) => {
    pending.current = false;
    if (!mounted.current) return;
    setWorking(false);
    if (!current()) { setStatus('unknown'); setNotice('Registration was interrupted. Try again.'); }
  };
  const enablePush = async () => {
    if (isLocalArtPreview) {
      setNotice('Notifications are unavailable in this browser. Enable them in the installed app.');
      return;
    }
    const current = begin();
    if (!current) return;
    setStatus('unknown');
    try {
      await registerForPushNotifications(ownerId, current);
      if (current()) {
        setStatus('registered');
        setNotice('This device is registered for friend notifications.');
      }
    } catch (caught) {
      if (current()) { setStatus(notificationErrorReadiness(caught)); setNotice(notificationErrorMessage(caught)); }
    } finally { finish(current); }
  };
  const previewNotification = async () => {
    if (isLocalArtPreview) {
      setNotice('Notifications are unavailable in this browser. Nothing was sent.');
      return;
    }
    const current = begin();
    if (!current) return;
    try {
      await scheduleNotificationPreview(current);
      if (current()) setNotice('Scheduled on this device only. This does not test delivery from friends.');
    } catch (caught) {
      if (current()) setNotice(notificationErrorMessage(caught, true));
    } finally { finish(current); }
  };

  return <View style={styles.section}>
    <SectionHeading title="Notifications" />
    <View style={styles.notificationStatus}>
      <View accessible={false} style={[styles.statusDot, !isLocalArtPreview && status === 'registered' && styles.statusDotOn]} />
      <Text accessibilityLiveRegion="polite" style={styles.sectionBody}>{isLocalArtPreview ? 'Unavailable in this browser' : notificationStatusLabel(status)}</Text>
    </View>
    <View style={styles.buttonRow}>
      <Pressable accessibilityRole="button" accessibilityLabel="Test on this device" disabled={working}
        accessibilityState={{ disabled: working, busy: working }} onPress={previewNotification}
        style={({ pressed }) => [styles.secondary, styles.sendNotification, working && styles.disabled, pressed && styles.pressed]}>
        <Text style={styles.secondaryText}>Test on this device</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Enable notifications" disabled={working}
        accessibilityState={{ disabled: working, busy: working }} onPress={enablePush}
        style={({ pressed }) => [styles.secondary, working && styles.disabled, pressed && styles.pressed]}>
        <Text style={styles.secondaryText}>{working ? 'Connecting…' : 'Enable'}</Text>
      </Pressable>
    </View>
    {notice && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
  </View>;
}

const createStyles = (c: AppPalette) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: c.ground },
    content: { width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center', paddingHorizontal: Space.lg, paddingBottom: Space.xxl, gap: FormLayout.sectionSpacing },

    section: formSectionStyle,
    sectionHeading: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: Space.sm },
    sectionTitle: { ...Type.heading, color: c.ink, flex: 1 },
    sectionBody: { ...Type.bodySmall, color: c.inkSoft, flexShrink: 1 },
    validation: { ...Type.bodySmall, color: c.scarlet },
    nameControls: { flexDirection: 'row', alignItems: 'stretch', gap: FormLayout.sectionGap },
    notificationStatus: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, paddingHorizontal: 2 },
    statusDot: { width: 6, height: 6, borderRadius: Radius.coal, backgroundColor: c.inkSoft },
    statusDotOn: { backgroundColor: c.ember },

    input: {
      ...formControlStyle,
      flex: 1,
      minWidth: 0,
      backgroundColor: c.woolDeep,
      borderWidth: 1,
      borderColor: c.seam,
      color: c.ink,
      ...Type.body,
    },

    primary: {
      ...formControlStyle,
      minWidth: 88,
      flexDirection: 'row',
      gap: Space.sm,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.ember,
    },
    primaryText: { ...Type.control, color: c.onFlame },
    buttonRow: { flexDirection: 'row', gap: FormLayout.sectionGap },
    secondary: {
      flex: 1,
      ...formControlStyle,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.wool,
      borderWidth: 1,
      borderColor: c.seam,
    },
    sendNotification: { flex: 1.6 },
    secondaryText: { ...Type.control, fontSize: 13, color: c.ink, textAlign: 'center' },
    notice: {
      ...Type.bodySmall,
      color: c.inkSoft,
      backgroundColor: c.wool,
      borderWidth: 1,
      borderColor: c.seam,
      borderRadius: Radius.fold,
      padding: Space.sm,
    },
    error: { color: c.scarlet, backgroundColor: c.emberWash, borderColor: c.emberLow },
    pressed: { opacity: 0.86, transform: [{ scale: 0.995 }] },
    disabled: { opacity: 0.55 },
  });
