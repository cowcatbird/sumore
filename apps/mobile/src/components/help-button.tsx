import { Children, Fragment, cloneElement, isValidElement, useMemo, useState, type ReactNode } from 'react';
import { Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextProps, type TextStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Radius, Space, useAppColors } from '@/constants/theme';

function helpContent(children: ReactNode, bodyStyle: StyleProp<TextStyle>): ReactNode {
  return Children.map(children, child => {
    if (typeof child === 'string' || typeof child === 'number') return <Text style={bodyStyle}>{child}</Text>;
    if (isValidElement<TextProps>(child) && child.type === Text) {
      return cloneElement(child, { style: [bodyStyle, child.props.style] });
    }
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      return cloneElement(child, { children: helpContent(child.props.children, bodyStyle) });
    }
    return child;
  });
}

export function HelpButton({ title, children, accessibilityLabel }: {
  title: string; children: ReactNode; accessibilityLabel?: string;
}) {
  const [visible, setVisible] = useState(false);
  const c = useAppColors();
  const styles = useMemo(() => StyleSheet.create({
    target: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    question: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: c.inkSoft, alignItems: 'center', justifyContent: 'center' },
    glyph: { color: c.inkSoft, fontSize: 16, lineHeight: 20, fontWeight: '700' },
    backdrop: { flex: 1, padding: Space.md, backgroundColor: 'rgba(0, 0, 0, 0.65)', justifyContent: 'center', alignItems: 'center' },
    card: { width: '100%', maxWidth: 520, maxHeight: '100%', borderRadius: Radius.blanket, borderWidth: 1, borderColor: c.seam, backgroundColor: c.wool, overflow: 'hidden' },
    header: { flexDirection: 'row', alignItems: 'center', gap: Space.sm, paddingLeft: Space.lg, paddingRight: Space.sm, paddingVertical: Space.sm },
    title: { flex: 1, color: c.ink, fontSize: 23, lineHeight: 29, fontWeight: '700' },
    close: { color: c.inkSoft, fontSize: 27, lineHeight: 31 },
    scroll: { flexShrink: 1 },
    content: { paddingHorizontal: Space.lg, paddingBottom: Space.lg, gap: Space.md },
    body: { color: c.inkSoft, fontSize: 17, lineHeight: 26 },
    done: { minHeight: 48, marginHorizontal: Space.lg, marginBottom: Space.lg, borderRadius: Radius.coal, backgroundColor: c.ember, justifyContent: 'center', alignItems: 'center', padding: Space.sm },
    doneText: { color: c.onFlame, fontSize: 16, lineHeight: 22, fontWeight: '700' },
  }), [c]);
  const close = () => setVisible(false);
  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? `Help: ${title}`}
      accessibilityHint="Opens a short explanation" style={styles.target}
      onPress={() => { Keyboard.dismiss(); setVisible(true); }}>
      <View style={styles.question}><Text allowFontScaling={false} style={styles.glyph}>?</Text></View>
    </Pressable>
    <Modal visible={visible} transparent animationType="fade" presentationStyle="overFullScreen" onRequestClose={close}>
      <SafeAreaView style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal onAccessibilityEscape={close}>
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close help" onPress={close} style={styles.target}>
              <Text allowFontScaling={false} style={styles.close}>×</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            {helpContent(children, styles.body)}
          </ScrollView>
          <Pressable accessibilityRole="button" onPress={close} style={styles.done}><Text style={styles.doneText}>Got it</Text></Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  </>;
}
