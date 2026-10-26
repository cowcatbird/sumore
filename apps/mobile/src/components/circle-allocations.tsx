import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ActionButton, FormSheet } from '@/components/form-sheet';
import { KeyboardTextInput } from '@/components/keyboard-form';
import { SectionHeading } from '@/components/section-heading';
import { Radius, Space, Type, useAppColors } from '@/constants/theme';
import { useApp } from '@/features/app-store';
import { isLocalArtPreview } from '@/features/local-art-preview';
import { getScreenTimeStatus } from '@/native/screen-time';
import { getCircleAppLimits, setSharedAppLimits, type SharedAppLimits } from '@/services/account-access';
import { publishDailyAllocation } from '@/services/shared-allocation';

export function CircleAllocations() {
  const { profile, friends } = useApp();
  const people = useMemo(() => [profile, ...friends], [profile, friends]);
  return <Allocations key={profile.id} people={people} />;
}

function Allocations({ people }: { people: { id: string; displayName: string }[] }) {
  const c = useAppColors();
  const [rows, setRows] = useState<SharedAppLimits[]>([]);
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState<{ label: string; minutes: string }[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useFocusEffect(useCallback(() => {
    let current = true, reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        if (!isLocalArtPreview) {
          const status = await getScreenTimeStatus();
          if (!current) return;
          await publishDailyAllocation(status, people[0].id);
        }
        const next = isLocalArtPreview ? people.map((person, i) => ({ userId: person.id, totalDailyMinutes: i ? 30 : 45,
          apps: i ? null : [{ label: 'Social feed', minutes: 30 }, { label: 'Videos', minutes: 15 }], updatedAt: new Date().toISOString() })) : await getCircleAppLimits();
        if (current) setRows(previous => isLocalArtPreview ? next.map(row => previous.find(saved => saved.userId === row.userId) ?? row) : next);
      } catch { if (current) setNotice('Circle allocations need the latest server update or a connection.'); }
      finally { reading = false; }
    };
    void refresh();
    if (isLocalArtPreview) return () => { current = false; };
    const timer = setInterval(() => { void refresh(); }, 15_000);
    return () => { current = false; clearInterval(timer); };
  }, [people]));
  const own = rows.find(row => row.userId === people[0].id);
  const save = async () => {
    if (lock.current || total === null) return;
    lock.current = true; setBusy(true); setNotice('');
    try {
      const apps = labels.map(row => ({ label: row.label, minutes: Number(row.minutes) }));
      if (apps.some(row => !row.label.trim() || row.label.length > 32 || !Number.isInteger(row.minutes) || row.minutes < 1 || row.minutes > 1440) || apps.reduce((sum, row) => sum + row.minutes, 0) > total) throw new Error('Use whole minutes. App labels cannot total more than your daily allowance.');
      const saved = isLocalArtPreview ? { userId: people[0].id, apps: apps.length ? apps : null, totalDailyMinutes: total, updatedAt: new Date().toISOString() }
        : await setSharedAppLimits(apps.length ? apps : null, total, people[0].id);
      setRows(previous => [...previous.filter(row => row.userId !== people[0].id), ...(saved ? [saved] : [])]);
      setNotice(isLocalArtPreview ? 'Saved in this browser. Nothing was shared online.' : 'Saved for your circle.');
      setOpen(false);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save.'); }
    finally { lock.current = false; setBusy(false); }
  };
  return <View style={{ gap: 12 }}>
    <SectionHeading title="Daily allocations" />
    <View>
    {people.map((person, index) => {
      const row = rows.find(item => item.userId === person.id);
      const isYou = person.id === people[0].id;
      return <View key={person.id} style={{ paddingVertical: Space.sm, borderTopWidth: index ? 1 : 0, borderColor: c.seam, gap: 4 }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: Space.sm, rowGap: 4 }}>
          <Text style={{ ...Type.control, color: c.ink, flexGrow: 1, flexShrink: 1, flexBasis: '45%' }}>{isYou ? 'You' : person.displayName}</Text>
          <Text style={{ ...Type.bodySmall, color: isYou && row ? c.ember : c.inkSoft, fontWeight: '600', fontVariant: ['tabular-nums'], flexShrink: 1 }}>{row ? `${row.totalDailyMinutes} min/day` : 'Not shared yet'}</Text>
        </View>
        {!!row?.apps?.length && <Text style={{ ...Type.bodySmall, color: c.inkSoft }}>{row.apps.map(app => `${app.label} · ${app.minutes} min`).join('  /  ')}</Text>}
        {!!row?.apps?.length && <Text style={{ ...Type.bodySmall, color: c.inkSoft }}>Labels shared by this camper</Text>}
      </View>;
    })}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="Share optional app labels"
      style={({ pressed }) => ({ minHeight: 44, justifyContent: 'center', paddingVertical: Space.xs, opacity: pressed ? 0.65 : 1 })}
      onPress={() => {
      setLabels(own?.apps?.map(app => ({ label: app.label, minutes: String(app.minutes) })) ?? []);
      setTotal(null); setNotice(''); setOpen(true);
      if (isLocalArtPreview) { setTotal(45); return; }
      void getScreenTimeStatus().then(status => {
        if (!status.available || status.requiresReset || status.mode !== 'daily') setNotice('Set up your daily app limit first.');
        else setTotal(status.blockingEnabled ? status.dailyLimitMinutes ?? 0 : 0);
      });
    }}>
      <Text style={{ ...Type.bodySmall, color: c.ember, fontWeight: '600' }}>Share optional app labels</Text>
    </Pressable>
    {!open && !!notice && <Text style={{ color: c.inkSoft }}>{notice}</Text>}
    <FormSheet title="Share app labels" visible={open} busy={busy} onClose={() => setOpen(false)}>
      <Text style={{ color: c.inkSoft }}>Optional names you type, not your phone’s private app list. Your circle can see these labels and times.</Text>
      <Text style={{ color: c.ink, fontWeight: '700' }}>Your daily allocation: {total === null ? 'Checking…' : `${total} min`}</Text>
      {labels.map((row, index) => <View key={index} style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: c.seam, borderRadius: Radius.fold }}>
        <KeyboardTextInput accessibilityLabel={`App label ${index + 1}`} value={row.label} maxLength={32} placeholder="App name" placeholderTextColor={c.inkSoft}
          onChangeText={label => setLabels(previous => previous.map((item, i) => i === index ? { ...item, label } : item))}
          style={{ minHeight: 48, padding: 12, color: c.ink, backgroundColor: c.wool }} />
        <KeyboardTextInput accessibilityLabel={`Minutes for app label ${index + 1}`} value={row.minutes} maxLength={4} keyboardType="number-pad" placeholder="Minutes" placeholderTextColor={c.inkSoft}
          onChangeText={minutes => setLabels(previous => previous.map((item, i) => i === index ? { ...item, minutes } : item))}
          style={{ minHeight: 48, padding: 12, color: c.ink, backgroundColor: c.wool }} />
        <ActionButton label={`Remove label ${index + 1}`} onPress={() => setLabels(previous => previous.filter((_, i) => i !== index))} />
      </View>)}
      <ActionButton label="Add app label" disabled={busy || labels.length >= 50} onPress={() => setLabels(previous => [...previous, { label: '', minutes: '' }])} />
      <ActionButton label="Hide all app labels" disabled={busy} onPress={() => setLabels([])} />
      <ActionButton label="Save for circle" primary disabled={busy || total === null} onPress={() => { void save(); }} />
      {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: c.inkSoft }}>{notice}</Text>}
    </FormSheet>
  </View>;
}
