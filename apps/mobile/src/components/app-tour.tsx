import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { AccessibilityInfo, Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { TabView } from 'react-native-tab-view';
import { SymbolView } from 'expo-symbols';
import { router } from 'expo-router';

import { BrandLogo, CharacterSprite, HatSprite } from '@/components/character-sprite';
import { SMoreSprite } from '@/components/smore-sprite';
import { Radius, Space, useAppColors } from '@/constants/theme';
import { appTourSlides, type TourActivity, type TourIllustration } from '@/domain/app-tour-content';
import { createTourPagerNavigation } from '@/domain/app-tour-gesture';
import { createAppTourState } from '@/domain/app-tour-state';
import { isValidDisplayName } from '@/domain/profile';
import { useApp } from '@/features/app-store';
import { appStorage } from '@/lib/storage';

const AppTourContext = createContext<{ openTour: () => void } | null>(null);

export function useAppTour() {
  const value = useContext(AppTourContext);
  if (!value) throw new Error('useAppTour must be used inside AppTourProvider');
  return value;
}

export function AppTourProvider({ children }: PropsWithChildren) {
  const c = useAppColors();
  const insets = useSafeAreaInsets();
  const { isReady, isAuthenticated, profile } = useApp();
  const [tour] = useState(() => createAppTourState(appStorage));
  const pendingNavigation = useRef<{ owner: string; activity: TourActivity } | null>(null);
  const state = useSyncExternalStore(tour.subscribe, tour.getSnapshot, tour.getSnapshot);
  // A confirmed, valid profile is enough. Background profile polling must not
  // close an open tour or reset it to the first slide every ten seconds.
  const profileId = isReady && isAuthenticated && profile.id && isValidDisplayName(profile.displayName) ? profile.id : null;
  useLayoutEffect(() => {
    pendingNavigation.current = null;
    tour.bindProfile(profileId);
    return () => tour.invalidate();
  }, [profileId, tour]);
  const context = useMemo(() => ({ openTour: () => { Keyboard.dismiss(); tour.openTour(); } }), [tour]);
  const visible = Boolean(profileId && state.profileId === profileId && state.visible);
  const activityVisible = Boolean(profileId && state.profileId === profileId && !state.visible && state.activity);
  const stepTour = useCallback((step: number) => {
    if (profileId && tour.getSnapshot().profileId === profileId) tour.setStep(step);
  }, [profileId, tour]);
  const navigateActivity = useCallback(() => {
    const pending = pendingNavigation.current;
    pendingNavigation.current = null;
    const current = tour.getSnapshot();
    if (!pending || current.profileId !== pending.owner || current.visible || current.activity !== pending.activity) return;
    try {
      if (pending.activity === 'friends') router.push({ pathname: '/friends', params: { invite: '1', section: 'friends' } });
      else router.push('/customize');
    } catch {
      tour.resumeActivity(pending.owner, false);
    }
  }, [tour]);
  useEffect(() => {
    // iOS must finish dismissing this modal before Circle opens its invite
    // sheet. Android/web dispatch after the hidden modal has committed.
    if (!activityVisible || Platform.OS === 'ios') return;
    const frame = requestAnimationFrame(navigateActivity);
    return () => cancelAnimationFrame(frame);
  }, [activityVisible, navigateActivity, state.activity]);
  const openActivity = (activity: TourActivity) => {
    Keyboard.dismiss();
    if (profileId && tour.suspendActivity(activity, profileId)) pendingNavigation.current = { owner: profileId, activity };
  };
  return <AppTourContext.Provider value={context}>
    <View style={{ flex: 1 }}>
      {activityVisible && <View style={{ paddingTop: insets.top + 8, paddingBottom: 8, paddingHorizontal: 16, backgroundColor: c.wool }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Continue tour" accessibilityHint="Resume at the next tour step"
          onPress={() => { Keyboard.dismiss(); tour.resumeActivity(profileId); }}
          style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.coal, backgroundColor: c.ember }}>
          <Text style={{ color: c.onFlame, fontSize: 16, fontWeight: '700' }}>Continue tour</Text>
        </Pressable>
      </View>}
      <View style={{ flex: 1, minHeight: 0 }}>{children}</View>
    </View>
    <TourModal key={profileId ?? 'unbound'} visible={visible} step={state.step} onStep={stepTour}
      onFinish={() => { if (profileId && tour.getSnapshot().profileId === profileId) void tour.complete(); }}
      onActivity={openActivity} onDismiss={navigateActivity} />
  </AppTourContext.Provider>;
}

