import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { approvalMessage } from '@/domain/approval-presentation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BlanketBand } from '@/components/blanket-band';
import { Campfire } from '@/components/campfire';
import { TinTagWire } from '@/components/tin-tag';
import { BrandLogo } from '@/components/character-sprite';
import { SMoreSprite } from '@/components/smore-sprite';
import { KeyboardForm, KeyboardTextInput } from '@/components/keyboard-form';
import { HelpButton } from '@/components/help-button';
import { isLocalArtPreview, sampleLooks, useLocalArtPreview } from '@/features/local-art-preview';
import { Radius, Shadow, Space, Type, useAppColors, type AppPalette } from '@/constants/theme';
import { useApp } from '@/features/app-store';
import { useScreenTimeStatus } from '@/features/use-screen-time-status';
import { nextSMoreProgress, SMORE_REWARD_EXPLANATION, sMoreRewardLabel } from '@/domain/rewards';
import { demoAskBlockReason } from '@/domain/demo-screen-time';
import { panicButtonBlockReason, previewPanicButtonBlockReason } from '@/domain/panic-button';
import type { GrantMinutes } from '@/types/domain';

const previewTimeOptions: GrantMinutes[] = [5, 10, 15, 30];
const nativeTimeOptions: GrantMinutes[] = [15, 30];

