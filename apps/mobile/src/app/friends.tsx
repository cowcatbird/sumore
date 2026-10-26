import { SymbolView } from 'expo-symbols';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { BlanketBand } from '@/components/blanket-band';
import { LocalPreviewBanner } from '@/components/local-preview-banner';
import { CircleAllocations } from '@/components/circle-allocations';
import { CircleMemberControls, CircleMemberMenuButton } from '@/components/circle-member-controls';
import { CircleRequests, RequestsHelp } from '@/components/circle-requests';
import { CommunityRulesNotice } from '@/components/community-rules';
import { FriendCodeActions } from '@/components/friend-code-actions';
import { HelpButton } from '@/components/help-button';
import { KeyboardForm, KeyboardTextInput } from '@/components/keyboard-form';
import { ScreenHeader } from '@/components/screen-header';
import { formControlStyle } from '@/constants/form-layout';
import { Radius, Space, Type, stripeFor, useAppColors, type AppPalette } from '@/constants/theme';
import { isFriendCodeVisible, toggleFriendCode, type FriendCodeReveal } from '@/domain/friend-code-visibility';
import { useApp } from '@/features/app-store';
import { isLocalArtPreview } from '@/features/local-art-preview';

export default function FriendsScreen() {
  const { profile } = useApp();
  return <CircleScreen key={profile.id} />;
}

