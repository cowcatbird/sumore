import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const text = readFileSync(new URL('../app/customize.tsx', import.meta.url), 'utf8');
const source = ts.createSourceFile('customize.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const widthFunction = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'equalCardWidth');
if (!widthFunction) throw new Error('Missing card layout helper');
const equalCardWidth = runInNewContext(`${ts.transpile(widthFunction.getText(source))}; equalCardWidth`,
  { Space: { sm: 12 } }) as (available: number, minimum: number, columns: number) => number;

function style(name: string): ts.ObjectLiteralExpression {
  let found: ts.ObjectLiteralExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === name && ts.isObjectLiteralExpression(node.initializer)) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error(`Missing style ${name}`);
  return found;
}
const properties = (name: string) => style(name).properties.filter(ts.isPropertyAssignment).map(property => property.name.getText(source));

describe('camper shop responsive presentation', () => {
  it.each([
    [288, 92, 3, 138], // 320px phone: two equally sized hat/color cards.
    [328, 92, 3, (328 - 24) / 3],
    [608, 92, 3, (608 - 24) / 3],
    [288, 92 * 1.4, 3, 138], // 320px at 140%: still two readable, aligned cards.
    [328, 92 * 1.4, 3, 158],
    [288, 184, 3, 288], // Double-size text gets a full-width card.
    [328, 184, 3, 328],
    [288, 132, 2, 138],
    [288, 132 * 1.4, 2, 288],
    [288, 264, 2, 288], // Campsite captions also grow with accessibility text.
  ])('fills %ipx rows with equal nonoverflowing card widths', (available, minimum, columns, expected) => {
    const width = equalCardWidth(available, minimum, columns);
    expect(width).toBeCloseTo(expected);
    expect(width).toBeGreaterThanOrEqual(44);
    expect(width).toBeGreaterThanOrEqual(Math.min(available, minimum));
    expect(width).toBeLessThanOrEqual(available);
    const count = Math.max(1, Math.min(columns, Math.floor((available + 12) / (minimum + 12))));
    expect(width * count + 12 * (count - 1)).toBeCloseTo(available);
  });

  it('lets item labels, price badges, status and button text grow instead of clipping', () => {
    for (const name of ['hatOption', 'hatPriceSlot', 'colorOption', 'bodyOption', 'backgroundCaption',
      'priceBadge', 'wallet', 'walletAmount', 'saveNotice', 'returnButton', 'confirmButton', 'cancelButton']) {
      expect(properties(name)).not.toContain('height');
      expect(properties(name)).not.toContain('maxHeight');
    }
    expect(text).toContain('const cardScale = Math.max(1, fontScale)');
    expect(text).toContain('paddingBottom: insets.bottom + Space.xxl');
    expect(text).not.toContain('numberOfLines=');
    expect(text).not.toContain('maxFontSizeMultiplier=');
  });

  it('keeps source artwork dimensions and its existing lighting unchanged', () => {
    expect(text).toContain('<CharacterSprite appearance={appearance} burnt={burnt} size={166} lighting={0.8} />');
    expect(text).toContain('<HatSprite hat={hat.id} size={70} />');
    expect(text).toContain('size={57} lighting={0.65} showMarshmallow={false}');
    expect(style('stage').getText(source)).toContain('height: 250');
    expect(text).toContain('<CampsiteThumbnail source={background.image} sourceWidth={background.id === \'snow\' ? 1139 : 1080} />');
  });

  it('keeps all shop controls accessible and gives small standalone actions full touch targets', () => {
    for (const name of ['backButton', 'retry']) expect(style(name).getText(source)).toContain('minHeight: 44');
    for (const name of ['returnButton', 'confirmButton', 'cancelButton']) {
      expect(style(name).getText(source)).toContain('minHeight: FormLayout.controlHeight');
      expect(style(name).getText(source)).toContain('paddingVertical: Space.sm');
    }
    expect(text.match(/accessibilityRole="radio"/g)).toHaveLength(4);
    expect(text.match(/accessibilityState=\{\{ checked: selected, selected, disabled/g)).toHaveLength(4);
    expect(text).toContain('styles.cancelButton, pressed && styles.pressed');
    expect(text).toContain('styles.backButton, pressed && styles.pressed');
  });
});