export default function HomeScreen() {
  const { busy, campfire, circleShop, error, friends, incomingRequests, outgoingRequest, pressPanicButton, profile, recentDecision, sendRequest, cancelRequest, clearError } =
    useApp();
  const [requestOpen, setRequestOpen] = useState(false);
  const [panicOpen, setPanicOpen] = useState(false);
  const [panicSubmitting, setPanicSubmitting] = useState(false);
  const [panicError, setPanicError] = useState<string | null>(null);
  const [panicNotice, setPanicNotice] = useState<string | null>(null);
  const panicSubmittingRef = useRef(false);
  const [minutes, setMinutes] = useState<GrantMinutes>(15);
  const [reason, setReason] = useState('');
  const [paused, setPaused] = useState(false);
  const preview = useLocalArtPreview();
  const askBlockReason = preview ? demoAskBlockReason(preview.screenTime) : null;

  const screenTime = useScreenTimeStatus(!isLocalArtPreview);
  const panicSMores = circleShop?.balance ?? Number.NaN;
  const panicBlockReason = preview
    ? previewPanicButtonBlockReason(preview.screenTime, panicSMores)
    : panicButtonBlockReason(screenTime, panicSMores);
  const panicPending = busy || panicSubmitting;
  const timeOptions = screenTime.available ? nativeTimeOptions : previewTimeOptions;
  const insets = useSafeAreaInsets();
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') setNow(new Date());
    });
    return () => { clearInterval(timer); subscription.remove(); };
  }, []);

  const submitRequest = async () => {
    if (busy || askBlockReason) return;
    Keyboard.dismiss();
    try {
      await sendRequest(screenTime.available && minutes < 15 ? 15 : minutes, reason);
      setRequestOpen(false);
      setReason('');
    } catch {
      // The store displays the error inside the sheet.
    }
  };

  const confirmPanic = async () => {
    if (panicPending || panicBlockReason || panicSubmittingRef.current) return;
    panicSubmittingRef.current = true;
    setPanicSubmitting(true);
    setPanicError(null);
    try {
      await pressPanicButton();
      setPanicOpen(false);
      setPanicNotice(preview ? '15 extra minutes added in this browser. Phone app limits are unchanged.' : null);
    } catch (caught) {
      setPanicError(caught instanceof Error ? caught.message : 'The panic button could not be used. Please try again.');
    } finally {
      panicSubmittingRef.current = false;
      setPanicSubmitting(false);
    }
  };

  const firstName = profile.displayName.split(/\s+/)[0] || 'friend';
  // One server-owned wallet for the whole circle, never the legacy per-seat
  // no-request counters. Everyone follows the same group-day boundaries.
  const progress = nextSMoreProgress(circleShop, now);

  return (
    <View style={styles.page}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <View style={[styles.heroHeader, { paddingTop: insets.top + 22 }]}>
            <View style={styles.brandRow}>
              <View style={styles.brand}><BrandLogo size={34} /><Text style={styles.wordmark}>sumore</Text></View>
              <Pressable accessibilityRole="button" accessibilityLabel="Customize your camper" onPress={() => router.push('/customize')} style={styles.dressUp}>
                <Text style={styles.dressUpText}>Your camper ↗</Text>
              </Pressable>
            </View>
            <Text style={styles.heroTitle}>{isLocalArtPreview ? 'Your camp' : `Hey, ${firstName}`}</Text>
          </View>
          <Campfire seats={campfire.seats} paused={paused} exampleLooks={isLocalArtPreview ? sampleLooks : undefined} onPressYourCamper={() => router.push('/customize')} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Panic button"
            accessibilityHint={panicBlockReason ? `${panicBlockReason} Opens details.` : 'Opens confirmation for fifteen extra minutes. Costs one circle s’more if available; works at zero.'}
            accessibilityState={{ disabled: panicPending, busy: panicPending }}
            disabled={panicPending}
            onPress={() => { clearError(); setPanicError(null); setPanicNotice(null); setPanicOpen(true); }}
            style={({ pressed }) => [styles.panicButton, panicPending && styles.disabled, pressed && styles.pressed]}>
            <SymbolView
              name={{ ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' }}
              size={20}
              tintColor={c.mallow}
            />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={paused ? 'Resume fire animation' : 'Pause fire animation'}
            accessibilityState={{ selected: paused }} onPress={() => setPaused(value => !value)} style={styles.motionButton}>
            <Text style={styles.motionLabel}>{paused ? '▶  Resume fire' : 'Ⅱ  Pause fire'}</Text>
          </Pressable>
        </View>

        <View style={styles.clearing}>
          <View style={styles.rewardCard}>
            <View style={styles.rewardCopy}>
              <Text style={styles.statLabel}>Circle s’mores</Text>
              <Text accessibilityLabel={circleShop ? sMoreRewardLabel(circleShop.balance) : 'Circle balance unavailable'} style={styles.statValue}>{circleShop?.balance ?? '—'}</Text>
              <Pressable accessibilityRole="button" onPress={() => router.push('/customize')} style={styles.walletLink}>
                <Text style={styles.takeBackText}>Customize camper →</Text>
              </Pressable>
            </View>
            <SMoreSprite size={86} decorative />
            <HelpButton title="Earning s’mores">
              <Text>{SMORE_REWARD_EXPLANATION}</Text>
              <Text>Any request skips that day, even if denied or cancelled.</Text>
              <Text>S’mores and unlocked items are shared by everyone in your circle.</Text>
            </HelpButton>
          </View>
          <View style={styles.progressCard}>
            <View style={styles.clearingHeading}>
              <Text style={styles.stateTitle}>Next s’more</Text>
              <Text style={styles.statLabel}>{progress.state === 'earning' ? `${Math.floor(progress.fraction * 100)}% of today` : progress.state === 'burnt' || progress.state === 'waiting' ? 'Tomorrow' : 'Syncing'}</Text>
            </View>
            <View accessibilityRole="progressbar" accessibilityLabel="Circle’s request-free day progress" accessibilityValue={{ min: 0, max: 100, now: Math.floor(progress.fraction * 100), text: progress.label }} style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${progress.fraction * 100}%` }]} />
            </View>
            {/* 'earning' only restates the percentage shown above; the other
                states carry information the bar cannot. The accessible value
                still reads the full label either way. */}
            {progress.state !== 'earning' && <Text style={styles.statLabel}>{progress.label}</Text>}
          </View>

          <View style={styles.clearingHeading}>
            <Text accessibilityRole="header" style={styles.campTitle}>Requests</Text>
            <HelpButton title="Requesting time">
              <Text>One pending request; up to five per hour.</Text>
              <Text>Requests expire in 20 minutes.</Text>
              <Text>{screenTime.available ? 'Manage app limits in the Screen Time tab.' : 'App unlocking is unavailable in this build.'}</Text>
            </HelpButton>
          </View>
          {incomingRequests.length > 0 && <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/friends', params: { section: 'requests' } })} style={styles.incomingButton}>
            <Text style={styles.stateTitle}>{incomingRequests.length} waiting for you</Text><Text style={styles.takeBackText}>Review →</Text>
          </Pressable>}

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || Boolean(outgoingRequest) || askBlockReason !== null }}
            disabled={busy || Boolean(outgoingRequest) || askBlockReason !== null}
            onPress={() => {
              if (askBlockReason) return;
              clearError();
              setRequestOpen(true);
            }}
            style={({ pressed }) => [styles.askPlate, (busy || outgoingRequest || askBlockReason) && styles.disabled, pressed && styles.pressed]}>
            <SymbolView
              name={{ ios: 'flame.fill', android: 'local_fire_department', web: 'local_fire_department' }}
              size={18}
              tintColor={c.onFlame}
            />
            <Text style={styles.askPlateText}>Ask for time</Text>
            <Text style={styles.askPlateText}>→</Text>
          </Pressable>
          {askBlockReason && <View style={styles.previewControls}>
            <Text accessibilityLiveRegion="polite" style={styles.localNote}>{askBlockReason}</Text>
            <Pressable accessibilityRole="button" onPress={() => router.push('/screen-time')} style={styles.takeBack}>
              <Text style={styles.takeBackText}>View Screen Time →</Text>
            </Pressable>
          </View>}
          {!isLocalArtPreview && friends.length === 0 && <Pressable accessibilityRole="button" onPress={() => router.push('/friends')} style={styles.incomingButton}>
            <Text style={styles.stateBody}>Your circle is empty</Text><Text style={styles.takeBackText}>Add friends →</Text>
          </Pressable>}
          {!requestOpen && !panicOpen && error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {panicNotice && <Text accessibilityLiveRegion="polite" style={styles.localNote}>{panicNotice}</Text>}
          {preview && <View style={styles.previewControls}>
            <Text style={styles.localNote}>Campers</Text>
            {[1, 4, 6].map(count => <Pressable key={count} accessibilityRole="button" accessibilityLabel={`Show ${count} campers`}
              accessibilityState={{ selected: preview.count === count }} onPress={() => preview.setCamperCount(count)}
              style={[styles.countChip, preview.count === count && { borderColor: c.ember }]}>
              <Text style={styles.countLabel}>{count}</Text>
            </Pressable>)}
          </View>}
          {preview && <Pressable
            accessibilityRole="button"
            accessibilityLabel={preview.burnt ? 'Show fresh marshmallows' : 'Show burning marshmallows'}
            accessibilityState={{ selected: preview.burnt }}
            onPress={preview.toggleBurnt}
            style={styles.previewBurnButton}>
            <Text style={styles.countLabel}>{preview.burnt ? 'Show fresh marshmallows' : 'Show burning marshmallows'}</Text>
          </Pressable>}
        </View>

        {outgoingRequest && (
          <View style={styles.stateRow}>
            <View style={styles.stateIcon}>
              <SymbolView
                name={{ ios: 'hand.wave.fill', android: 'waving_hand', web: 'waving_hand' }}
                size={18}
                tintColor={c.ember}
              />
            </View>
            <View style={styles.stateCopy}>
              <Text style={styles.stateTitle}>Waiting for approval</Text>
              <Text style={styles.stateBody}>
                {outgoingRequest.minutes} minutes
              </Text>
            </View>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void cancelRequest().catch(() => { /* Store displays the error. */ }); }} style={styles.takeBack}>
              <Text style={styles.takeBackText}>Cancel</Text>
            </Pressable>
          </View>
        )}

        {preview && outgoingRequest && <View style={styles.previewControls}>
          <Text style={styles.localNote}>Response controls</Text>
          <Pressable accessibilityRole="button" onPress={() => { void preview.respondToOutgoing('approved').catch(() => undefined); }} style={styles.previewBurnButton}>
            <Text style={styles.countLabel}>Approve request</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => { void preview.respondToOutgoing('denied').catch(() => undefined); }} style={styles.previewBurnButton}>
            <Text style={styles.countLabel}>Deny request</Text>
          </Pressable>
        </View>}

        {!outgoingRequest && recentDecision && (
          <View
            style={[
              styles.stateRow,
              recentDecision.status === 'approved' ? styles.toastedRow : styles.notTonightRow,
            ]}>
            <View style={styles.stateIcon}>
              <SymbolView
                name={
                  recentDecision.status === 'approved'
                    ? { ios: 'flame.fill', android: 'local_fire_department', web: 'local_fire_department' }
                    : { ios: 'moon.stars.fill', android: 'bedtime', web: 'bedtime' }
                }
                size={18}
                tintColor={recentDecision.status === 'approved' ? c.ember : c.inkSoft}
              />
            </View>
            <View style={styles.stateCopy}>
              <Text style={styles.stateTitle}>
                {recentDecision.status === 'approved' ? 'Request approved' : 'Not tonight'}
              </Text>
              <Text style={styles.stateBody}>
                {preview && recentDecision.status === 'approved'
                  ? `${recentDecision.minutes} extra minutes added in this browser. Phone app limits are unchanged.`
                  : approvalMessage(recentDecision, screenTime)}
              </Text>
            </View>
          </View>
        )}

      </ScrollView>

      <Modal
        animationType="fade"
        transparent
        presentationStyle="overFullScreen"
        visible={panicOpen}
        onRequestClose={() => { if (!panicPending) setPanicOpen(false); }}>
        <View style={styles.panicBackdrop}>
          <View style={styles.panicCard}>
            <Text accessibilityRole="header" style={styles.panicWarning}>
              {panicBlockReason ? 'Panic button unavailable' : 'Are you sure you want to press the panic button?'}
            </Text>
            <Text style={styles.panicCost}>
              {preview ? 'This adds 15 minutes and burns every camper’s marshmallow in this browser. Phone app limits are unchanged and no notifications are sent.'
                : 'This will give you 15 minutes of unrestricted access, but will burn everybody’s marshmallow in the circle and notify everyone that you have used the panic button.'}
            </Text>
            <Text style={styles.panicCost}>
              {panicSMores === 0
                ? 'Your circle has 0 s’mores. Panic access still works, and your balance stays at 0.'
                : 'Costs 1 circle s’more if available. Your balance never goes below 0.'}
            </Text>
            {panicBlockReason && <>
              <Text accessibilityLiveRegion="polite" style={styles.error}>{panicBlockReason}</Text>
              <Pressable accessibilityRole="button" disabled={panicPending}
                onPress={() => { setPanicOpen(false); router.push('/screen-time'); }} style={styles.takeBack}>
                <Text style={styles.takeBackText}>View Screen Time →</Text>
              </Pressable>
            </>}
            {(panicError || error) && <Text accessibilityRole="alert" style={styles.error}>{panicError || error}</Text>}
            <Pressable
              accessibilityRole="button"
              accessibilityHint={panicBlockReason ?? undefined}
              accessibilityState={{ disabled: panicPending || panicBlockReason !== null, busy: panicPending }}
              disabled={panicPending || panicBlockReason !== null}
              onPress={() => { void confirmPanic(); }}
              style={({ pressed }) => [styles.panicConfirm, (panicPending || panicBlockReason !== null) && styles.disabled, pressed && styles.pressed]}>
              <Text style={styles.panicConfirmText}>{panicPending ? 'Burning…' : 'Press the panic button'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={panicPending}
              onPress={() => setPanicOpen(false)}
              style={({ pressed }) => [styles.panicCancel, pressed && styles.pressed]}>
              <Text style={styles.panicCancelText}>Never mind</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        animationType="slide"
        presentationStyle="pageSheet"
        visible={requestOpen}
        onRequestClose={() => { Keyboard.dismiss(); setRequestOpen(false); }}>
        <View style={styles.sheet}>
          <View style={styles.sheetGrip} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Ask for time</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={() => { Keyboard.dismiss(); setRequestOpen(false); }}
              style={styles.closeButton}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={16} tintColor={c.ink} />
            </Pressable>
          </View>
          <KeyboardForm
            style={styles.sheetScroll}
            contentContainerStyle={[styles.sheetContent, { paddingBottom: Math.max(24, insets.bottom) }]}
            contentInsetAdjustmentBehavior="automatic">
          <BlanketBand />

          <View style={styles.cost}>
            <Text style={styles.costText}>
              Your circle misses today’s s’more if you ask, even if cancelled or denied.
            </Text>
          </View>

          <View style={styles.optionGrid}>
            {timeOptions.map((option) => {
              const selected = option === minutes;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => setMinutes(option)}
                  style={({ pressed }) => [styles.option, selected && styles.optionSelected, pressed && styles.pressed]}>
                  <Text style={[styles.optionNumber, selected && styles.optionNumberSelected]}>{option}</Text>
                  <Text style={[styles.optionUnit, selected && styles.optionUnitSelected]}>minutes</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.sheetBody}>{isLocalArtPreview ? 'Requests stay in this browser. They do not notify friends or unlock phone apps.' : screenTime.available ? 'After approval, reopen sumore to apply your break.' : 'Friend approvals only. App unlocking is unavailable in this build.'}</Text>

          <Text style={styles.fieldLabel}>Note (optional)</Text>
          <KeyboardTextInput
            accessibilityLabel="Request note"
            editable={!busy}
            maxLength={240}
            multiline
            onChangeText={setReason}
            placeholder="Why would the extra time help?"
            placeholderTextColor={c.inkSoft}
            selectionColor={c.ember}
            style={styles.noteInput}
            value={reason}
          />

          {error && <Text style={styles.error}>{error}</Text>}
          {askBlockReason && <Text accessibilityLiveRegion="polite" style={styles.localNote}>{askBlockReason}</Text>}

          <View style={styles.sheetFooter}>
            <TinTagWire friends={friends} />
            <Text style={styles.sheetFooterText}>
              {friends.length
                ? `Goes to ${friends.map((friend) => friend.displayName.split(' ')[0]).join(', ')}`
                : 'Add a friend before you ask'}
            </Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || askBlockReason !== null || Boolean(outgoingRequest) }}
            disabled={busy || askBlockReason !== null || Boolean(outgoingRequest)}
            onPress={() => {
              if (friends.length === 0) {
                // A disabled button was the sheet's only exit. Send them where
                // the problem is actually solved instead.
                setRequestOpen(false);
                router.push('/friends');
                return;
              }
              submitRequest();
            }}
            style={({ pressed }) => [
              styles.askPlate,
              styles.sheetSubmit,
              (busy || askBlockReason || outgoingRequest) && styles.disabled,
              pressed && styles.pressed,
            ]}>
            {busy ? (
              <ActivityIndicator color={c.onFlame} />
            ) : (
              <>
                <Text style={styles.askPlateText}>
                  {friends.length ? 'Send request' : 'Add a friend'}
                </Text>
                <SymbolView
                  name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }}
                  size={17}
                  tintColor={c.onFlame}
                />
              </>
            )}
          </Pressable>
          </KeyboardForm>
        </View>
      </Modal>
    </View>
  );
}

const createStyles = (c: AppPalette) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: c.ground },
    content: { paddingBottom: 32, gap: Space.lg },
    hero: { position: 'relative', overflow: 'hidden', backgroundColor: '#03080E' },
    heroHeader: { paddingHorizontal: 24, paddingBottom: 4 },
    brandRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm, justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 },
    brand: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    wordmark: { fontSize: 24, fontWeight: '800', letterSpacing: -1, color: '#FFF3DE' },
    dressUp: { minHeight: 44, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 14, borderRadius: Radius.coal, borderWidth: 1, borderColor: '#2A3D42', backgroundColor: '#102129B8' },
    dressUpText: { color: '#D7E0D6', ...Type.bodySmall, fontWeight: '600' },
    heroTitle: { fontSize: 32, lineHeight: 36, letterSpacing: -1.1, fontWeight: '700', color: '#FFF3DE' },
    heroSubtitle: { fontSize: 12, lineHeight: 18, color: '#ABBEC7', marginTop: 11 },
    previewBadge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 6, marginTop: 15 },
    previewDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#C4D8AD' },
    previewBadgeText: { fontSize: 8, fontWeight: '600', letterSpacing: 1.05, color: '#ABC0BB' },
    motionButton: { position: 'absolute', bottom: 16, right: 22, minHeight: 44, justifyContent: 'center', padding: 12, borderRadius: Radius.coal, backgroundColor: '#07151FB8', borderWidth: 1, borderColor: '#60706840' },
    motionLabel: { ...Type.bodySmall, color: '#BCD0C4', fontWeight: '500' },
    clearing: { gap: Space.md, paddingHorizontal: Space.lg, paddingTop: Space.xs },
    rewardCard: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Space.sm, backgroundColor: c.wool, borderWidth: 1, borderColor: c.seam, borderRadius: Radius.blanket, padding: Space.md },
    progressCard: { gap: Space.sm, backgroundColor: c.woolDeep, borderWidth: 1, borderColor: c.seam, borderRadius: Radius.blanket, padding: Space.md, marginBottom: Space.xs },
    progressTrack: { height: 10, borderRadius: 5, overflow: 'hidden', backgroundColor: c.seam },
    progressFill: { height: '100%', borderRadius: 5, backgroundColor: c.ember },
    incomingButton: { minHeight: 50, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: Space.xs, padding: Space.sm, borderRadius: Radius.fold, backgroundColor: c.wool, borderWidth: 1, borderColor: c.seam },
    clearingHeading: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs, justifyContent: 'space-between', alignItems: 'center' },
    tonightLabel: { color: '#A6B5A6', letterSpacing: 1.7, fontSize: 10, fontWeight: '600' },
    tonightPill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#162A28', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 20 },
    tonightPillText: { fontSize: 10, color: '#B4C9AD' },
    campTitle: { color: c.ink, fontWeight: '700', fontSize: 25, letterSpacing: -0.7 },
    statsRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, paddingVertical: 18, borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.seam },
    stat: { flex: 1, gap: 6 },
    rewardStat: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
    rewardCopy: { flex: 1, minWidth: 100, gap: 6 },
    walletLink: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    rewardHint: { fontSize: 11, lineHeight: 17, color: c.inkSoft },
    statValue: { fontSize: 38, lineHeight: 44, fontWeight: '800', color: '#FFE2AB', fontVariant: ['tabular-nums'], letterSpacing: -1.2 },
    statLabel: { ...Type.bodySmall, color: c.inkSoft },
    statDivider: { height: 32, width: 1, backgroundColor: c.seam, marginRight: 22 },
    localNote: { ...Type.bodySmall, color: c.inkSoft, textAlign: 'center' },
    previewControls: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 8, paddingTop: 10 },
    previewBurnButton: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, marginTop: 8, borderRadius: Radius.coal, borderWidth: 1, borderColor: c.seam, backgroundColor: c.wool },
    countChip: { borderWidth: 1, borderColor: c.seam, borderRadius: Radius.fold, minWidth: 44, minHeight: 44, padding: Space.xs, alignItems: 'center', justifyContent: 'center' },
    countLabel: { color: c.ink, fontSize: 12 },
    clearingLine: {
      ...Type.body,
      color: c.inkSoft,
      fontSize: 13,
      lineHeight: 21,
    },
    tally: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
    tallyMallow: {
      width: 13,
      height: 16,
      borderRadius: 5,
      backgroundColor: c.toast,
    },
    tallyCount: { ...Type.heading, color: c.ink },
    tallyLabel: { ...Type.bodySmall, color: c.inkSoft, flexShrink: 1 },
    cost: {
      marginTop: Space.md,
      padding: Space.sm,
      borderRadius: Radius.tin,
      backgroundColor: c.emberWash,
      borderWidth: 1,
      borderColor: c.emberLow,
    },
    costText: { ...Type.bodySmall, color: c.ink },

    askPlate: {
      alignSelf: 'stretch',
      minHeight: 56,
      borderRadius: Radius.fold,
      backgroundColor: c.ember,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      padding: Space.sm,
      marginTop: Space.xs,
      ...Shadow.rest,
    },
    askPlateText: { ...Type.control, color: c.onFlame },
    pressed: { opacity: 0.86, transform: [{ scale: 0.995 }] },
    disabled: { opacity: 0.55 },

    stateRow: {
      marginHorizontal: 24,
      flexDirection: 'row',
      alignItems: 'center',
      gap: Space.sm,
      padding: Space.md,
      borderRadius: Radius.blanket,
      backgroundColor: c.wool,
      borderWidth: 1,
      borderColor: c.seam,
    },
    toastedRow: { backgroundColor: c.emberWash, borderColor: c.emberLow },
    notTonightRow: { backgroundColor: c.wool, borderColor: c.seam },
    stateIcon: {
      width: 40,
      height: 40,
      borderRadius: Radius.tin,
      backgroundColor: c.woolDeep,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stateCopy: { flex: 1, gap: 2 },
    stateTitle: { ...Type.control, color: c.ink },
    stateBody: { ...Type.bodySmall, color: c.inkSoft },
    takeBack: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4, paddingVertical: 8 },
    takeBackText: { ...Type.meter, color: c.ember },

    note: { gap: Space.sm, paddingTop: Space.xs, marginHorizontal: 24 },
    noteTitle: { ...Type.heading, color: c.ink, marginTop: Space.xs },
    noteBody: { ...Type.body, color: c.inkSoft },

    sheet: { flex: 1, backgroundColor: c.ground, paddingHorizontal: Space.lg },
    sheetScroll: { flex: 1 },
    sheetContent: { flexGrow: 1 },
    sheetGrip: {
      width: 36,
      height: 4,
      borderRadius: 2,
      alignSelf: 'center',
      backgroundColor: c.edge,
      marginTop: 10,
      marginBottom: Space.lg,
    },
    sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Space.sm },
    sheetTitle: { ...Type.title, color: c.ink, flex: 1 },
    closeButton: {
      width: 44,
      height: 44,
      borderRadius: Radius.coal,
      backgroundColor: c.woolDeep,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sheetBody: { ...Type.body, color: c.inkSoft, marginTop: Space.md },

    optionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm, marginTop: Space.lg },
    option: {
      flexBasis: '46%',
      flexGrow: 1,
      minHeight: 96,
      padding: Space.sm,
      borderRadius: Radius.fold,
      backgroundColor: c.wool,
      borderWidth: 1,
      borderColor: c.seam,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
    },
    optionSelected: { backgroundColor: c.ember, borderColor: c.ember, ...Shadow.rest },
    optionNumber: { ...Type.beacon, fontSize: 38, lineHeight: 42, color: c.ink },
    optionNumberSelected: { color: c.onFlame },
    optionUnit: { ...Type.bodySmall, color: c.inkSoft },
    optionUnitSelected: { color: c.onFlame, opacity: 0.85 },

    fieldLabel: { ...Type.control, color: c.ink, marginTop: Space.lg, marginBottom: Space.xs },
    noteInput: {
      minHeight: 76,
      maxHeight: 110,
      borderRadius: Radius.fold,
      backgroundColor: c.wool,
      borderWidth: 1,
      borderColor: c.seam,
      color: c.ink,
      ...Type.body,
      padding: Space.sm,
      textAlignVertical: 'top',
    },
    error: {
      ...Type.bodySmall,
      color: c.scarlet,
      backgroundColor: c.emberWash,
      borderRadius: Radius.tin,
      padding: Space.sm,
      marginTop: Space.sm,
    },

    sheetFooter: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, marginTop: 'auto', paddingTop: Space.lg, marginBottom: Space.md },
    sheetFooterText: { ...Type.bodySmall, color: c.inkSoft, flex: 1 },
    // Bottom-left of the scene, mirroring Pause fire on the right at the same
  // inset. Small and apart from Ask for time, which stays the ordinary path.
  panicButton: {
    position: 'absolute', bottom: 16, left: 22,
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: c.scarlet,
  },
  panicBackdrop: { flex: 1, padding: Space.md, backgroundColor: 'rgba(0, 0, 0, 0.72)', alignItems: 'center', justifyContent: 'center' },
  panicCard: {
    width: '100%', maxWidth: 520, gap: Space.sm, padding: Space.lg,
    borderRadius: Radius.blanket, borderWidth: 1, borderColor: c.seam, backgroundColor: c.wool,
  },
  panicWarning: { ...Type.heading, color: c.ink },
  panicCost: { ...Type.bodySmall, color: c.inkSoft },
  panicConfirm: {
    minHeight: 48, borderRadius: Radius.coal, backgroundColor: c.scarlet,
    alignItems: 'center', justifyContent: 'center', marginTop: Space.xs,
  },
  panicConfirmText: { ...Type.control, color: c.mallow },
  panicCancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  panicCancelText: { ...Type.control, color: c.inkSoft },
  sheetSubmit: { marginTop: 0 },
  });