function CircleScreen() {
  const { joinSharedCircle, circleShop, busy, clearError, error, friends, incomingRequests, profile } = useApp();
  const params = useLocalSearchParams<{ section?: string | string[]; invite?: string | string[] }>();
  const sectionParam = Array.isArray(params.section) ? params.section[0] : params.section;
  const inviteParam = Array.isArray(params.invite) ? params.invite[0] : params.invite;
  const [section, setSection] = useState<'friends' | 'requests'>(sectionParam === 'requests' ? 'requests' : 'friends');
  const inviteConsumed = useRef(false);
  const c = useAppColors();
  const styles = useMemo(() => createStyles(c), [c]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joined, setJoined] = useState(false);
  const [confirmJoin, setConfirmJoin] = useState(false);
  const [revealedCode, setRevealedCode] = useState<FriendCodeReveal>(null);
  const codeVisible = isFriendCodeVisible(revealedCode, profile.id, profile.friendCode);

  const openInvite = useCallback(() => {
    clearError();
    setJoined(false);
    setConfirmJoin(false);
    setJoinCode('');
    setRevealedCode(null);
    setInviteOpen(true);
  }, [clearError]);

  useFocusEffect(useCallback(() => {
    if (sectionParam === 'friends' || sectionParam === 'requests') setSection(sectionParam);
    if (inviteParam === '1' && !inviteConsumed.current) {
      inviteConsumed.current = true;
      setSection('friends');
      openInvite();
      // Consume the tour action so refocusing or receiving a snapshot cannot reopen it.
      router.setParams({ invite: undefined, section: 'friends' });
    } else if (inviteParam !== '1') {
      inviteConsumed.current = false;
    }
  }, [inviteParam, sectionParam, openInvite]));

  useFocusEffect(useCallback(() => {
    const ownerId = profile.id;
    return () => setRevealedCode(current => current?.ownerId === ownerId ? null : current);
  }, [profile.id]));

  const closeInvite = () => {
    Keyboard.dismiss();
    clearError();
    setInviteOpen(false);
    setJoinCode('');
    setJoined(false);
    setConfirmJoin(false);
  };

  const joinCircle = async () => {
    if (busy || !circleShop || joinCode.trim().length < 4) return;
    Keyboard.dismiss();
    if (!confirmJoin) { setConfirmJoin(true); return; }
    try {
      await joinSharedCircle(joinCode);
      setJoined(true);
      setConfirmJoin(false);
      setJoinCode('');
    } catch {
      // The store renders the friendly error.
    }
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.page}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}>
        <ScreenHeader
          title="Your circle"
          action={section === 'requests' ? <RequestsHelp /> : <HelpButton title="Your circle">
            <Text>Share codes only with trusted friends. App selections and usage stay private. You can share labels you type yourself.</Text>
            <Text>Use a member’s code to join their circle.</Text>
            <Text>Everyone shares s’mores, unlocks and the campsite.</Text>
          </HelpButton>}
        />

        <CommunityRulesNotice />

        <View accessibilityRole="tablist" style={styles.sections}>
          {(['friends', 'requests'] as const).map(value => (
            <Pressable key={value} accessibilityRole="tab"
              accessibilityLabel={value === 'friends' ? 'Friends' : `Requests, ${incomingRequests.length} pending`}
              accessibilityState={{ selected: section === value }}
              onPress={() => {
                setSection(value);
                if (value === 'requests') setRevealedCode(null);
                router.setParams({ section: value });
              }}
              style={[styles.section, section === value && styles.selectedSection]}>
              <Text style={[styles.sectionText, section === value && styles.selectedSectionText]}>{value === 'friends' ? 'Friends' : 'Requests'}</Text>
              {value === 'requests' && incomingRequests.length > 0 && <View style={styles.badge}>
                <Text style={styles.badgeText}>{incomingRequests.length}</Text>
              </View>}
            </Pressable>
          ))}
        </View>

        {section === 'requests' ? <CircleRequests /> : <>

        <LocalPreviewBanner />

        <View style={styles.rosterHeading}>
          <Text accessibilityRole="header" style={styles.rosterTitle}>Your people</Text>
          <Text style={styles.friendCount}>
            {friends.length
              ? `${friends.length} ${friends.length === 1 ? 'friend' : 'friends'}`
              : 'Just you, for now'}
          </Text>
        </View>

        <CircleMemberControls>{friends.length ? (
          <View style={styles.roster}>
            {friends.map((friend, index) => (
              <View
                key={friend.id}
                style={[styles.person, index < friends.length - 1 && styles.personSeam]}>
                <View style={[styles.tag, { backgroundColor: avatarColors[stripeFor(friend.id)] }]}>
                  <Text style={styles.tagInitials}>{friend.initials}</Text>
                </View>
                <View style={styles.personCopy}>
                  <Text style={styles.personName}>{friend.displayName}</Text>
                </View>
                <CircleMemberMenuButton personId={friend.id} displayName={friend.displayName} />
              </View>
            ))}
          </View>
        ) : <Text style={styles.emptyCopy}>A little encouragement goes a long way. Invite someone to start your circle.</Text>}</CircleMemberControls>

        <View style={styles.inviteCard}>
          <View style={styles.inviteHeading}>
            <View style={styles.addMark}>
              <SymbolView name={{ ios: 'person.2.fill', android: 'group', web: 'group' }} size={22} tintColor={c.ember} />
            </View>
            <View style={styles.addCopy}>
              <Text accessibilityRole="header" style={styles.addTitle}>Better with friends</Text>
              <Text style={styles.addBody}>One code brings you together.</Text>
            </View>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Invite or join friends" onPress={openInvite}
            style={({ pressed }) => [styles.inviteButton, pressed && styles.pressed]}>
            <Text style={styles.inviteButtonText}>Invite or join</Text>
            <SymbolView name={{ ios: 'arrow.right', android: 'arrow_forward', web: 'arrow_forward' }} size={18} tintColor={c.onFlame} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={codeVisible ? 'Hide your friend code' : 'Show your friend code'}
            accessibilityState={{ expanded: codeVisible, disabled: !profile.friendCode }}
            accessibilityValue={codeVisible ? { text: profile.friendCode } : undefined}
            disabled={!profile.friendCode}
            onPress={() => setRevealedCode(previous => toggleFriendCode(previous, profile.id, profile.friendCode))}
            style={({ pressed }) => [styles.codePlate, pressed && styles.pressed]}>
            <Text style={styles.codeCaption}>Your friend code</Text>
            <View style={styles.codeValueRow}>
              <Text style={[styles.codePlateValue, codeVisible && styles.revealedCode]}>{codeVisible ? profile.friendCode : 'Tap to reveal'}</Text>
              <SymbolView name={{ ios: codeVisible ? 'eye.slash' : 'eye', android: codeVisible ? 'visibility_off' : 'visibility', web: codeVisible ? 'visibility_off' : 'visibility' }} size={16} tintColor={c.inkSoft} />
            </View>
          </Pressable>
          {codeVisible && <FriendCodeActions key={profile.friendCode} code={profile.friendCode} disabled={busy} demo={isLocalArtPreview} />}
        </View>

        <CircleAllocations />
        </>}
      </ScrollView>

      <Modal animationType="slide" onRequestClose={closeInvite} presentationStyle="pageSheet" visible={inviteOpen}>
        <SafeAreaProvider>
        <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.page}>
        <KeyboardForm contentContainerStyle={styles.sheet} contentInsetAdjustmentBehavior="never">
          <View style={styles.sheetGrip} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Friend codes</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={closeInvite} style={styles.closeButton}>
              <SymbolView name={{ ios: 'xmark', android: 'close', web: 'close' }} size={16} tintColor={c.ink} />
            </Pressable>
          </View>
          <BlanketBand />

          <View style={styles.block}>
            <View style={styles.blockHeading}>
              <Text style={styles.blockTitle}>Your code</Text>
              <HelpButton title="Friend codes">
                <Text>Your friend code is randomly generated when your account is created and cannot be changed.</Text>
                <Text>Share it with trusted friends so they can join your circle. This is not your private login key.</Text>
              </HelpButton>
            </View>
            <Text style={styles.blockBody}>Your permanent friend code. It cannot be changed.</Text>
            <View style={styles.codeDisplay}>
              <Text selectable accessibilityLabel={`Your friend code: ${profile.friendCode || 'Not available'}`} style={styles.codeText}>
                {profile.friendCode || 'Not available'}
              </Text>
            </View>
            <FriendCodeActions key={profile.friendCode} code={profile.friendCode}
              disabled={busy} demo={isLocalArtPreview} />
          </View>

          <View style={styles.block}>
            <Text style={styles.blockTitle}>Join a circle</Text>
            <Text style={styles.blockBody}>{isLocalArtPreview ? 'Use SCOUT in this browser. Other friend codes work in the installed app.' : circleShop ? 'Enter a member’s friend code.' : 'Shared circles need the updated server.'}</Text>
            <KeyboardTextInput
              accessibilityLabel="Your friend’s code"
              autoCapitalize="characters"
              autoCorrect={false}
              editable={!busy}
              returnKeyType="done"
              onSubmitEditing={joinCircle}
              maxLength={16}
              onChangeText={(value) => {
                clearError();
                setJoined(false);
                setConfirmJoin(false);
                setJoinCode(value.toUpperCase().replace(/[^A-Z0-9]/g, ''));
              }}
              placeholder="A1B2C3D4"
              placeholderTextColor={c.inkSoft}
              selectionColor={c.ember}
              style={styles.codeInput}
              value={joinCode}
            />
            <Pressable
              accessibilityRole="button"
              disabled={busy || !circleShop || joinCode.trim().length < 4}
              onPress={joinCircle}
              style={({ pressed }) => [
                styles.secondary,
                (busy || !circleShop || joinCode.trim().length < 4) && styles.disabled,
                pressed && styles.pressed,
              ]}>
              <Text style={styles.secondaryText}>{confirmJoin ? 'Confirm and join' : 'Join circle'}</Text>
            </Pressable>
            {confirmJoin && <View accessibilityLiveRegion="polite">
              <Text style={styles.blockBody}>{isLocalArtPreview ? 'This changes your circle in this browser only. Your s’mores and unlocks stay saved.' : 'Only you will move. Your old circle keeps its s’mores and unlocks.'}</Text>
              <Pressable accessibilityRole="button" onPress={() => setConfirmJoin(false)} style={styles.secondary}>
                <Text style={styles.secondaryText}>Stay in my circle</Text>
              </Pressable>
            </View>}
            {joined && <Text accessibilityLiveRegion="polite" style={styles.success}>{isLocalArtPreview ? 'Circle joined in this browser.' : 'Circle joined.'}</Text>}
          </View>

          {error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        </KeyboardForm>
        </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </SafeAreaView>
  );
}

