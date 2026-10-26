import { DarkTheme, DefaultTheme, router, Tabs, ThemeProvider, useRootNavigationState } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Text, View, useWindowDimensions } from 'react-native';

import { AuthGate } from '@/components/auth-gate';
import { AppTourProvider } from '@/components/app-tour';
import { RecoveryNotice } from '@/components/recovery-notice';
import { SwipeTabsLayout } from '@/components/swipe-tabs';
import { TabLightIcon, TabLightLabel } from '@/components/tab-light';
import { AppThemeProvider, useAppColors, useIsNight } from '@/constants/theme';
import { AppProvider, useApp } from '@/features/app-store';
import { CharacterProvider } from '@/features/character-store';
import { ModerationProvider } from '@/features/moderation-store';
import { isLocalArtPreview, LocalArtPreviewProvider, useLocalArtPreview } from '@/features/local-art-preview';
import { observeNotificationNavigation } from '@/services/notifications';

SplashScreen.preventAutoHideAsync();

export default function TabLayout() {
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  // The appearance provider wraps everything, including the navigation theme,
  // so one subscription drives the whole tree.
  return (
    <AppThemeProvider nightCamp>
      <ThemedShell />
    </AppThemeProvider>
  );
}

function ThemedShell() {
  const c = useAppColors();
  const night = useIsNight();
  const base = night ? DarkTheme : DefaultTheme;
  const DataProvider = isLocalArtPreview ? LocalArtPreviewProvider : AppProvider;

  return (
    <ThemeProvider value={{ ...base, colors: { ...base.colors, background: c.ground } }}>
      <StatusBar style={night ? 'light' : 'dark'} />
      <View style={{ flex: 1, backgroundColor: '#050E15' }}>
        <View style={{ flex: 1, width: '100%', maxWidth: 560, alignSelf: 'center' }}>
          <DataProvider>
            <CharacterProvider>
              <AuthGate><ModerationProvider><AppTourProvider><RecoveryNotice /><AppTabs /></AppTourProvider></ModerationProvider></AuthGate>
            </CharacterProvider>
          </DataProvider>
        </View>
      </View>
    </ThemeProvider>
  );
}

// All tabs share these rows, including when just Screen Time needs two lines.
// Match Text's bounded native scaling without shrinking enlarged text to fit.
function tabLabelLayout(width: number, fontScale: number) {
  const maxFontSizeMultiplier = 1.4;
  const effectiveScale = Math.min(maxFontSizeMultiplier, Math.max(1, fontScale));
  const compact = width / effectiveScale < 360;
  const baseLabelHeight = compact ? 26 : 16;
  const extraHeight = Math.ceil(12 * (effectiveScale - 1)) * (compact ? 2 : 1);
  return {
    compact,
    fontSize: width < 360 ? 10 : 11,
    labelHeight: baseLabelHeight + extraHeight,
    barHeight: (compact ? 96 : 88) + extraHeight,
    maxFontSizeMultiplier,
  };
}

function AppTabs() {
  const { incomingRequests } = useApp();
  const c = useAppColors();
  const preview = useLocalArtPreview();
  const { width, fontScale } = useWindowDimensions();
  const { compact: compactTabs, fontSize, labelHeight, barHeight, maxFontSizeMultiplier } = tabLabelLayout(width, fontScale);
  const navigationState = useRootNavigationState();

  useEffect(() => {
    // Consume the one-shot reset through Router after hydration. Editing browser
    // history earlier is undone by Router's cached initial URL on first mount.
    if (preview?.resetCompleted && navigationState?.key) router.setParams({ resetLocalDemo: undefined });
  }, [preview?.resetCompleted, navigationState?.key]);

  useEffect(() => {
    if (isLocalArtPreview) return;
    let active = true;
    let cleanup: (() => void) | undefined;

    observeNotificationNavigation()
      .then((nextCleanup) => {
        if (active) cleanup = nextCleanup;
        else nextCleanup();
      })
      .catch(() => undefined);

    return () => {
      active = false;
      cleanup?.();
    };
  }, []);

  return (
    <Tabs
      layout={SwipeTabsLayout}
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarActiveTintColor: c.ember,
        tabBarInactiveTintColor: c.inkSoft,
        tabBarLabelPosition: 'below-icon',
        tabBarItemStyle: { flex: 1, flexBasis: 0, minWidth: 0 },
        tabBarIconStyle: { width: 26, height: 26, flexShrink: 0 },
        tabBarLabel: ({ children, focused }) => (
          <View style={{ width: '100%', height: labelHeight, flexShrink: 0, paddingTop: 2, alignItems: 'center' }}>
            <TabLightLabel routeName={route.name} focused={focused}>{color => <Text allowFontScaling maxFontSizeMultiplier={maxFontSizeMultiplier} numberOfLines={2} style={{ color, fontSize, lineHeight: 12, fontWeight: '700', letterSpacing: -0.1, textAlign: 'center' }}>
              {compactTabs && children === 'Screen Time' ? 'Screen\nTime' : children}
            </Text>}</TabLightLabel>
          </View>
        ),
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700', letterSpacing: -0.1 },
        tabBarStyle: {
          backgroundColor: c.wool,
          borderTopColor: c.seam,
          // Reserve enough room for both label lines plus the navigator's item padding.
          height: barHeight,
          paddingTop: 8,
          paddingBottom: 24,
        },
      })}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Camp',
          tabBarAccessibilityLabel: 'Camp, tab 1 of 4',
          tabBarIcon: ({ focused }) => (
            <TabLightIcon routeName="index" focused={focused}
              name={{ ios: 'flame', android: 'local_fire_department', web: 'local_fire_department' }}
              activeName={{ ios: 'flame.fill', android: 'local_fire_department', web: 'local_fire_department' }}
              size={22}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="screen-time"
        options={{
          title: 'Screen Time',
          tabBarAccessibilityLabel: 'Screen Time, tab 2 of 4',
          tabBarIcon: ({ focused }) => (
            <TabLightIcon routeName="screen-time" focused={focused}
              name={{ ios: 'hourglass', android: 'hourglass_empty', web: 'hourglass_empty' }}
              // The hourglass fills more of its glyph box than the rounded icons.
              // Match its visual size and baseline without moving the tab's layout slot.
              size={20}
              style={{ transform: [{ translateY: 2 }] }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="friends"
        options={{
          title: 'Circle',
          tabBarAccessibilityLabel: `Circle, tab 3 of 4${incomingRequests.length ? `, ${incomingRequests.length} waiting` : ''}`,
          tabBarBadge: incomingRequests.length || undefined,
          tabBarBadgeStyle: { backgroundColor: c.ember, color: c.onFlame, fontWeight: '800' },
          tabBarIcon: ({ focused }) => (
            <TabLightIcon routeName="friends" focused={focused}
              name={{ ios: 'person.2', android: 'group', web: 'group' }}
              activeName={{ ios: 'person.2.fill', android: 'group', web: 'group' }}
              size={22}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Setup',
          tabBarAccessibilityLabel: 'Setup, tab 4 of 4',
          tabBarIcon: ({ focused }) => (
            <TabLightIcon routeName="settings" focused={focused}
              name={{ ios: 'gearshape', android: 'settings', web: 'settings' }}
              activeName={{ ios: 'gearshape.fill', android: 'settings', web: 'settings' }}
              size={22}
            />
          ),
        }}
      />
      <Tabs.Screen name="requests" options={{ href: null }} />
      <Tabs.Screen name="customize" options={{ href: null }} />
      <Tabs.Screen name="moderation" options={{ href: null }} />
    </Tabs>
  );
}
