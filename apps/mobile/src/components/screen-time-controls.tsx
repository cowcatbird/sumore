import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { HelpButton } from '@/components/help-button';
import { ActionButton, FormSheet } from '@/components/form-sheet';
import { KeyboardTextInput } from '@/components/keyboard-form';
import { DailyTimeProgress, SelectedApps } from '@/components/selected-apps';
import { SectionHeading } from '@/components/section-heading';
import { ScreenTimeSetupChecklist } from '@/components/screen-time-setup-checklist';
import { Radius, Space, useAppColors } from '@/constants/theme';
import { FormLayout, formControlStyle, formSectionStyle } from '@/constants/form-layout';
import { ANDROID_ACCESS_DISCLOSURE, ANDROID_USAGE_DISCLOSURE, DAILY_LIMIT_OPTIONS, DEFAULT_DAILY_LIMIT, PER_APP_LIMIT_EXPLANATION, androidAccessibilityGuidance, androidAccessibilityStatusLabel, androidAccessStep, canEditDailyLimit, dailyLimitAmountLabel, dailyLimitSummary, reportedUsageLabel, screenTimeAccessReady, screenTimeSetupReadiness, stopSecondsRemaining, validDailyLimit } from '@/domain/daily-limit-controls';
import { useApp } from '@/features/app-store';
import {
  cancelScreenTimeDisable, clearScreenTimeSelection, configureDailyScreenTimeLimit, configurePerAppScreenTimeLimits, configureScreenTimeAccount, getScreenTimeStatus,
  openScreenTimeAccessibilitySettings, openScreenTimeUsageSettings, requestScreenTimeAuthorization, requestScreenTimeDisable,
  selectScreenTimeApps, setScreenTimeBlocking, setScreenTimeDisclosureAccepted, unavailableScreenTimeStatus,
} from '@/native/screen-time';
import type { ScreenTimeStatus } from '@/types/domain';
import { publishDailyAllocation } from '@/services/shared-allocation';

type Owned<T> = { userId: string; value: T };
type LimitAction = (isCurrent: () => boolean) => Promise<ScreenTimeStatus | undefined>;
type ControlButtonProps = { label: string; onPress: () => void; busy: boolean; primary?: boolean; disabled?: boolean };

function ControlButton({ label, onPress, busy, primary = false, disabled = false }: ControlButtonProps) {
  const c = useAppColors();
  return <Pressable
    accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: busy || disabled, busy }}
    disabled={busy || disabled} onPress={onPress}
    style={({ pressed }) => ({ ...formControlStyle, borderWidth: 1, borderColor: primary ? c.ember : c.seam,
      alignItems: 'center', justifyContent: 'center', backgroundColor: primary ? c.ember : c.wool,
      opacity: busy || disabled ? 0.5 : pressed ? 0.78 : 1 })}>
    <Text style={{ color: primary ? c.onFlame : c.ink, fontSize: 14, fontWeight: '600', textAlign: 'center' }}>{label}</Text>
  </Pressable>;
}

function CommandButton({ action, run, ...props }: Omit<ControlButtonProps, 'onPress'> & { action: LimitAction; run: (action: LimitAction) => Promise<void> }) {
  return <ControlButton {...props} onPress={() => { void run(action); }} />;
}

