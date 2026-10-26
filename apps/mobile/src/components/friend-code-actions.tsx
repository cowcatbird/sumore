import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Share, Text, View } from 'react-native';

import { formControlStyle } from '@/constants/form-layout';
import { useAppColors } from '@/constants/theme';

/** Only mounted beside the owner's revealed code, never beside peer profiles. */
export function FriendCodeActions(props: { code: string; disabled?: boolean; demo?: boolean }) {
  // A new code cannot inherit an old clipboard operation, confirmation or pending state.
  return <CodeActions key={props.code} {...props} />;
}

function CodeActions({ code, disabled = false, demo = false }: { code: string; disabled?: boolean; demo?: boolean }) {
  const c = useAppColors();
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const operation = useRef(0);
  const pending = useRef(false);
  useEffect(() => () => { operation.current += 1; pending.current = false; }, []);
  const act = async (kind: 'copy' | 'share') => {
    if (!code || disabled || pending.current || (demo && kind === 'share')) return;
    const current = ++operation.current;
    pending.current = true; setWorking(true); setNotice(null);
    try {
      if (kind === 'copy') {
        if (await Clipboard.setStringAsync(code) === false) throw new Error('Copy unavailable');
        if (operation.current === current) setNotice({ text: demo ? 'Copied. This code cannot connect real accounts.' : 'Copied.', error: false });
      } else {
        await Share.share({ title: 'Join my circle on sumore', message: `Join my circle on sumore with my friend code: ${code}` });
      }
    } catch {
      if (operation.current === current) setNotice({ text: kind === 'copy'
        ? 'Could not copy. Try again.' : 'Could not share. Try copying the code.', error: true });
    } finally {
      if (operation.current === current) { pending.current = false; setWorking(false); }
    }
  };
  const button = (kind: 'copy' | 'share', label: string) => {
    const unavailable = disabled || working || !code || (demo && kind === 'share');
    return <Pressable accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled: unavailable, busy: working }} disabled={unavailable}
      onPress={() => { void act(kind); }}
      style={{ ...formControlStyle, flex: 1, borderWidth: 1,
        borderColor: c.seam, backgroundColor: c.woolDeep, alignItems: 'center', justifyContent: 'center', opacity: unavailable ? 0.5 : 1 }}>
      <Text style={{ color: c.ember, fontSize: 14, fontWeight: '700' }}>{label}</Text>
    </Pressable>;
  };
  return <View style={{ alignSelf: 'stretch', gap: 8 }}>
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {button('copy', 'Copy code')}
      {button('share', 'Share code')}
    </View>
    {demo && <Text style={{ color: c.inkSoft, fontSize: 12, textAlign: 'center' }}>Sharing is unavailable in this browser.</Text>}
    {notice && <Text accessibilityRole={notice.error ? 'alert' : undefined} accessibilityLiveRegion="polite"
      style={{ color: notice.error ? c.scarlet : c.emerald, fontSize: 13, textAlign: 'center' }}>{notice.text}</Text>}
  </View>;
}
