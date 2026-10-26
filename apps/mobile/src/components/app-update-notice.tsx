import * as Updates from 'expo-updates';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Radius, Space, Type, useAppColors } from '@/constants/theme';
import { APP_REVISION, downloadAppUpdate } from '@/services/app-updates';

export function AppUpdateNotice() {
  const c = useAppColors();
  if (__DEV__ || Platform.OS === 'web' || !Updates.isEnabled) {
    return <Text style={[styles.version, { color: c.inkSoft }]}>sumore · {APP_REVISION}</Text>;
  }
  return <InstalledUpdateNotice />;
}

function InstalledUpdateNotice() {
  const c = useAppColors();
  const { isUpdatePending } = Updates.useUpdates();
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const ready = downloaded || isUpdatePending;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const check = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage('Checking for an app update…');
    try {
      const result = await downloadAppUpdate(Updates);
      if (!mounted.current) return;
      setDownloaded(result === 'ready');
      setMessage(result === 'ready' ? 'Update downloaded. Restart when you are ready.' : 'You have the latest compatible app update.');
    } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : 'Could not check for an update. Please try again.');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const restart = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await Updates.reloadAsync();
    } catch {
      pending.current = false;
      if (mounted.current) {
        setBusy(false);
        setMessage('Could not restart automatically. Fully close sumore and open it again.');
      }
    }
  };

  return (
    <View style={[styles.card, { borderColor: c.seam }]}>
      <Text selectable style={[styles.version, { color: c.inkSoft }]}>
        sumore · {APP_REVISION}{'\n'}
        {Updates.isEmbeddedLaunch ? 'Included with install' : `Update ${Updates.updateId?.slice(0, 8) ?? 'downloaded'}`}
      </Text>
      {message && <Text accessibilityRole="alert" style={[styles.message, { color: c.inkSoft }]}>{message}</Text>}
      {ready && <Text style={[styles.message, { color: c.inkSoft }]}>An update is ready. Save any edits first; restarting clears unsaved typing.</Text>}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy, disabled: busy }}
        disabled={busy}
        onPress={() => { void (ready ? restart() : check()); }}
        style={[styles.button, { backgroundColor: c.woolDeep, opacity: busy ? 0.6 : 1 }]}>
        {busy && <ActivityIndicator color={c.ember} />}
        <Text style={[styles.buttonText, { color: c.ember }]}>{busy ? 'Please wait…' : ready ? 'Restart to apply update' : 'Check for app update'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: Space.sm, padding: Space.md, borderWidth: 1, borderRadius: Radius.tin },
  version: { ...Type.bodySmall, textAlign: 'center', paddingVertical: Space.sm },
  message: { ...Type.bodySmall, textAlign: 'center' },
  button: { minHeight: 44, padding: Space.sm, borderRadius: Radius.tin, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: Space.sm },
  buttonText: { ...Type.control, fontSize: 13 },
});
