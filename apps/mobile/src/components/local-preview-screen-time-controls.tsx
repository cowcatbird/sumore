import { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActionButton, FormSheet } from '@/components/form-sheet';
import { KeyboardTextInput } from '@/components/keyboard-form';
import { SectionHeading } from '@/components/section-heading';
import { ScreenTimeSetupChecklist } from '@/components/screen-time-setup-checklist';
import { Radius, Space, useAppColors } from '@/constants/theme';
import { FormLayout, formControlStyle, formSectionStyle } from '@/constants/form-layout';
import { DAILY_LIMIT_OPTIONS, PER_APP_LIMIT_EXPLANATION, dailyLimitAmountLabel, demoScreenTimeSetupReadiness } from '@/domain/daily-limit-controls';
import { DEMO_APPS, demoAskBlockReason, demoLimitBaseTotal, demoLimitRemaining, demoLimitTotal, parseDemoMinutes, type DemoApp } from '@/domain/demo-screen-time';
import { useLocalArtPreview } from '@/features/local-art-preview';

const DEMO_ICONS: Record<DemoApp, string> = { 'Social feed': '▤', 'Short videos': '▶', Games: '◆' };

function DemoButton({ label, onPress, primary = false, disabled = false }: {
  label: string; onPress: () => void; primary?: boolean; disabled?: boolean;
}) {
  const c = useAppColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, { borderColor: primary ? c.ember : c.seam,
      backgroundColor: primary ? c.ember : c.wool, opacity: disabled ? 0.5 : pressed ? 0.78 : 1 }]}>
    <Text style={[styles.buttonText, { color: primary ? c.onFlame : c.ink }]}>{label}</Text>
  </Pressable>;
}

/** In-memory artwork preview only. Never reads installed apps or native state. */
export function LocalPreviewScreenTimeControls() {
  const preview = useLocalArtPreview();
  return preview ? <DemoLimitControls preview={preview} /> : null;
}