export function ScreenTimeControls({ onStatus }: { onStatus?: (status: ScreenTimeStatus) => void }) {
  const { profile } = useApp();
  const [savedStatus, setStatus] = useState<Owned<ScreenTimeStatus> & { checked: boolean }>(() => ({ userId: profile.id, checked: false, value: unavailableScreenTimeStatus('Checking Screen Time…') }));
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const [controlOwner, setControlOwner] = useState(profile.id);
  const [failure, setFailure] = useState<Owned<string> | null>(null);
  const [draft, setDraft] = useState<Owned<number> | null>(null);
  const [declinedFor, setDeclinedFor] = useState<string | null>(null);
  const [usageDeclinedFor, setUsageDeclinedFor] = useState<string | null>(null);
  const [clearFor, setClearFor] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [customOpen, setCustomOpen] = useState(false);
  const [customText, setCustomText] = useState('');
  const owner = useRef<string | null>(profile.id);
  const generation = useRef(0);
  const operation = useRef(0);
  const submitting = useRef(false);
  // Reset before committing a new account's controls, including A → B → A.
  if (controlOwner !== profile.id) {
    setControlOwner(profile.id);
    setBusyFor(null);
    setDeclinedFor(null);
    setUsageDeclinedFor(null);
  }
  useLayoutEffect(() => {
    owner.current = profile.id;
    generation.current += 1;
    submitting.current = false;
    return () => { owner.current = null; generation.current += 1; };
  }, [profile.id]);

  const status = savedStatus.userId === profile.id ? savedStatus.value : unavailableScreenTimeStatus('Checking Screen Time…');
  const busy = busyFor === profile.id;
  const error = failure?.userId === profile.id ? failure.value : null;
  const budget = draft?.userId === profile.id ? draft.value : validDailyLimit(status.dailyLimitMinutes) ? status.dailyLimitMinutes : DEFAULT_DAILY_LIMIT;
  const stopSeconds = stopSecondsRemaining(status.settingsChangeAllowedAt, now);
  const c = useAppColors();
  const styles = useMemo(() => StyleSheet.create({
    section: { gap: Space.md },
    body: { color: c.inkSoft, fontSize: 14, lineHeight: 21 },
    selection: { color: c.ink, fontSize: 16, lineHeight: 23, fontWeight: '600' },
    actions: formSectionStyle,
    card: { padding: Space.md, gap: FormLayout.sectionGap, borderRadius: Radius.fold, borderWidth: 1, borderColor: c.seam, backgroundColor: c.woolDeep },
    input: { ...formControlStyle, borderWidth: 1, borderColor: c.seam, backgroundColor: c.wool, color: c.ink, fontSize: 20 },
    primary: { backgroundColor: c.emberWash, borderColor: c.ember },
    buttonText: { color: c.ink, fontSize: 14, fontWeight: '600', textAlign: 'center', fontVariant: ['tabular-nums'] }, primaryText: { color: c.ember },
    disabled: { opacity: 0.5 }, pressed: { opacity: 0.78 }, error: { color: c.scarlet, fontSize: 14, lineHeight: 21 },
    options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    option: { flexGrow: 1, flexBasis: '20%', minWidth: 56, minHeight: 44, padding: 10, borderRadius: Radius.tin, borderWidth: 1, borderColor: c.seam, alignItems: 'center', justifyContent: 'center', backgroundColor: c.wool },
  }), [c]);
  const accept = useCallback((next: ScreenTimeStatus, userId: string) => {
    setStatus({ userId, value: next, checked: true }); setNow(Date.now()); onStatus?.(next);
  }, [onStatus]);
  useFocusEffect(useCallback(() => {
    let active = true;
    let refreshing = false;
    const userId = profile.id;
    const expectedGeneration = generation.current;
    const refresh = () => {
      if (!active || submitting.current || refreshing || (AppState.currentState && AppState.currentState !== 'active')) return;
      refreshing = true;
      const expectedOperation = operation.current;
      void getScreenTimeStatus().then(next => {
        if (active && owner.current === userId && generation.current === expectedGeneration && operation.current === expectedOperation) accept(next, userId);
      }).finally(() => {
        refreshing = false;
      });
    };
    refresh();
    const sub = AppState.addEventListener('change', value => { if (value === 'active') refresh(); });
    const timer = setInterval(refresh, 3_000);
    return () => { active = false; sub.remove(); clearInterval(timer); };
  }, [accept, profile.id]));
  useEffect(() => {
    if (!status.settingsChangeAllowedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status.settingsChangeAllowedAt]);

  const run = async (action: LimitAction) => {
    if (submitting.current || !profile.id) return;
    const userId = profile.id;
    const expectedGeneration = generation.current;
    const expectedOperation = ++operation.current;
    const isCurrent = () => owner.current === userId && generation.current === expectedGeneration && operation.current === expectedOperation;
    submitting.current = true; setBusyFor(userId); setFailure(null);
    try {
      // Recovery must remain possible when damaged native state cannot bind.
      if (!status.requiresReset) await configureScreenTimeAccount(userId);
      if (!isCurrent()) return;
      const next = await action(isCurrent);
      if (isCurrent() && next) {
        accept(next, userId);
        setSelectionRevision(value => value + 1);
        // Blocking is already confirmed locally. A slow/offline Circle sync
        // must not keep every Screen Time control disabled after that point.
        void publishDailyAllocation(next, userId).catch(() => {
          if (isCurrent()) setFailure({ userId, value: 'Phone settings saved. Your Circle allocation could not sync; try again when connected.' });
        });
      }
    } catch (caught) {
      if (isCurrent()) setFailure({ userId, value: caught instanceof Error ? caught.message : 'Could not update the daily limit.' });
    } finally {
      if (isCurrent()) { submitting.current = false; setBusyFor(null); }
    }
  };
  const count = status.selection.applications + status.selection.categories + status.selection.webDomains;
  const accessStep = Platform.OS === 'android' ? androidAccessStep(status) : 'ready';
  const accessibilityGuidance = Platform.OS === 'android' ? androidAccessibilityGuidance(status, Platform.Version) : null;
  const permissionReady = screenTimeAccessReady(status, Platform.OS);
  const readiness = screenTimeSetupReadiness(status, Platform.OS, savedStatus.userId !== profile.id || !savedStatus.checked);
  const dailyReady = status.dailyLimitsAvailable === true;
  const usage = reportedUsageLabel(status);
  const options = DAILY_LIMIT_OPTIONS.some(option => option === budget) ? DAILY_LIMIT_OPTIONS : [...DAILY_LIMIT_OPTIONS, budget].sort((a, b) => a - b);
  const clearConfirmation = <View style={styles.card}>
    <Text style={styles.body}>Clear saved app choices? {status.requiresReset ? 'Recovery also stops blocking.' : 'You will need to choose apps again.'}</Text>
    <CommandButton label="Confirm clear selection" busy={busy} run={run} action={async isCurrent => {
      const next = await clearScreenTimeSelection();
      if (isCurrent()) setClearFor(null);
      return next;
    }} />
    <ControlButton label="Cancel" busy={busy} onPress={() => setClearFor(null)} />
  </View>;

  return <View style={styles.section}>
    <SectionHeading title="Daily app limit" action={
      <HelpButton title="Daily app limit">
        <Text>Your limit totals time across your selected apps, not your circle. App choices stay on this device. Earlier use today counts when supported.</Text>
        <Text>Extra time applies when this device receives it. Stopping needs a 30-second confirmation, or revoke access in your phone’s Settings.</Text>
      </HelpButton>
    } />
    <ScreenTimeSetupChecklist readiness={readiness} />
    <Text accessibilityLiveRegion="polite" style={styles.body}>{dailyLimitSummary(status)}</Text>
    {status.dailyUsageNote && <Text style={styles.body}>{status.dailyUsageNote}</Text>}
    {status.available && <View style={styles.actions}>
      {status.requiresReset ? <>
        {clearFor === profile.id ? clearConfirmation : <ControlButton label="Reset damaged settings" busy={busy} onPress={() => setClearFor(profile.id)} />}
      </> : <>
        {Platform.OS === 'android' && accessStep === 'disclosure' && <View style={styles.card}>
          {declinedFor === profile.id ? <>
            <Text style={styles.body}>App blocking stays off.</Text>
            <ControlButton label="Review Accessibility access" busy={busy} onPress={() => setDeclinedFor(null)} />
          </> : <>
            <Text accessibilityRole="header" style={styles.selection}>How sumore uses Accessibility</Text>
            <Text style={styles.body}>{ANDROID_ACCESS_DISCLOSURE}</Text>
            <CommandButton label="Agree & continue" busy={busy} run={run} action={() => setScreenTimeDisclosureAccepted(true)} primary />
            <CommandButton label="Not now" busy={busy} run={run} action={async isCurrent => {
              const next = await setScreenTimeDisclosureAccepted(false);
              if (isCurrent()) setDeclinedFor(profile.id);
              return next;
            }} />
          </>}
        </View>}
        {Platform.OS === 'android' && status.consentGranted === true && <>
          <Text style={styles.body}>1. Usage Access: {status.usageAccessGranted ? 'on' : 'needed'}</Text>
          {!status.usageAccessGranted && <View style={styles.card}>
            {usageDeclinedFor === profile.id ? <>
              <Text style={styles.body}>App blocking stays off. You can keep using the rest of sumore.</Text>
              <ControlButton label="Review Usage Access" busy={busy} onPress={() => setUsageDeclinedFor(null)} />
            </> : <>
              <Text accessibilityRole="header" style={styles.selection}>How sumore uses Usage Access</Text>
              <Text style={styles.body}>{ANDROID_USAGE_DISCLOSURE}</Text>
              <CommandButton label="Agree & open Usage Access" busy={busy} run={run} action={openScreenTimeUsageSettings} primary />
              <ControlButton label="Not now" busy={busy} onPress={() => setUsageDeclinedFor(profile.id)} />
            </>}
          </View>}
          {status.usageAccessGranted && <>
            <Text style={styles.body}>2. Accessibility: {androidAccessibilityStatusLabel(status)}</Text>
            {accessibilityGuidance && <Text style={styles.body}>{accessibilityGuidance}</Text>}
            {!status.accessibilityEnabled && <CommandButton label="Open Accessibility settings" busy={busy} run={run} action={openScreenTimeAccessibilitySettings} primary />}
          </>}
          {accessStep === 'ready' && !status.authorized && <CommandButton label="Reopen Accessibility settings" busy={busy} run={run} action={openScreenTimeAccessibilitySettings} />}
        </>}
        {Platform.OS === 'ios' && !status.authorized && <CommandButton label="Continue" busy={busy} run={run} action={requestScreenTimeAuthorization} primary />}
        {count > 0 && <SelectedApps key={profile.id} status={status} refreshKey={Math.floor(now / 60_000) + selectionRevision * 100_000_000} />}
        {status.blockingEnabled ? <>
          {status.mode === 'daily' && status.dailyLimitMinutes != null && <>
            <Text style={styles.selection}>Your daily limit: {dailyLimitAmountLabel(status.dailyLimitMinutes, status.limitMode)}</Text>
            {status.limitMode === 'perApp' && <Text style={styles.body}>{PER_APP_LIMIT_EXPLANATION}</Text>}
          </>}
          <DailyTimeProgress status={status} />
          {usage && <Text style={styles.body}>{usage}</Text>}
          {status.temporaryAccessExpiresAt && <Text style={styles.selection}>Extra time ends {new Date(status.temporaryAccessExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</Text>}
          <ControlButton label="Ask for time" busy={busy} onPress={() => router.push('/')} />
          {dailyReady ? stopSeconds !== null ? <View style={styles.card}>
            <Text style={styles.body}>{stopSeconds > 0 ? `Confirm in ${stopSeconds}s. Your limit stays active.` : 'Stopping lets you change your apps or time limit.'}</Text>
            <CommandButton label="Confirm stop" busy={busy} run={run} action={() => setScreenTimeBlocking(false)} disabled={stopSeconds > 0} />
            <CommandButton label="Keep limit" busy={busy} run={run} action={cancelScreenTimeDisable} primary />
          </View> : <CommandButton label={status.mode === 'daily' ? 'Stop or change limit' : 'Switch to daily limit'} busy={busy} run={run} action={requestScreenTimeDisable} />
            : <Text style={styles.body}>Update this app to change the limit here. You can revoke access in your phone’s Settings.</Text>}
        </> : permissionReady && <>
          {canEditDailyLimit(status, Platform.OS) ? <>
            <CommandButton label={count ? 'Change apps' : 'Choose apps'} busy={busy} run={run} action={selectScreenTimeApps} primary={!count} />
            {count > 0 && <View style={styles.card}>
              <Text style={styles.selection}>Your daily limit: {dailyLimitAmountLabel(budget, 'shared')}</Text>
              <Text style={styles.body}>Total across your selected apps.</Text>
              <View style={styles.options}>
                {options.map(minutes => <Pressable key={minutes} accessibilityRole="radio" accessibilityLabel={`${minutes} minutes per day across your selected apps`}
                  accessibilityState={{ checked: budget === minutes, disabled: busy }} disabled={busy}
                  onPress={() => setDraft({ userId: profile.id, value: minutes })}
                  style={({ pressed }) => [styles.option, budget === minutes && styles.primary, busy ? styles.disabled : pressed && styles.pressed]}>
                  <Text style={[styles.buttonText, budget === minutes && styles.primaryText]}>{minutes}</Text>
                </Pressable>)}
              </View>
              {status.customLimitAvailable && <ControlButton label="Custom" busy={busy} onPress={() => { setCustomText(String(budget)); setCustomOpen(true); }} />}
              <CommandButton label="Save & enable daily limit" busy={busy} run={run} primary action={async isCurrent => {
                const configured = await configureDailyScreenTimeLimit(budget);
                if (!isCurrent()) return;
                if (configured.mode !== 'daily' || configured.dailyLimitMinutes !== budget || !configured.blockingEnabled) throw new Error('The daily limit was not confirmed. Try saving again.');
                return configured;
              }} />
              {status.perAppLimitsAvailable && <CommandButton label="Set separate app limits" busy={busy} run={run} action={configurePerAppScreenTimeLimits} />}
              {clearFor === profile.id ? clearConfirmation : <ControlButton label="Clear app selection" busy={busy} onPress={() => setClearFor(profile.id)} />}
            </View>}
          </> : <Text style={styles.body}>Daily limits need an updated app build.</Text>}
        </>}
      </>}
    </View>}
    {busy && <ActivityIndicator accessibilityLabel="Updating daily limit" color={c.ember} />}
    {error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
    <FormSheet title="Custom daily time" visible={customOpen} onClose={() => setCustomOpen(false)}>
      <Text style={styles.body}>Minutes per day, from 1 to 1,440.</Text>
      <KeyboardTextInput accessibilityLabel="Custom daily minutes" keyboardType="number-pad" value={customText}
        onChangeText={setCustomText} maxLength={4} style={styles.input} />
      <ActionButton label="Use this time" primary disabled={!/^\d+$/.test(customText) || !validDailyLimit(Number(customText))}
        onPress={() => { setDraft({ userId: profile.id, value: Number(customText) }); setCustomOpen(false); }} />
    </FormSheet>
  </View>;
}
