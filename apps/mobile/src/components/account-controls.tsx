import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { AppState, Text, View } from 'react-native';

import { ActionButton, FormSheet } from '@/components/form-sheet';
import { KeyboardTextInput } from '@/components/keyboard-form';
import { SectionHeading } from '@/components/section-heading';
import { SettingsActionRow } from '@/components/settings-action-row';
import { Radius, useAppColors } from '@/constants/theme';
import { formControlStyle, formSectionStyle } from '@/constants/form-layout';
import { useApp } from '@/features/app-store';
import { isLocalArtPreview } from '@/features/local-art-preview';
import { createLoginKey, deleteAccount, getLoginKey, normalizeLoginKey, restoreAccount } from '@/services/account-access';

export function AccountControls() {
  const { profile } = useApp();
  // Changing accounts unmounts all secret-bearing state immediately.
  return <AccountPanel key={profile.id} />;
}

function AccountPanel() {
  const c = useAppColors();
  const [panel, setPanel] = useState<'key' | 'delete' | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [confirmed, setConfirmed] = useState('');
  const alive = useRef(true);
  const submitting = useRef(false);
  const keyGeneration = useRef(0);
  useEffect(() => {
    alive.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') { keyGeneration.current += 1; setKey(null); setPanel(null); }
    });
    return () => { alive.current = false; subscription.remove(); };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setNotice('');
    try { await action(); }
    catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : 'Please try again.'); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  };
  const close = () => { keyGeneration.current += 1; setPanel(null); setKey(null); setNotice(''); setConfirmed(''); };
  return <View style={formSectionStyle}>
    <SectionHeading title="Account" />
    <SettingsActionRow label="Login key · tap to view" icon={{ ios: 'key', android: 'key', web: 'key' }} disabled={busy} onPress={() => {
      setPanel('key');
      const expectedGeneration = ++keyGeneration.current;
      void run(async () => {
        if (isLocalArtPreview) { setNotice('Login keys are unavailable in this browser. Open the installed app to access your account.'); return; }
        const result = await getLoginKey();
        if (!alive.current || keyGeneration.current !== expectedGeneration) return;
        setHasKey(result.hasKey);
        const value = result.key ?? (!result.hasKey ? await createLoginKey() : null);
        if (alive.current && keyGeneration.current === expectedGeneration) setKey(value);
      });
    }} />
    <RestoreAccountButton appearance="row" />
    <SettingsActionRow label="Delete account" icon={{ ios: 'trash', android: 'delete_outline', web: 'delete_outline' }} danger disabled={busy} onPress={() => { close(); setPanel('delete'); }} />
    <FormSheet title={panel === 'delete' ? 'Delete account?' : panel === 'key' ? 'Your private login key' : 'Account'} visible={panel !== null} onClose={close} busy={busy}>
      {panel === 'key' ? <>
        <Text style={{ color: c.inkSoft }}>Keep this private. Anyone with this key can sign in as you. It is not your friend code.</Text>
        {key && <>
          <Text selectable style={{ color: c.ink, fontSize: 19, lineHeight: 30, padding: 16, backgroundColor: c.wool, borderRadius: Radius.fold }}>{key}</Text>
          <ActionButton label="Copy login key" primary onPress={() => { void run(async () => { await Clipboard.setStringAsync(key); if (alive.current) setNotice('Copied. Save it somewhere private.'); }); }} />
        </>}
        {!key && hasKey && !busy && <>
          <Text style={{ color: c.inkSoft }}>Your key is saved on another device. Creating a new key makes the old one stop working.</Text>
          <ActionButton label="Replace old login key" onPress={() => { const expectedGeneration = keyGeneration.current; void run(async () => { const value = await createLoginKey(); if (alive.current && keyGeneration.current === expectedGeneration) setKey(value); }); }} />
        </>}
      </> : panel === 'delete' && <>
        <Text style={{ color: c.inkSoft }}>Permanently delete your account, personal progress and login key. Your circle’s shared purchases stay with its other members. This cannot be undone.</Text>
        <Text style={{ color: c.ink }}>Type DELETE to confirm.</Text>
        <KeyboardTextInput accessibilityLabel="Type DELETE to confirm account deletion" value={confirmed} onChangeText={setConfirmed}
          autoCapitalize="characters" autoCorrect={false} maxLength={6}
          style={{ ...formControlStyle, color: c.ink, backgroundColor: c.wool, borderColor: c.seam, borderWidth: 1 }} />
        <ActionButton label="Permanently delete account" danger disabled={busy || confirmed !== 'DELETE'} onPress={() => { void run(async () => {
          if (isLocalArtPreview) { setNotice('Account deletion is unavailable in this browser. Nothing was deleted. Open the installed app to manage your account.'); return; }
          await deleteAccount();
        }); }} />
      </>}
      {busy && <Text style={{ color: c.inkSoft }}>Please wait…</Text>}
      {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: c.inkSoft }}>{notice}</Text>}
    </FormSheet>
  </View>;
}

/** Also available before creating a new profile, for reinstallation recovery. */
export function RestoreAccountButton({ appearance = 'button' }: { appearance?: 'button' | 'row' } = {}) {
  const c = useAppColors();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active' && !submitting.current) { setDraft(''); setOpen(false); }
    });
    return () => { alive.current = false; subscription.remove(); };
  }, []);
  const restore = async () => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setNotice('');
    try {
      if (isLocalArtPreview) { setNotice('Account recovery is unavailable in this browser. Open the installed app to restore your account.'); return; }
      const result = await restoreAccount(draft);
      if (alive.current) {
        setDraft('');
        setNotice(result.previousKeyRevoked && result.keySaved ? 'Account restored.' : 'Account restored. Keep your entered key saved. The previous account key may still be valid.');
      }
    } catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : 'Could not restore this account.'); }
    finally { submitting.current = false; if (alive.current) setBusy(false); }
  };
  const openRestore = () => { setNotice(''); setOpen(true); };
  return <>
    {appearance === 'row'
      ? <SettingsActionRow label="Already have an account?" icon={{ ios: 'arrow.counterclockwise', android: 'restore', web: 'restore' }} onPress={openRestore} />
      : <ActionButton label="Already have an account?" onPress={openRestore} />}
    <FormSheet title="Restore your account" visible={open} busy={busy} onClose={() => { setOpen(false); setDraft(''); setNotice(''); }}>
      <Text style={{ color: c.inkSoft }}>Enter your private login key. This switches accounts; progress is not merged. After success, your current account’s old key is retired.</Text>
      <KeyboardTextInput accessibilityLabel="Private login key" placeholder="SUMORE-…" placeholderTextColor={c.inkSoft}
        secureTextEntry autoCorrect={false} autoCapitalize="characters" textContentType="password" maxLength={160}
        value={draft} onChangeText={setDraft} editable={!busy} style={{ ...formControlStyle, color: c.ink, backgroundColor: c.wool, borderColor: c.seam, borderWidth: 1 }} />
      <ActionButton label={busy ? 'Restoring…' : 'Restore account'} primary disabled={busy || (!isLocalArtPreview && !normalizeLoginKey(draft)) || !draft.trim()} onPress={() => { void restore(); }} />
      {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: c.inkSoft }}>{notice}</Text>}
    </FormSheet>
  </>;
}