function DemoLimitControls({ preview }: { preview: NonNullable<ReturnType<typeof useLocalArtPreview>> }) {
  const c = useAppColors();
  const state = preview.screenTime;
  const dispatch = preview.updateScreenTime;
  const { apps, minutes, enabled, choosing, mode, allocations, approvedMinutes } = state;
  const [panel, setPanel] = useState<'custom' | 'perApp' | null>(null);
  const [customText, setCustomText] = useState('');
  const [appText, setAppText] = useState<Partial<Record<DemoApp, string>>>({});
  const total = demoLimitTotal(state);
  const remaining = demoLimitRemaining(state);
  const askBlockReason = demoAskBlockReason(state);
  const parsedApps = Object.fromEntries(apps.map(app => [app, parseDemoMinutes(appText[app] ?? '')]));
  const validApps = apps.length > 0 && apps.every(app => parsedApps[app] !== null);
  const body = [styles.body, { color: c.inkSoft }];
  const selection = [styles.selection, { color: c.ink }];
  const input = [styles.input, { borderColor: c.seam, backgroundColor: c.wool, color: c.ink }];
  const reset = () => {
    dispatch({ type: 'reset' }); setPanel(null); setCustomText(''); setAppText({});
  };

  return <View style={styles.section}>
    <SectionHeading title="Daily app limit" />
    <ScreenTimeSetupChecklist readiness={demoScreenTimeSetupReadiness(apps.length, enabled)} />
    <Text accessibilityLiveRegion="polite" style={body}>
      {enabled ? `Daily allowance: ${dailyLimitAmountLabel(demoLimitBaseTotal(state), mode)}${mode === 'shared' ? ' total' : ''}.` : 'Daily allowance is not set.'}
    </Text>
    {mode === 'perApp' && <Text style={body}>{PER_APP_LIMIT_EXPLANATION}</Text>}
    {apps.length > 0 && <View style={[styles.card, { backgroundColor: c.woolDeep, borderColor: c.seam }]}>
      <Text accessibilityRole="header" style={selection}>Selected apps</Text>
      <View style={styles.options}>
        {apps.map(app => <View key={app} style={[styles.appTile, { backgroundColor: c.wool, borderColor: c.seam }]}>
          <View style={[styles.iconWell, { backgroundColor: c.emberWash }]}>
            <Text accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
              style={[styles.appIcon, { color: c.ember }]}>{DEMO_ICONS[app]}</Text>
          </View>
          <Text style={[styles.buttonText, { color: c.ink }]}>{app}</Text>
          {mode === 'perApp' && <Text style={body}>{allocations[app]} min per day</Text>}
        </View>)}
      </View>
    </View>}
    {enabled ? <View style={styles.actions}>
      <View style={[styles.card, { backgroundColor: c.wool, borderColor: c.seam }]}>
      <Text style={[styles.remaining, { color: c.ink }]}>Allowance: {remaining} of {total} min{mode === 'perApp' ? ' combined' : ''} left</Text>
      {approvedMinutes > 0 && <Text style={body}>Includes {approvedMinutes} approved extra minutes.</Text>}
      <View accessibilityRole="progressbar" accessibilityLabel="Remaining allowance"
        accessibilityValue={{ min: 0, max: total, now: remaining, text: `${remaining} minutes left` }}
        aria-valuemin={0} aria-valuemax={total} aria-valuenow={remaining}
        aria-valuetext={`${remaining} minutes left`}
        style={[styles.track, { backgroundColor: c.seam }]}>
        <View style={{ height: '100%', borderRadius: 5, width: `${total > 0 ? remaining / total * 100 : 0}%`, backgroundColor: c.ember }} />
      </View>
      </View>
      <DemoButton label="Advance 5 minutes" disabled={remaining === 0} onPress={() => dispatch({ type: 'simulate' })} />
      <DemoButton label="Ask for time" disabled={askBlockReason !== null} onPress={() => router.push('/')} />
      {askBlockReason && <Text style={body}>{askBlockReason}</Text>}
      <DemoButton label="Change allowance" onPress={() => dispatch({ type: 'stop' })} />
      <DemoButton label="Pause allowance" onPress={() => dispatch({ type: 'stop' })} />
    </View> : <View style={styles.actions}>
      <DemoButton label={apps.length ? 'Change apps' : 'Choose apps'} primary={!apps.length}
        onPress={() => dispatch({ type: 'choose' })} />
      {choosing && <View style={[styles.card, { backgroundColor: c.woolDeep, borderColor: c.seam }]}>
        <Text style={selection}>Choose apps</Text>
        {DEMO_APPS.map(app => {
          const checked = apps.includes(app);
          return <Pressable key={app} accessibilityRole="checkbox" accessibilityLabel={app}
            accessibilityState={{ checked }} onPress={() => dispatch({ type: 'toggle', app })}
            style={({ pressed }) => [styles.button, { borderColor: checked ? c.ember : c.seam,
              backgroundColor: checked ? c.emberWash : c.wool, opacity: pressed ? 0.78 : 1 }]}>
            <Text style={[styles.buttonText, { color: c.ink }]}>{checked ? '✓ ' : ''}{app}</Text>
          </Pressable>;
        })}
        <DemoButton label="Done" onPress={() => dispatch({ type: 'done' })} />
      </View>}
      <View style={[styles.card, { backgroundColor: c.woolDeep, borderColor: c.seam }]}>
      <Text style={selection}>Daily total: {dailyLimitAmountLabel(demoLimitBaseTotal(state), mode)}</Text>
      <View style={styles.options}>
        {DAILY_LIMIT_OPTIONS.map(value => <Pressable key={value} accessibilityRole="radio"
          accessibilityLabel={`${value} minute daily allowance`} accessibilityState={{ checked: mode === 'shared' && minutes === value }}
          onPress={() => dispatch({ type: 'minutes', minutes: value })} style={({ pressed }) => [styles.option, { borderColor: mode === 'shared' && minutes === value ? c.ember : c.seam,
            backgroundColor: mode === 'shared' && minutes === value ? c.emberWash : c.wool, opacity: pressed ? 0.78 : 1 }]}>
          <Text style={[styles.buttonText, { color: mode === 'shared' && minutes === value ? c.ember : c.ink }]}>{value}</Text>
        </Pressable>)}
      </View>
      <DemoButton label="Custom time" onPress={() => { setCustomText(String(minutes)); setPanel('custom'); }} />
      <DemoButton label="Set allowance" primary disabled={!apps.length}
        onPress={() => dispatch({ type: 'enable' })} />
      <DemoButton label="Set separate app allowances" disabled={!apps.length}
        onPress={() => { setAppText(Object.fromEntries(apps.map(app => [app, String(allocations[app])]))); setPanel('perApp'); }} />
      </View>
    </View>}
    <DemoButton label="Reset allowance" onPress={reset} />
    <FormSheet title={panel === 'perApp' ? 'Separate app allowances' : 'Custom time'} visible={panel !== null} onClose={() => setPanel(null)}>
      <Text style={body}>1 to 1440 whole minutes.</Text>
      {panel === 'perApp' ? <>
        <Text style={body}>{PER_APP_LIMIT_EXPLANATION}</Text>
        {apps.map(app => <View key={app} style={styles.actions}>
          <Text style={selection}>{app}</Text>
          <KeyboardTextInput accessibilityLabel={`Daily minutes for ${app}`} value={appText[app] ?? ''}
            onChangeText={text => setAppText(current => ({ ...current, [app]: text }))}
            keyboardType="number-pad" maxLength={4} style={input} />
        </View>)}
        <ActionButton label="Set allowances" primary disabled={!validApps} onPress={() => {
          if (validApps) { dispatch({ type: 'perApp', allocations: parsedApps as Record<DemoApp, number> }); setPanel(null); }
        }} />
      </> : <>
        <KeyboardTextInput accessibilityLabel="Custom minutes" value={customText} onChangeText={setCustomText}
          keyboardType="number-pad" maxLength={4} style={input} />
        <ActionButton label="Use this time" primary disabled={parseDemoMinutes(customText) === null} onPress={() => {
          const parsed = parseDemoMinutes(customText);
          if (parsed !== null) { dispatch({ type: 'minutes', minutes: parsed }); setPanel(null); }
        }} />
      </>}
    </FormSheet>
  </View>;
}

const styles = StyleSheet.create({
  section: { gap: Space.md },
  actions: formSectionStyle,
  body: { fontSize: 14, lineHeight: 21 },
  selection: { fontSize: 16, lineHeight: 23, fontWeight: '600' },
  remaining: { fontSize: 24, lineHeight: 31, fontWeight: '700', fontVariant: ['tabular-nums'] },
  card: { padding: Space.md, gap: FormLayout.sectionGap, borderRadius: Radius.fold, borderWidth: 1 },
  button: { ...formControlStyle, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 14, fontWeight: '600', textAlign: 'center', fontVariant: ['tabular-nums'] },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: { flexGrow: 1, flexBasis: '20%', minWidth: 56, minHeight: 44, padding: 10, borderRadius: Radius.tin, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  input: { ...formControlStyle, borderWidth: 1, fontSize: 16 },
  appTile: { flexGrow: 1, flexBasis: 90, maxWidth: 150, minHeight: 120, padding: 12, borderRadius: Radius.fold, borderWidth: 1, gap: 8, alignItems: 'center' },
  iconWell: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  appIcon: { fontSize: 25, lineHeight: 32 },
  track: { height: 10, borderRadius: 5, overflow: 'hidden' },
});
