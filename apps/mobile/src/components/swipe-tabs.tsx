import { BottomTabBar, BottomTabBarHeightContext, type BottomTabBarProps, type BottomTabNavigatorProps } from 'expo-router/js-tabs';
import { SafeAreaProviderCompat, Screen } from 'expo-router/react-navigation';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { AccessibilityInfo, Keyboard, Platform, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TabView } from 'react-native-tab-view';

import { useAppColors } from '@/constants/theme';
import { getSwipeTabRoutes } from '@/domain/swipe-tabs';
import { TabLightProvider, type TabPosition } from '@/components/tab-light';

type LayoutProps = Parameters<NonNullable<BottomTabNavigatorProps['layout']>>[0];

/** Keep Expo Router in charge of routes, links, focus, and the existing tab bar.
 * Only replace its scene presentation with a finger-following native pager.
 */
export function SwipeTabsLayout(props: LayoutProps) {
  // The generic layout type omits TabActionHelpers from descriptor.navigation;
  // these are still the real bottom-tab descriptors supplied by Tabs.
  const tabProps = props as unknown as Pick<BottomTabBarProps, 'state' | 'descriptors' | 'navigation'>;
  return <SafeAreaProviderCompat><SwipeTabs {...tabProps} /></SafeAreaProviderCompat>;
}