// Stable, gentle color accents keep people distinct without implying activity/status.
const avatarColors = { indigo: '#BED5EB', emerald: '#BFDDD0', gold: '#F0D7A2', scarlet: '#EBC2BA' };

const createStyles = (c: AppPalette) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: c.ground },
    content: { paddingHorizontal: Space.lg, paddingBottom: 120, gap: Space.md },
    sections: { flexDirection: 'row', gap: Space.lg, borderBottomWidth: 1, borderBottomColor: c.seam },
    section: { flex: 1, minHeight: 48, padding: Space.xs, flexDirection: 'row', flexWrap: 'wrap', gap: Space.xs, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 3, borderBottomColor: 'transparent' },
    selectedSection: { borderBottomColor: c.ember },
    sectionText: { ...Type.control, color: c.inkSoft },
    selectedSectionText: { color: c.ember },
    badge: { minWidth: 22, height: 22, paddingHorizontal: 5, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: c.ember },
    badgeText: { color: c.onFlame, fontSize: 12, fontWeight: '700' },

    rosterHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: Space.xs, marginTop: Space.xs },
    rosterTitle: { ...Type.heading, color: c.ink },
    friendCount: { ...Type.bodySmall, color: c.inkSoft },
    emptyCopy: { ...Type.body, color: c.inkSoft },
    codePlate: {
      minHeight: 44,
      paddingVertical: Space.xs,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: Space.xs,
    },
    codeCaption: { ...Type.bodySmall, color: c.inkSoft },
    codeValueRow: { flexDirection: 'row', alignItems: 'center', gap: Space.xs, flexShrink: 1 },
    codePlateValue: { ...Type.bodySmall, fontWeight: '700', color: c.ink, flexShrink: 1 },
    revealedCode: { letterSpacing: 1, color: c.ember },

    roster: { gap: 2 },
    person: { minHeight: 70, paddingVertical: Space.sm, flexDirection: 'row', alignItems: 'center', gap: Space.sm },
    personSeam: { borderBottomWidth: 1, borderBottomColor: c.seam },
    tag: {
      width: 44,
      height: 44,
      borderRadius: Radius.coal,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tagInitials: { ...Type.control, color: c.onPastel, letterSpacing: 0.6 },
    personCopy: { flex: 1, minWidth: 0, gap: 4 },
    personName: { ...Type.control, color: c.ink },

    inviteCard: {
      gap: Space.sm,
      padding: Space.md,
      borderRadius: Radius.blanket,
      backgroundColor: c.wool,
      borderTopWidth: 2,
      borderTopColor: c.emberLow,
    },
    inviteHeading: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
    inviteButton: { minHeight: 48, paddingHorizontal: Space.md, paddingVertical: Space.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Space.xs, borderRadius: Radius.fold, backgroundColor: c.ember },
    inviteButtonText: { ...Type.control, color: c.onFlame, flexShrink: 1 },
    addMark: {
      width: 42,
      height: 42,
      borderRadius: Radius.coal,
      backgroundColor: c.emberWash,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addCopy: { flex: 1, minWidth: 0, gap: 4 },
    addTitle: { ...Type.control, color: c.ink },
    addBody: { ...Type.bodySmall, color: c.inkSoft },

    sheet: { flexGrow: 1, backgroundColor: c.ground, paddingHorizontal: Space.lg, paddingBottom: 36, gap: Space.md },
    sheetGrip: {
      width: 36,
      height: 4,
      borderRadius: 2,
      alignSelf: 'center',
      backgroundColor: c.edge,
      marginTop: 10,
      marginBottom: Space.xs,
    },
    sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    sheetTitle: { ...Type.title, color: c.ink, flex: 1 },
    closeButton: {
      width: 44,
      height: 44,
      borderRadius: Radius.coal,
      backgroundColor: c.woolDeep,
      alignItems: 'center',
      justifyContent: 'center',
    },

    block: { gap: Space.xs, paddingTop: Space.sm },
    blockHeading: { flexDirection: 'row', alignItems: 'center', gap: Space.xs },
    blockTitle: { ...Type.heading, color: c.ink, flexShrink: 1 },
    blockBody: { ...Type.bodySmall, color: c.inkSoft, marginBottom: Space.xs },
    codeInput: {
      ...formControlStyle,
      backgroundColor: c.wool,
      borderWidth: 1,
      borderColor: c.seam,
      color: c.ink,
      ...Type.heading,
      letterSpacing: 2,
    },
    codeDisplay: {
      ...formControlStyle,
      backgroundColor: c.wool,
      borderWidth: 1,
      borderColor: c.seam,
      alignItems: 'center',
      justifyContent: 'center',
    },
    codeText: { ...Type.heading, color: c.ember, letterSpacing: 2, textAlign: 'center' },
    secondary: {
      ...formControlStyle,
      backgroundColor: c.woolDeep,
      borderWidth: 1,
      borderColor: c.seam,
      flexDirection: 'row',
      gap: 8,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: Space.xs,
    },
    secondaryText: { ...Type.control, color: c.ember },
    success: { ...Type.bodySmall, color: c.emerald, marginTop: Space.xs },
    error: {
      ...Type.bodySmall,
      color: c.scarlet,
      backgroundColor: c.emberWash,
      borderRadius: Radius.tin,
      padding: Space.sm,
    },
    pressed: { opacity: 0.86, transform: [{ scale: 0.995 }] },
    disabled: { opacity: 0.55 },
  });
