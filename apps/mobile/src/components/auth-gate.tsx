import { SymbolView } from 'expo-symbols';
import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  type TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppUpdateNotice } from '@/components/app-update-notice';
import { AccountControls, RestoreAccountButton } from '@/components/account-controls';
import { BrandLogo } from '@/components/character-sprite';
import { CommunityRulesNotice } from '@/components/community-rules';
import { KeyboardForm, KeyboardTextInput } from '@/components/keyboard-form';
import { PublicInfoLinks } from '@/components/public-info-links';
import { WelcomeCamp } from '@/components/welcome-camp';
import { Radius, Shadow, Space, Type, useAppColors, type AppPalette } from '@/constants/theme';
import { isValidDisplayName, MAX_DISPLAY_NAME_LENGTH } from '@/domain/profile';
import { useApp } from '@/features/app-store';
import { ModerationProvider, useModeration } from '@/features/moderation-store';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { busy, error, isAuthenticated, isConfigured, isReady, profile, profileLoading } = useApp();
  // Preserve the typed name if a network retry temporarily swaps in a loading
  // or recovery screen. Never ask the user to retype a successful first step.
  const ownerId = isAuthenticated ? profile.id : 'signed-out';
  const [draft, setDraft] = useState<{ ownerId: string; name: string | null }>(() => ({ ownerId, name: null }));
  if (draft.ownerId !== ownerId) setDraft({ ownerId, name: null });
  const draftName = draft.ownerId === ownerId ? draft.name : null;
  const setDraftName = (name: string) => setDraft(previous => previous.ownerId === ownerId ? { ownerId, name } : previous);
  if (!isConfigured) return <ConfigurationScreen />;
  if (!isReady) return error ? <RecoverAccountScreen /> : <LaunchScreen />;
  if (!isAuthenticated) return <SignInScreen displayName={draftName ?? ''} setDisplayName={setDraftName} />;
  if (!profile.id) return error ? <RecoverAccountScreen /> : <LaunchScreen />;
  if (!isValidDisplayName(profile.displayName)) {
    if (busy || profileLoading) return <LaunchScreen />;
    // This exceptional repair screen sits outside the normal app provider.
    // Mount consent here too: saving a name is a social write, but recovery
    // and deletion must remain available even if acceptance is unavailable.
    return <ModerationProvider key={profile.id}>
      <CompleteProfileScreen displayName={draftName ?? profile.displayName} setDisplayName={setDraftName} />
    </ModerationProvider>;
  }
  return children;
}

function RecoverAccountScreen() {
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const { error, profileLoading, refresh } = useApp();
  const retrying = useRef(false);
  const [pending, setPending] = useState(false);
  const insets = useSafeAreaInsets();

  const retry = async () => {
    if (retrying.current || profileLoading) return;
    retrying.current = true;
    setPending(true);
    try {
      await refresh();
    } catch {
      // Keep this account and let the provider show the next retryable error.
    } finally {
      retrying.current = false;
      setPending(false);
    }
  };

  return (
    <KeyboardForm contentContainerStyle={[styles.authPage, { paddingTop: insets.top + Space.lg, paddingBottom: insets.bottom + Space.xl }]}>
      <View style={styles.authCard}>
        <Text style={styles.cardTitle}>Let’s reconnect.</Text>
        <Text style={styles.cardBody}>Check your connection and try again.</Text>
        {error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        <ActionButton disabled={pending || profileLoading} label="Try again" loading={pending || profileLoading} loadingLabel="Loading your profile…" onPress={retry} />
      </View>
      <PublicInfoLinks compact />
      <AppUpdateNotice />
    </KeyboardForm>
  );
}

function LaunchScreen() {
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);
  return (
    <View style={styles.launch}>
      <BrandLogo size={96} />
      <Text style={styles.launchTitle}>sumore</Text>
      <ActivityIndicator color={c.ember} />
      <Text accessibilityLiveRegion="polite" style={styles.configurationBody}>Loading your profile…</Text>
    </View>
  );
}

type NameDraftProps = { displayName: string; setDisplayName: (name: string) => void };