function SwipeTabs({ state, descriptors, navigation }: Pick<BottomTabBarProps, 'state' | 'descriptors' | 'navigation'>) {
  const c = useAppColors();
  const insets = useSafeAreaInsets();
  const routes = getSwipeTabRoutes(state.routes);
  const focusedRoute = state.routes[state.index];
  const visibleIndex = routes.findIndex(route => route.key === focusedRoute.key);
  const [lastVisibleIndex, setLastVisibleIndex] = useState(Math.max(0, visibleIndex));
  if (visibleIndex >= 0 && visibleIndex !== lastVisibleIndex) setLastVisibleIndex(visibleIndex);
  const pageIndex = visibleIndex >= 0 ? visibleIndex : lastVisibleIndex;
  const onMainTab = visibleIndex >= 0;
  const [visitedHidden, setVisitedHidden] = useState<string[]>([]);
  if (!onMainTab && !visitedHidden.includes(focusedRoute.key)) {
    setVisitedHidden(previous => [...previous, focusedRoute.key]);
  }
  const [keyboardVisible, setKeyboardVisible] = useState(Keyboard.isVisible());
  const [touchBlocked, setTouchBlocked] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(true);
  const [screenReader, setScreenReader] = useState(false);
  const [position, setPosition] = useState<TabPosition | null>(null);
  const swipeOrigin = useRef<typeof focusedRoute | null>(null);
  const jumpTo = useRef<((key: string) => void) | null>(null);
  const swipeEnabled = onMainTab && !keyboardVisible && !touchBlocked && !screenReader;
  const current = useRef({ focusedRoute, swipeEnabled, routes, pageIndex, navigation });
  useLayoutEffect(() => {
    // A tab tap, notification, or deep link supersedes an unfinished swipe.
    if (swipeOrigin.current && (swipeOrigin.current.key !== focusedRoute.key ||
        swipeOrigin.current.params !== focusedRoute.params || !swipeEnabled)) swipeOrigin.current = null;
    current.current = { focusedRoute, swipeEnabled, routes, pageIndex, navigation };
  });

  useEffect(() => {
    let alive = true;
    let motionChanged = false;
    let readerChanged = false;
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      motionChanged = true;
      setReduceMotion(value);
    });
    const reader = Platform.OS === 'web' ? null : AccessibilityInfo.addEventListener('screenReaderChanged', value => {
      readerChanged = true;
      setScreenReader(value);
    });
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (alive && !motionChanged) setReduceMotion(value);
    }).catch(() => undefined);
    // RN Web returns true unconditionally; browsers cannot detect screen readers.
    // Native VoiceOver/TalkBack keep their own swipe gestures, with tabs tappable.
    if (Platform.OS !== 'web') {
      AccessibilityInfo.isScreenReaderEnabled().then(value => {
        if (alive && !readerChanged) setScreenReader(value);
      }).catch(() => undefined);
    }
    return () => {
      alive = false;
      motion?.remove(); reader?.remove(); show.remove(); hide.remove();
    };
  }, []);

  const barStyle = StyleSheet.flatten(descriptors[focusedRoute.key].options.tabBarStyle);
  const barHeight = barStyle && 'height' in barStyle ? barStyle.height : undefined;
  const hiddenRoutes = state.routes.filter(route => visitedHidden.includes(route.key));

  return <View style={[styles.root, { backgroundColor: c.ground }]}>
    <BottomTabBarHeightContext.Provider value={typeof barHeight === 'number' ? barHeight : 88}>
      <View style={styles.scenes}>
        <View
          style={[styles.pager, !onMainTab && styles.hiddenPager]}
          pointerEvents={onMainTab ? 'auto' : 'none'}
          aria-hidden={!onMainTab}
          onStartShouldSetResponderCapture={event => {
            // A web Modal is a portal: its events can bubble through React even
            // though it is outside this pager. Never swipe behind that sheet.
            const outsidePager = Platform.OS === 'web' &&
              !(event.currentTarget as unknown as HTMLElement).contains(event.target as unknown as Node);
            const focusedInput = typeof TextInput.State.currentlyFocusedInput === 'function'
              ? TextInput.State.currentlyFocusedInput() : TextInput.State.currentlyFocusedField();
            setTouchBlocked(outsidePager || !!focusedInput);
            return false;
          }}>
          <TabView
            navigationState={{ index: pageIndex, routes }}
            onSwipeStart={() => {
              swipeOrigin.current = current.current.swipeEnabled ? current.current.focusedRoute : null;
            }}
            onIndexChange={index => {
              const latest = current.current;
              const route = latest.routes[index];
              if (!route || route.key === latest.focusedRoute.key) return;
              if (!latest.swipeEnabled || swipeOrigin.current?.key !== latest.focusedRoute.key) {
                // Native page callbacks also fire for programmatic movement.
                // Restore the current route if an old gesture finishes late.
                jumpTo.current?.(latest.routes[latest.pageIndex].key);
                return;
              }
              swipeOrigin.current = null;
              // A tab change must not erase Circle's section or deep-link params.
              latest.navigation.navigate({ name: route.name, params: route.params, merge: true });
            }}
            renderTabBar={pager => <PagerController jumpTo={pager.jumpTo} controllerRef={jumpTo}
              position={pager.position} width={pager.layout.width} onPosition={setPosition} />}
            renderScene={({ route }) => <Screen
              focused={onMainTab && route.key === focusedRoute.key}
              route={route}
              navigation={descriptors[route.key].navigation}
              headerShown={false}
              header={null}>
              {descriptors[route.key].render()}
            </Screen>}
            lazy
            lazyPreloadDistance={1}
            swipeEnabled={swipeEnabled}
            // This controls programmatic changes, not finger-driven swipes.
            // Tab taps/deep links jump directly; gestures still drag and settle
            // smoothly, with the tab light following the pager position.
            animationEnabled={false}
            keyboardDismissMode="none"
            overScrollMode="never"
            commonOptions={{ sceneStyle: { backgroundColor: c.ground } }}
          />
        </View>
        {hiddenRoutes.map(route => <View key={route.key}
          style={[styles.pager, route.key !== focusedRoute.key && styles.hidden]}
          pointerEvents={route.key === focusedRoute.key ? 'auto' : 'none'}
          aria-hidden={route.key !== focusedRoute.key}>
          <Screen focused={route.key === focusedRoute.key} route={route}
            navigation={descriptors[route.key].navigation} headerShown={false} header={null}>
            {descriptors[route.key].render()}
          </Screen>
        </View>)}
      </View>
    </BottomTabBarHeightContext.Provider>
    <TabLightProvider position={onMainTab ? position : null} enabled={onMainTab && !keyboardVisible} reduceMotion={reduceMotion}>
      <BottomTabBar state={state} descriptors={descriptors} navigation={navigation} insets={insets} />
    </TabLightProvider>
  </View>;
}

function PagerController({ jumpTo, controllerRef, position, width, onPosition }: {
  jumpTo: (key: string) => void; controllerRef: RefObject<((key: string) => void) | null>;
  position: TabPosition; width: number; onPosition: (position: TabPosition) => void;
}) {
  useLayoutEffect(() => {
    controllerRef.current = jumpTo;
    return () => { controllerRef.current = null; };
  }, [controllerRef, jumpTo]);
  useLayoutEffect(() => {
    // Before measurement the web pager creates a fresh placeholder node on
    // every render. Publish only its stable, measured node, never frame values.
    if (width > 0) onPosition(position);
  }, [onPosition, position, width]);
  return null;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scenes: { flex: 1, overflow: 'hidden' },
  pager: { ...StyleSheet.absoluteFill },
  // Keep its measured width: display:none would make TabView unmount offscreen
  // scenes on web. Visibility also excludes hidden controls from keyboard focus.
  hiddenPager: { opacity: 0, ...Platform.select({ web: { visibility: 'hidden' }, default: {} }) },
  // Retain mounted screens and their scroll/form state when opening the store.
  hidden: { display: 'none' },
});
