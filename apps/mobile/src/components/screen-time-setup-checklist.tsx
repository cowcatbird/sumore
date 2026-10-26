import { Text, View } from 'react-native';

import { Radius, Space, useAppColors } from '@/constants/theme';
import type { ScreenTimeSetupReadiness } from '@/domain/daily-limit-controls';

/** Presentation only: live and demo callers provide explicitly separate state. */
export function ScreenTimeSetupChecklist({ readiness }: { readiness: ScreenTimeSetupReadiness }) {
  const c = useAppColors();
  return <View style={{ padding: Space.md, gap: 16, backgroundColor: c.wool, borderRadius: Radius.fold,
    borderWidth: 1, borderColor: c.seam }}>
    <View style={{ gap: 6 }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, lineHeight: 23, fontWeight: '700' }}>{readiness.title}</Text>
      <Text accessibilityLiveRegion="polite" style={{ color: c.inkSoft, fontSize: 13, lineHeight: 19 }}>{readiness.summary}</Text>
    </View>
    {readiness.steps.map((step, index) => <View key={step.id}
      accessible accessibilityLabel={`${step.label}: ${step.complete ? 'complete' : 'needed'}. ${step.detail}`}
      style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start',
        borderTopWidth: index > 0 ? 1 : 0, borderTopColor: c.seam, paddingTop: index > 0 ? 12 : 0 }}>
      <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
        backgroundColor: step.complete ? c.emberWash : c.woolDeep, borderWidth: 1, borderColor: step.complete ? c.emberLow : c.seam }}>
        <Text accessible={false} style={{ color: step.complete ? c.ember : c.inkSoft, fontSize: 13, fontWeight: '700' }}>{step.complete ? '✓' : `${index + 1}.`}</Text>
      </View>
      <View style={{ flex: 1, gap: 3, paddingTop: 3 }}>
        <Text style={{ color: c.ink, fontSize: 14, lineHeight: 20, fontWeight: '600' }}>{step.label}</Text>
        <Text style={{ color: c.inkSoft, fontSize: 12, lineHeight: 18 }}>{step.detail}</Text>
      </View>
    </View>)}
    {readiness.warning && <View style={{ padding: 12, borderRadius: Radius.tin, backgroundColor: c.woolDeep,
      borderLeftWidth: 3, borderLeftColor: c.scarlet }}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="polite"
        style={{ color: c.ink, fontSize: 13, lineHeight: 19 }}>{readiness.warning}</Text>
    </View>}
  </View>;
}