function SignInScreen({ displayName, setDisplayName }: NameDraftProps) {
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const { busy, error, continueWithoutEmail, clearError } = useApp();
  const inputRef = useRef<TextInput>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const insets = useSafeAreaInsets();

  const continueToApp = async () => {
    if (submitting.current || busy || !isValidDisplayName(displayName)) return;
    submitting.current = true;
    setPending(true);
    Keyboard.dismiss();
    try {
      await continueWithoutEmail(displayName);
    } catch {
      // The provider renders the friendly error.
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <KeyboardForm inputRef={inputRef} contentContainerStyle={[styles.welcomePage, { paddingTop: insets.top + Space.md, paddingBottom: insets.bottom + Space.lg }]}>
      <View style={styles.welcomeContent}>
        <View style={styles.wordmark}>
          <BrandLogo size={30} /><Text style={styles.wordmarkText}>sumore</Text>
        </View>
        <WelcomeCamp />
        <View style={styles.authIntro}>
          <Text accessibilityRole="header" style={styles.authTitle}>Welcome to sumore</Text>
          <Text style={styles.authBody}>Less scrolling. More time together.</Text>
        </View>

        <View style={styles.welcomeCard}>
          <Text style={styles.cardTitle}>What should we call you?</Text>
          <Text style={styles.cardBody}>Choose a name your circle will recognize.</Text>
          <KeyboardTextInput
            ref={inputRef}
            autoCapitalize="words"
            autoComplete="name"
            accessibilityLabel="Your name"
            editable={!busy && !pending}
            maxLength={MAX_DISPLAY_NAME_LENGTH * 2}
            onChangeText={(value) => {
              clearError();
              setDisplayName(value);
            }}
            onSubmitEditing={continueToApp}
            placeholder="Your name"
            placeholderTextColor={c.inkSoft}
            selectionColor={c.ember}
            returnKeyType="done"
            style={styles.input}
            value={displayName}
          />
          <ActionButton disabled={busy || pending || !isValidDisplayName(displayName)} label="Join the camp" loading={busy || pending} loadingLabel="Creating your profile…" onPress={continueToApp} />
          <Text style={styles.nameHint}>No email or password needed. Save your private login key in Setup to recover your account later.</Text>
          <RestoreAccountButton />
          {error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        </View>
        <PublicInfoLinks compact />
        <AppUpdateNotice />
      </View>
    </KeyboardForm>
  );
}

function CompleteProfileScreen({ displayName, setDisplayName }: NameDraftProps) {
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const { busy, clearError, error, updateProfile } = useApp();
  const moderation = useModeration();
  const canSaveName = !!moderation.status && moderation.status.acceptedRulesVersion === moderation.status.rulesVersion
    && !moderation.status.restriction && !moderation.error && !moderation.loading;
  const inputRef = useRef<TextInput>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const insets = useSafeAreaInsets();

  const save = async () => {
    if (submitting.current || busy || !isValidDisplayName(displayName) || !canSaveName) return;
    submitting.current = true;
    setPending(true);
    Keyboard.dismiss();
    try {
      await updateProfile(displayName);
    } catch {
      // The provider renders the friendly error.
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <KeyboardForm inputRef={inputRef} contentContainerStyle={[styles.authPage, { paddingTop: insets.top + Space.lg, paddingBottom: insets.bottom + Space.xl }]}>
      <CommunityRulesNotice />
      <View style={styles.authCard}>
        <Text style={styles.cardTitle}>Your name</Text>
        <KeyboardTextInput
          ref={inputRef}
          autoCapitalize="words"
          autoComplete="name"
          accessibilityLabel="Your name"
          editable={!busy && !pending}
          maxLength={MAX_DISPLAY_NAME_LENGTH * 2}
          onChangeText={(value) => {
            clearError();
            setDisplayName(value);
          }}
          onSubmitEditing={save}
          placeholder="Your name"
          placeholderTextColor={c.inkSoft}
          selectionColor={c.ember}
          returnKeyType="done"
          style={styles.input}
          value={displayName}
        />
        <ActionButton disabled={busy || pending || !isValidDisplayName(displayName) || !canSaveName} label="Save profile" loading={busy || pending} loadingLabel="Saving your profile…" onPress={save} />
        {error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
      </View>
      <AccountControls />
      <PublicInfoLinks compact />
      <AppUpdateNotice />
    </KeyboardForm>
  );
}

function ConfigurationScreen() {
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);
  return (
    <View style={styles.launch}>
      <View style={styles.logo}>
        <SymbolView
          name={{ ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' }}
          size={26}
          tintColor={c.onFlame}
        />
      </View>
      <Text style={styles.launchTitle}>The shared database is not configured.</Text>
      <Text style={styles.configurationBody}>Install an official build of the app or add the Supabase public configuration before starting Expo.</Text>
    </View>
  );
}

function ActionButton({ disabled, label, loading, loadingLabel, onPress }: { disabled: boolean; label: string; loading: boolean; loadingLabel: string; onPress: () => void }) {
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={loading ? loadingLabel : label} accessibilityState={{ disabled, busy: loading }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.action, disabled && styles.actionDisabled, pressed && styles.pressed]}>
      {loading && <ActivityIndicator color={c.onFlame} />}
      <Text accessibilityLiveRegion="polite" style={styles.actionText}>{loading ? loadingLabel : label}</Text>
    </Pressable>
  );
}

const createStyles = (c: AppPalette) =>
  StyleSheet.create({
    launch: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Space.md, backgroundColor: c.ground },
    launchTitle: { ...Type.title, color: c.ink },
    hearth: { width: 240, alignSelf: 'center' },
    logo: {
      width: 54,
      height: 54,
      borderRadius: Radius.tin,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.ember,
      ...Shadow.lit,
    },
    authPage: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: Space.lg, gap: Space.md },
    welcomePage: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: Space.lg },
    welcomeContent: { width: '100%', maxWidth: 420, alignSelf: 'center', gap: Space.md },
    wordmark: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.xs },
    wordmarkText: { ...Type.heading, color: c.ink },
    authIntro: { alignItems: 'center', gap: Space.xs, marginBottom: Space.xs },
    authTitle: { ...Type.title, fontSize: 32, lineHeight: 38, color: c.ink, textAlign: 'center' },
    authBody: { ...Type.body, color: c.inkSoft, textAlign: 'center', maxWidth: 330 },
    welcomeCard: { padding: Space.md, borderRadius: Radius.blanket, backgroundColor: c.wool, borderWidth: 1, borderColor: c.seam },
    authCard: {
      padding: Space.lg,
      borderRadius: Radius.blanket,
      backgroundColor: c.wool,
      borderWidth: 1,
      borderColor: c.seam,
      ...Shadow.rest,
    },
    cardTitle: { ...Type.heading, color: c.ink },
    cardBody: { ...Type.bodySmall, color: c.inkSoft, marginTop: 4, marginBottom: Space.md },
    inputLabel: { ...Type.control, color: c.ink, marginBottom: 6 },
    input: {
      minHeight: 52,
      paddingVertical: Space.sm,
      borderRadius: Radius.fold,
      backgroundColor: c.ground,
      borderWidth: 1,
      borderColor: c.seam,
      paddingHorizontal: Space.md,
      color: c.ink,
      ...Type.body,
      marginBottom: Space.md,
    },
    nameHint: { ...Type.bodySmall, color: c.inkSoft, marginTop: Space.sm, marginBottom: Space.sm, textAlign: 'center' },
    configurationBody: { ...Type.body, color: c.inkSoft, maxWidth: 320, textAlign: 'center' },
    action: {
      minHeight: 54,
      flexDirection: 'row',
      gap: Space.sm,
      borderRadius: Radius.tin,
      backgroundColor: c.ember,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
      ...Shadow.lit,
    },
    actionDisabled: { opacity: 0.55 },
    actionText: { ...Type.control, color: c.onFlame },
    error: {
      ...Type.bodySmall,
      color: c.scarlet,
      backgroundColor: c.emberWash,
      borderRadius: Radius.tin,
      padding: Space.sm,
      marginTop: Space.md,
    },
    pressed: { opacity: 0.86, transform: [{ scale: 0.995 }] },
  });
