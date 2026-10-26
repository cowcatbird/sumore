import { useRef, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';

import { PUBLIC_INFO_URLS } from '@/constants/public-info';
import { Space, Type, useAppColors } from '@/constants/theme';

/** Quiet links work both before sign-in and in Setup. */
export function PublicInfoLinks({ compact = false }: { compact?: boolean }) {
  const c = useAppColors();
  const opening = useRef(false);
  const [openingUrl, setOpeningUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const open = async (url: string) => {
    if (opening.current) return;
    opening.current = true;
    setOpeningUrl(url);
    setFailedUrl(null);
    try { await Linking.openURL(url); }
    catch { setFailedUrl(url); }
    finally { opening.current = false; setOpeningUrl(null); }
  };
  const entry = (title: string, url: string) => <Pressable accessibilityRole="link"
    accessibilityLabel={title} accessibilityHint="Opens the sumore website in your browser."
    accessibilityState={{ disabled: openingUrl !== null, busy: openingUrl === url }} disabled={openingUrl !== null}
    onPress={() => { void open(url); }}
    style={({ pressed }) => ({ minHeight: 44, paddingVertical: Space.xs, justifyContent: 'center',
      opacity: openingUrl !== null ? 0.6 : pressed ? 0.8 : 1 })}>
    <Text style={{ ...Type.bodySmall, color: c.ember, fontWeight: '600', textDecorationLine: 'underline' }}>{title}</Text>
    <Text style={{ ...Type.bodySmall, color: c.inkSoft }}>{openingUrl === url ? 'Opening…' : 'Opens in your browser'}</Text>
  </Pressable>;
  return <View style={{ gap: Space.xs, alignSelf: 'stretch' }}>
    {entry('Privacy policy', PUBLIC_INFO_URLS.privacy)}
    {!compact && entry('Account deletion help', PUBLIC_INFO_URLS.accountDeletion)}
    {failedUrl && <Text selectable accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ ...Type.bodySmall, color: c.inkSoft }}>
      Could not open your browser. Try again, or copy this address into your browser: {failedUrl}
    </Text>}
  </View>;
}