function TourIllustrationView({ kind, compact }: { kind: TourIllustration; compact: boolean }) {
  const c = useAppColors();
  const size = compact ? 72 : 92;
  const camper = (hat: 'cowboy' | 'cat' | 'crown' | 'none', burnt = false) => <CharacterSprite
    appearance={{ hat, body: hat === 'cat' ? 'short' : 'tall' }} size={size} burnt={burnt} animated={false} />;
  return <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ minHeight: compact ? 128 : 170, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }}>
    {kind === 'circle' && <>{camper('cowboy')}{camper('none')}{camper('cat')}</>}
    {kind === 'request' && <>{camper('none', true)}<View style={{ gap: 10 }}>
      {['15 min', '30 min'].map(label => <View key={label} style={{ borderRadius: Radius.coal, paddingVertical: 12, paddingHorizontal: 18, backgroundColor: c.emberWash }}>
        <Text allowFontScaling={false} style={{ color: c.ember, fontSize: 22, fontWeight: '700' }}>{label}</Text>
      </View>)}
    </View></>}
    {kind === 'limits' && <>{camper('cowboy')}<View style={{ alignItems: 'center', padding: 14, borderRadius: Radius.blanket, backgroundColor: c.woolDeep }}>
      <SymbolView name={{ ios: 'hourglass', android: 'hourglass_empty', web: 'hourglass_empty' }} size={42} tintColor={c.ember} />
      <Text allowFontScaling={false} style={{ color: c.inkSoft, fontSize: 15 }}>daily limit</Text>
    </View></>}
    {kind === 'reward' && <>{camper('none')}<Text allowFontScaling={false} style={{ color: c.ember, fontSize: 28 }}>→</Text><SMoreSprite size={compact ? 90 : 110} decorative /></>}
    {kind === 'customize' && <>{camper('crown')}<View style={{ flexDirection: 'row', gap: 8 }}><HatSprite hat="cat" size={58} shaded /><HatSprite hat="cowboy" size={58} shaded /></View></>}
    {kind === 'login' && <View style={{ padding: 24, borderRadius: Radius.blanket, backgroundColor: c.wool, alignItems: 'center', gap: 18 }}>
      <SymbolView name={{ ios: 'key.fill', android: 'key', web: 'key' }} size={50} tintColor={c.ember} />
      <Text style={{ color: c.ink, fontSize: 24, letterSpacing: 4 }}>•••• •••• ••••</Text>
    </View>}
  </View>;
}

const tourTabs = [
  { label: 'Camp', ios: 'flame', android: 'local_fire_department' },
  { label: 'Screen Time', ios: 'hourglass', android: 'hourglass_empty' },
  { label: 'Circle', ios: 'person.2', android: 'group' },
  { label: 'Setup', ios: 'gearshape', android: 'settings' },
] as const;
const highlightedTab: Record<TourIllustration, string> = { circle: 'Circle', request: 'Camp', limits: 'Screen Time', reward: 'Camp', customize: 'Camp', login: 'Setup' };

function TourTabPreview({ kind, compact }: { kind: TourIllustration; compact: boolean }) {
  const c = useAppColors();
  return <View accessible accessibilityLabel={`Navigation guide. ${highlightedTab[kind]} highlighted.`}
    pointerEvents="none" style={{ flexDirection: 'row', paddingVertical: 13, borderTopWidth: 1, borderTopColor: c.seam, backgroundColor: c.wool }}>
    {tourTabs.map(tab => {
      const color = highlightedTab[kind] === tab.label ? c.ember : c.inkSoft;
      return <View key={tab.label} style={{ flex: 1, flexBasis: 0, minWidth: 0, alignItems: 'center' }}>
        <View style={{ width: 26, height: 26, flexShrink: 0, alignItems: 'center', justifyContent: 'center' }}>
          <SymbolView name={{ ios: tab.ios, android: tab.android, web: tab.android }} size={tab.label === 'Screen Time' ? 20 : 22} tintColor={color}
            style={tab.label === 'Screen Time' ? { transform: [{ translateY: 2 }] } : undefined} />
        </View>
        <Text allowFontScaling={false} accessibilityLabel={tab.label} numberOfLines={2}
          style={{ color, width: '100%', height: compact ? 26 : 16, flexShrink: 0, paddingTop: 2, lineHeight: 12, fontSize: compact ? 10 : 11, fontWeight: '700', textAlign: 'center' }}>
          {compact && tab.label === 'Screen Time' ? 'Screen\nTime' : tab.label}
        </Text>
      </View>;
    })}
  </View>;
}

