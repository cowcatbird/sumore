import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const text = readFileSync(new URL('../components/app-tour.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile('app-tour.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function elements(tag: string) {
  const found: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === tag) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
function ancestorTags(node: ts.Node) {
  const tags: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxElement(parent)) tags.push(parent.openingElement.tagName.getText());
  }
  return tags;
}

describe('full-screen tour layout and exit paths', () => {
  it('measures safe areas inside the native modal, including the status bar and home indicator', () => {
    const [safe] = elements('SafeAreaView');
    expect(elements('SafeAreaProvider')).toHaveLength(1);
    expect(ancestorTags(safe)).toEqual(['SafeAreaView', 'SafeAreaProvider', 'Modal']);
    expect(safe.attributes.getText()).toContain("edges={['top', 'right', 'bottom', 'left']}");
    expect(elements('SafeAreaProvider')[0].attributes.getText()).not.toContain('initialWindowMetrics');
    expect(text).toContain('paddingVertical: Space.sm');
    expect(text).toContain('minHeight: 60, flexShrink: 0');
  });

  it('removes Skip and puts the only Back control in the header, with an empty first-slide slot', () => {
    expect(text).not.toMatch(/Skip|onSkip|tour\.skip\(/);
    const back = elements('Pressable').filter(node => node.attributes.getText().includes('accessibilityLabel="Previous tour step"'));
    expect(back).toHaveLength(1);
    expect(back[0].attributes.getText()).toContain('onPress={previousStep}');
    const header = elements('View').find(node => node.attributes.getText() === 'style={styles.header}')!.parent.getText();
    const footer = elements('View').find(node => node.attributes.getText() === 'style={styles.footer}')!.parent.getText();
    expect(header).toContain('step > 0');
    expect(header).toContain('accessibilityLabel="Previous tour step"');
    expect(header).toContain('<View accessible={false} style={styles.headerBack} />');
    expect(footer).not.toContain('Previous tour step');
    expect(text).toContain('tour.complete()');
  });

  it('routes system Back and accessibility Escape backward without closing the tour', () => {
    const [modal] = elements('Modal');
    expect(modal.attributes.getText()).toContain('presentationStyle="fullScreen"');
    expect(modal.attributes.getText()).toContain('onRequestClose={previousStep}');
    expect(text).toContain('onAccessibilityEscape={previousStep}');
    expect(text).toContain('if (step > 0) onStep(step - 1)');
  });

  it('keeps scrollable slides and only offers Finish on the last slide', () => {
    expect(elements('ScrollView')).toHaveLength(1);
    expect(text).toContain("accessibilityLabel={step === slides.length - 1 ? 'Finish tour' : 'Next tour step'}");
    expect(text).toContain('onPress={step === slides.length - 1 ? onFinish : () => onStep(step + 1)}');
    expect(text.indexOf('accessibilityLabel="Previous tour step"')).toBeLessThan(text.indexOf("accessibilityLabel={step === slides.length - 1"));
  });

  it('shows a decorative tab preview without navigation actions', () => {
    const preview = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'TourTabPreview');
    expect(preview).toBeDefined();
    const previewText = preview!.getText();
    expect(previewText).toContain('pointerEvents="none"');
    expect(previewText).toContain('Navigation guide. ${highlightedTab[kind]} highlighted.');
    expect(previewText).not.toMatch(/Pressable|onPress|router\.|Link|accessibilityRole="tab"/);
    expect(elements('TourTabPreview')).toHaveLength(1);
    expect(ancestorTags(elements('TourTabPreview')[0])).toContain('SafeAreaView');
    const tabs = text.slice(text.indexOf('const tourTabs = ['), text.indexOf('const highlightedTab:'));
    expect([...tabs.matchAll(/label: '([^']+)'/g)].map(match => match[1])).toEqual(['Camp', 'Screen Time', 'Circle', 'Setup']);
    expect(tabs).toContain("{ label: 'Screen Time', ios: 'hourglass', android: 'hourglass_empty' }");
    expect(text).toContain("limits: 'Screen Time'");
    expect(text).toContain("login: 'Setup'");
    expect(text).toContain("customize: 'Camp'");
    expect(text).toContain('Replay anytime in Setup');
  });

  it('fits the four decorative labels at 360px without moving their icons or shortening the accessible name', () => {
    const preview = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'TourTabPreview')!.getText();
    expect(elements('TourTabPreview')[0].attributes.getText()).toContain('compact={width < 360}');
    expect(preview).toContain('flex: 1, flexBasis: 0, minWidth: 0');
    expect(preview).toContain('width: 26, height: 26, flexShrink: 0');
    expect(preview).toContain("size={tab.label === 'Screen Time' ? 20 : 22}");
    expect(preview).toContain("style={tab.label === 'Screen Time' ? { transform: [{ translateY: 2 }] } : undefined}");
    expect(preview).toContain('height: compact ? 26 : 16');
    expect(preview).toContain('paddingTop: 2');
    expect(preview).toContain('lineHeight: 12');
    expect(preview).toContain("textAlign: 'center'");
    expect(preview).toContain("compact && tab.label === 'Screen Time' ? 'Screen\\nTime' : tab.label");
    expect(preview).toContain('accessibilityLabel={tab.label}');
    expect(preview).toContain('numberOfLines={2}');
  });

  it('suspends into real routes and resumes from a profile-bound banner in normal layout flow', () => {
    const provider = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AppTourProvider')!.getText();
    expect(provider).toContain("router.push({ pathname: '/friends', params: { invite: '1', section: 'friends' } })");
    expect(provider).toContain("router.push('/customize')");
    expect(provider).toContain('tour.suspendActivity(activity, profileId)');
    expect(provider).toContain('tour.resumeActivity(profileId)');
    expect(provider).toContain('current.profileId !== pending.owner');
    expect(provider).toContain('state.profileId === profileId');
    expect(provider).toContain('accessibilityLabel="Continue tour"');
    expect(provider).toContain('paddingTop: insets.top + 8');
    expect(provider).not.toContain("position: 'absolute'");
    expect(provider).toContain("Platform.OS === 'ios'");
    expect(elements('Modal')[0].attributes.getText()).toContain('onDismiss={onDismiss}');
  });

  it('fills the complete slide with a native horizontal pager, leaving header/footer controls outside it', () => {
    expect(text).toContain('TextInput.State.currentlyFocusedInput()');
    expect(text).toContain('TextInput.State.currentlyFocusedField()');
    expect(text).not.toContain('PanResponder');
    expect(text).toContain('pager: { flex: 1, minHeight: 0 }');
    const [pager] = elements('TabView');
    expect(pager).toBeDefined();
    expect(ancestorTags(pager)).not.toContain('ScrollView');
    expect(pager.attributes.getText()).toContain('renderScene=');
    expect(pager.attributes.getText()).toContain('<ScrollView');
    expect(pager.attributes.getText()).toContain('directionalLockEnabled');
    expect(pager.attributes.getText()).toContain('animationEnabled={!reduceMotion}');
    expect(pager.attributes.getText()).toContain('swipeEnabled={swipeEnabled}');
    expect(pager.attributes.getText()).not.toContain('onFinish');
    expect(text).toContain('visible && !screenReader && !keyboardVisible && !touchBlocked');
    expect(text).toContain('current.navigation.select(index)');
    expect(text).toContain('current.jumpTo?.(routes[current.step].key)');
  });

  it('illustrates a personal daily limit instead of a pending request count', () => {
    const illustration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'TourIllustrationView')!.getText();
    expect(illustration).toContain("ios: 'hourglass', android: 'hourglass_empty', web: 'hourglass_empty'");
    expect(illustration).toContain('>daily limit</Text>');
    expect(illustration).not.toContain('pending request');
  });

  it('uses the shared slide count for state completion and navigation bounds', () => {
    const state = readFileSync(new URL('./app-tour-state.ts', import.meta.url), 'utf8');
    expect(state).toContain('Math.min(APP_TOUR_STEP_COUNT - 1, step)');
    expect(state).toContain('state.step !== APP_TOUR_STEP_COUNT - 1');
    expect(state).not.toContain('state.step !== 4');
  });
});
