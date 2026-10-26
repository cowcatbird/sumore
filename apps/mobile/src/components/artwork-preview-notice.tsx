import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandLogo } from '@/components/character-sprite';

const descriptions = {
  Asks: 'Open the installed app to send requests to friends.',
  Circle: 'Open the installed app to connect with your friends.',
  Setup: 'Account settings and phone permissions are managed in the installed app.',
};

/** Kept separate from live screens so none of their effects or native APIs run. */
export function ArtworkPreviewNotice({ section }: { section: keyof typeof descriptions }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={styles.page} contentContainerStyle={[styles.content, { paddingTop: insets.top + 42 }]}>
      <View style={styles.header}>
        <View style={styles.brand}><BrandLogo size={34} /><Text style={styles.wordmark}>sumore</Text></View>
      </View>
      <View style={styles.card}>
        <View style={styles.logoWell}><BrandLogo size={72} /></View>
        <Text style={styles.section}>{section.toUpperCase()}</Text>
        <Text accessibilityRole="header" style={styles.title}>Continue on your phone.</Text>
        <Text style={styles.description}>{descriptions[section]}</Text>
        <View style={styles.safetyNote}>
          <View style={styles.safetyDot} />
          <Text style={styles.safetyText}>Account changes and phone permissions are unavailable in this browser.</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={() => router.push('/customize')}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
          <Text style={styles.primaryText}>Customize your camper</Text><Text style={styles.arrow}>↗</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => router.push('/')}
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
          <Text style={styles.secondaryText}>Back to camp</Text>
        </Pressable>
      </View>
      <Text style={styles.footer}>Same camp. A new coat of moonlight.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#0A151D' },
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: 22, paddingBottom: 40, gap: 30 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 },
  brand: { flexDirection: 'row', gap: 7, alignItems: 'center' },
  wordmark: { color: '#FFF3DE', fontSize: 23, fontWeight: '800', letterSpacing: -1 },
  eyebrow: { color: '#B4C9B5', fontSize: 8, fontWeight: '700', letterSpacing: 1.5 },
  card: { backgroundColor: '#12232A', borderWidth: 1, borderColor: '#293E43', borderRadius: 27, padding: 24, alignItems: 'center', gap: 17 },
  logoWell: { width: 105, height: 105, borderRadius: 53, backgroundColor: '#2A2B24', alignItems: 'center', justifyContent: 'center', marginTop: 10, marginBottom: 7 },
  section: { color: '#FFAD66', fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  title: { color: '#FFF3DE', fontSize: 33, lineHeight: 38, textAlign: 'center', fontWeight: '800', letterSpacing: -0.9 },
  description: { color: '#B2C2BD', fontSize: 14, lineHeight: 22, textAlign: 'center', maxWidth: 350 },
  safetyNote: { flexDirection: 'row', gap: 10, alignItems: 'center', borderRadius: 13, backgroundColor: '#0C1B22', padding: 15, marginVertical: 5 },
  safetyDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#A9CEB7' },
  safetyText: { flex: 1, color: '#A9C8B5', fontSize: 11, lineHeight: 17 },
  primary: { alignSelf: 'stretch', flexDirection: 'row', gap: 9, minHeight: 54, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFAD66' },
  primaryText: { color: '#251B14', fontSize: 13, fontWeight: '800' },
  arrow: { color: '#251B14', fontSize: 18 },
  secondary: { alignSelf: 'stretch', minHeight: 46, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: '#D7DDCF', fontSize: 13, fontWeight: '600' },
  footer: { color: '#9DAFA9', fontSize: 11, lineHeight: 17, textAlign: 'center' },
  pressed: { opacity: 0.84, transform: [{ scale: 0.987 }] },
});