function TourModal({ visible, step, onStep, onFinish, onActivity, onDismiss }: {
  visible: boolean; step: number; onStep: (step: number) => void; onFinish: () => void;
  onActivity: (activity: TourActivity) => void; onDismiss: () => void;
}) {
  const c = useAppColors();
  const { height, width } = useWindowDimensions();
  const slides = useMemo(() => appTourSlides(Platform.OS), []);
  const routes = useMemo(() => slides.map((item, index) => ({ key: item.id, index })), [slides]);
  const slide = slides[step];
  const [reduceMotion, setReduceMotion] = useState(true);
  const [screenReader, setScreenReader] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(Keyboard.isVisible());
  const [touchBlocked, setTouchBlocked] = useState(false);
  const swipeEnabled = visible && !screenReader && !keyboardVisible && !touchBlocked;
  const pager = useRef({ navigation: createTourPagerNavigation(slides.length), jumpTo: null as ((key: string) => void) | null,
    step, onStep });
  const setPagerController = useCallback((jumpTo: ((key: string) => void) | null) => { pager.current.jumpTo = jumpTo; }, []);
  const inputFocused = () => Boolean(typeof TextInput.State.currentlyFocusedInput === 'function'
    ? TextInput.State.currentlyFocusedInput() : TextInput.State.currentlyFocusedField());
  useLayoutEffect(() => {
    pager.current.step = step;
    pager.current.onStep = onStep;
    pager.current.navigation.update(step, swipeEnabled);
  }, [onStep, step, swipeEnabled]);
  useEffect(() => {
    let alive = true;
    let motionChanged = false;
    let readerChanged = false;
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      motionChanged = true; setReduceMotion(value);
    });
    // RN Web's screen-reader API always returns true; browsers cannot detect it.
    const reader = Platform.OS === 'web' ? null : AccessibilityInfo.addEventListener('screenReaderChanged', value => {
      readerChanged = true; setScreenReader(value);
    });
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (alive && !motionChanged) setReduceMotion(value);
    }).catch(() => undefined);
    if (Platform.OS !== 'web') AccessibilityInfo.isScreenReaderEnabled().then(value => {
      if (alive && !readerChanged) setScreenReader(value);
    }).catch(() => undefined);
    const current = pager.current;
    return () => {
      alive = false; current.navigation.update(current.step, false); current.jumpTo = null;
      motion.remove(); reader?.remove(); show.remove(); hide.remove();
    };
  }, []);
  const styles = useMemo(() => StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.ground },
    page: { width: '100%', maxWidth: 520, alignSelf: 'center', flex: 1 },
    header: { paddingHorizontal: Space.md, paddingVertical: Space.sm, minHeight: 60, flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
    brand: { flex: 1, color: c.inkSoft, fontSize: 15, fontWeight: '600' },
    pager: { flex: 1, minHeight: 0 },
    scroll: { flex: 1 },
    content: { flexGrow: 1, paddingHorizontal: Space.lg, paddingBottom: Space.lg, justifyContent: 'center', gap: Space.md },
    step: { color: c.ember, fontSize: 13, fontWeight: '700', textAlign: 'center' },
    title: { color: c.ink, fontSize: 30, lineHeight: 36, fontWeight: '800', textAlign: 'center' },
    body: { color: c.ink, fontSize: 18, lineHeight: 27, textAlign: 'center' },
    note: { color: c.inkSoft, fontSize: 15, lineHeight: 22, textAlign: 'center' },
    footer: { paddingHorizontal: Space.lg, paddingBottom: Space.md, paddingTop: Space.sm, gap: Space.md },
    dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
    dot: { height: 7, width: 7, borderRadius: 4, backgroundColor: c.edge },
    activeDot: { width: 23, backgroundColor: c.ember },
    button: { minHeight: 48, padding: Space.sm, borderRadius: Radius.coal, alignItems: 'center', justifyContent: 'center', backgroundColor: c.woolDeep },
    primary: { backgroundColor: c.ember },
    headerBack: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    headerBackText: { color: c.inkSoft, fontSize: 15, fontWeight: '600' },
    buttonText: { color: c.ink, fontSize: 17, fontWeight: '700', textAlign: 'center' },
    primaryText: { color: c.onFlame },
    replay: { color: c.inkSoft, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  }), [c]);
  // System Back/Escape is navigation, never a completion shortcut.
  const previousStep = () => { if (step > 0) onStep(step - 1); };
  return <Modal visible={visible} animationType="fade" presentationStyle="fullScreen" onRequestClose={previousStep} onShow={Keyboard.dismiss} onDismiss={onDismiss}>
    {/* A native modal has its own view root. Measure its safe area here so the
        header/footer avoid the status bar and home indicator on every slide. */}
    <SafeAreaProvider style={styles.safe}>
      <SafeAreaView style={styles.safe} edges={['top', 'right', 'bottom', 'left']}>
        <View style={styles.page} accessibilityViewIsModal onAccessibilityEscape={previousStep}>
          <View style={styles.header}>
            <BrandLogo size={28} /><Text style={styles.brand}>A little tour of sumore</Text>
            {step > 0
              ? <Pressable accessibilityRole="button" accessibilityLabel="Previous tour step" style={styles.headerBack} onPress={previousStep}><Text style={styles.headerBackText}>Back</Text></Pressable>
              : <View accessible={false} style={styles.headerBack} />}
          </View>
          {/* The pager fills the whole slide, including its empty space. Native
              horizontal paging follows the finger; each page still scrolls
              vertically for small screens or larger accessibility text. */}
          <View style={styles.pager} onStartShouldSetResponderCapture={() => {
            const blocked = inputFocused();
            setTouchBlocked(blocked);
            if (blocked) pager.current.navigation.cancel();
            return false;
          }}>
            <TabView navigationState={{ index: step, routes }}
              initialLayout={{ width: Math.min(width, 520) }}
              onSwipeStart={() => { if (!inputFocused()) pager.current.navigation.start(); }}
              onIndexChange={index => {
                const current = pager.current;
                if (index === current.step) return;
                if (inputFocused()) current.navigation.cancel();
                if (current.navigation.select(index)) current.onStep(index);
                else current.jumpTo?.(routes[current.step].key);
              }}
              renderTabBar={({ jumpTo }) => <TourPagerController jumpTo={jumpTo} onReady={setPagerController} />}
              renderScene={({ route }) => {
                const item = slides[route.index];
                const activity = item.activity;
                return <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
                  showsVerticalScrollIndicator={false} directionalLockEnabled>
                  <View style={{ gap: Space.md }}>
                    <TourIllustrationView kind={item.id} compact={height < 650 || width < 360} />
                    <Text style={styles.step} accessibilityLiveRegion={route.index === step ? 'polite' : 'none'}>{route.index + 1} of {slides.length}</Text>
                    <Text accessibilityRole="header" style={styles.title}>{item.title}</Text>
                    <Text style={styles.body}>{item.body}</Text>
                    <Text style={styles.note}>{item.note}</Text>
                  </View>
                  {activity && <Pressable accessibilityRole="button" onPress={() => onActivity(activity)} style={styles.button}>
                    <Text style={styles.buttonText}>{activity === 'friends' ? 'Add friends' : 'Customize camper'}</Text>
                  </Pressable>}
                </ScrollView>;
              }}
              lazy lazyPreloadDistance={1}
              swipeEnabled={swipeEnabled} animationEnabled={!reduceMotion}
              keyboardDismissMode="none" overScrollMode="never"
              commonOptions={{ sceneStyle: { backgroundColor: c.ground } }}
            />
          </View>
          <View style={styles.footer}>
            <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {slides.map((item, index) => <View key={item.id} style={[styles.dot, index === step && styles.activeDot]} />)}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={step === slides.length - 1 ? 'Finish tour' : 'Next tour step'} style={[styles.button, styles.primary]}
              onPress={step === slides.length - 1 ? onFinish : () => onStep(step + 1)}>
              <Text style={[styles.buttonText, styles.primaryText]}>{step === slides.length - 1 ? 'Let’s gather' : 'Next'}</Text>
            </Pressable>
            <Text style={styles.replay}>Replay anytime in Setup</Text>
          </View>
          <TourTabPreview kind={slide.id} compact={width < 360} />
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  </Modal>;
}

function TourPagerController({ jumpTo, onReady }: {
  jumpTo: (key: string) => void;
  onReady: (jumpTo: ((key: string) => void) | null) => void;
}) {
  useLayoutEffect(() => {
    onReady(jumpTo);
    return () => { onReady(null); };
  }, [jumpTo, onReady]);
  return null;
}
