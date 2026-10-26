import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const layout = read('../app/_layout.tsx');
const source = ts.createSourceFile('_layout.tsx', layout, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const geometryFunction = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'tabLabelLayout');
if (!geometryFunction) throw new Error('Tab label geometry helper is missing.');
const tabLabelLayout = runInNewContext(`${ts.transpile(geometryFunction.getText(source))}; tabLabelLayout;`) as
  (width: number, fontScale: number) => { compact: boolean; fontSize: number; labelHeight: number; barHeight: number; maxFontSizeMultiplier: number };

function registeredTabs() {
  const tabs: { route: string; title: string }[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'Tabs.Screen') {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const name = attributes.find(attribute => attribute.name.getText() === 'name')?.initializer;
      const options = attributes.find(attribute => attribute.name.getText() === 'options')?.initializer;
      if (name && ts.isStringLiteral(name) && options && ts.isJsxExpression(options)
        && options.expression && ts.isObjectLiteralExpression(options.expression)) {
        const title = options.expression.properties.find(property => ts.isPropertyAssignment(property)
          && property.name.getText() === 'title');
        if (title && ts.isPropertyAssignment(title) && ts.isStringLiteral(title.initializer)) {
          tabs.push({ route: name.text, title: title.initializer.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return tabs;
}

describe('Screen Time tab navigation', () => {
  it('shows four main tabs while retaining routes for requests and customization', () => {
    expect(registeredTabs()).toEqual([
      { route: 'index', title: 'Camp' },
      { route: 'screen-time', title: 'Screen Time' },
      { route: 'friends', title: 'Circle' },
      { route: 'settings', title: 'Setup' },
    ]);
    expect(layout).toContain('<Tabs.Screen name="requests" options={{ href: null }} />');
    expect(layout).toContain('<Tabs.Screen name="customize" options={{ href: null }} />');
    const circle = layout.slice(layout.indexOf('name="friends"'), layout.indexOf('name="settings"'));
    expect(circle).toContain('tabBarBadge: incomingRequests.length || undefined');
  });

  it('gives Screen Time the keyboard-safe, inset-aware page and removes its controls from Setup', () => {
    const screenTime = read('../app/screen-time.tsx');
    expect(screenTime).toContain('<ScreenHeader title="Screen Time" />');
    expect(screenTime).toContain('<SafeAreaView edges={[\'top\']}');
    expect(screenTime).toContain('<KeyboardForm');
    expect(screenTime).toContain('<ScreenTimeControls />');
    const settings = read('../app/settings.tsx');
    expect(settings).not.toContain('ScreenTimeControls');
    expect(settings).toContain('<ScreenHeader title="Setup" />');
    for (const section of ['Notifications', '<AccountControls', '<HelpFeedbackControls']) {
      expect(settings).toContain(section);
    }
  });

  it('keeps compact labels below aligned icons with a full accessible Screen Time name', () => {
    expect(layout).toContain("tabBarLabelPosition: 'below-icon'");
    expect(layout).toContain('const { width, fontScale } = useWindowDimensions()');
    expect(layout).toContain('tabLabelLayout(width, fontScale)');
    expect(layout).toContain('height: labelHeight');
    expect(layout).toContain("compactTabs && children === 'Screen Time' ? 'Screen\\nTime' : children");
    expect(layout).toContain("tabBarAccessibilityLabel: 'Screen Time, tab 2 of 4'");
  });

  it('reserves equal-width cells and nonshrinking icon and label rows with enough vertical room', () => {
    expect(layout).toContain('tabBarItemStyle: { flex: 1, flexBasis: 0, minWidth: 0 }');
    expect(layout).toContain('tabBarIconStyle: { width: 26, height: 26, flexShrink: 0 }');
    expect(layout).toContain("width: '100%', height: labelHeight, flexShrink: 0, paddingTop: 2");
    expect(layout).toContain('height: barHeight');
    expect(layout).toContain('<Text allowFontScaling maxFontSizeMultiplier={maxFontSizeMultiplier} numberOfLines={2}');
    expect(layout).not.toContain('allowFontScaling={false}');
    // Slightly smaller hourglass ink matches the rounded icons within identical slots.
    expect([...layout.matchAll(/size=\{(\d+)\}/g)].map(match => Number(match[1]))).toEqual([22, 20, 22, 22]);
    // Border + outer padding + the navigator's 5px item padding per edge + both rows.
    expect(96).toBeGreaterThanOrEqual(1 + 8 + 24 + 10 + 26 + 26);
  });

  it('preserves default geometry and enables bounded larger text without shrinking its base size', () => {
    expect(tabLabelLayout(320, 1)).toEqual({ compact: true, fontSize: 10, labelHeight: 26, barHeight: 96, maxFontSizeMultiplier: 1.4 });
    expect(tabLabelLayout(390, 1)).toEqual({ compact: false, fontSize: 11, labelHeight: 16, barHeight: 88, maxFontSizeMultiplier: 1.4 });
    expect(tabLabelLayout(390, 1.4)).toEqual({ compact: true, fontSize: 11, labelHeight: 36, barHeight: 106, maxFontSizeMultiplier: 1.4 });
    expect(tabLabelLayout(390, 3)).toEqual(tabLabelLayout(390, 1.4));
    expect(tabLabelLayout(390, 0.8)).toEqual(tabLabelLayout(390, 1));
  });

  it.each([320, 359, 360, 390, 430, 560, 1024])('reserves both scaled label lines and equal icon slots at width %i', width => {
    for (const fontScale of [0.8, 1, 1.05, 1.15, 1.25, 1.4, 2, 3]) {
      const geometry = tabLabelLayout(width, fontScale);
      const scale = Math.min(1.4, Math.max(1, fontScale));
      expect(geometry.compact).toBe(width / scale < 360);
      expect(geometry.labelHeight).toBeGreaterThanOrEqual(2 + 12 * scale * (geometry.compact ? 2 : 1));
      expect(geometry.barHeight).toBeGreaterThanOrEqual(1 + 8 + 24 + 10 + 26 + geometry.labelHeight);
    }
  });

  it('announces four visible tabs, not the hidden customization and legacy request routes', () => {
    expect(layout).toContain("tabBarAccessibilityLabel: 'Camp, tab 1 of 4'");
    expect(layout).toContain("tabBarAccessibilityLabel: 'Screen Time, tab 2 of 4'");
    expect(layout).toContain('tabBarAccessibilityLabel: `Circle, tab 3 of 4');
    expect(layout).toContain('${incomingRequests.length} waiting');
    expect(layout).toContain("tabBarAccessibilityLabel: 'Setup, tab 4 of 4'");
    expect(layout.match(/tabBarAccessibilityLabel:/g)).toHaveLength(4);
  });

  it('routes app-limit guidance and supported notifications to the new screen', () => {
    expect(read('./approval-presentation.ts')).toContain('Enable your app limit in Screen Time');
    expect(read('../app/index.tsx')).toContain('Manage app limits in the Screen Time tab.');
    expect(read('../services/notifications.ts')).toContain("url === '/screen-time'");
    expect(read('../services/notifications.ts')).toContain("router.push({ pathname: '/friends', params: { section: 'requests' } })");
  });

  it('nudges only the hourglass artwork down without shifting its tab or label', () => {
    const screenTimeTab = layout.slice(layout.indexOf('name="screen-time"'), layout.indexOf('name="friends"'));
    expect(screenTimeTab).toContain('style={{ transform: [{ translateY: 2 }] }}');
    expect(layout.match(/translateY: 2/g)).toHaveLength(1);
  });
});
