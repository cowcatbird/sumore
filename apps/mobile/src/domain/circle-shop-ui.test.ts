/// <reference types="node" />
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = ts.createSourceFile('customize.tsx', readFileSync(new URL('../app/customize.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function namedFunction(name: string): string {
  let result = '';
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}

describe('shared shop purchase UI safety', () => {
  it('shows the server wallet and an explicit shared purchase confirmation', () => {
    const screen = namedFunction('CustomizeSession');
    expect(screen).toContain('circleShop?.balance');
    expect(screen).toContain('Unlock for everyone');
    expect(screen).toContain('For everyone in your circle.');
    expect(screen).toContain('Circle balance:');
    expect(screen).toContain('Not enough s’mores yet.');
    expect(screen).not.toContain('balance: 99');
  });

  it('does not buy on an item tap and guards confirmation against duplicate taps', () => {
    const choose = namedFunction('chooseItem');
    expect(choose).toContain('setConfirmItem(item)');
    expect(choose).not.toContain('purchaseItem(');
    const buy = namedFunction('buyItem');
    expect(buy).toContain('!affordable || disabled || shoppingRef.current');
    expect(buy.indexOf('shoppingRef.current = true')).toBeLessThan(buy.indexOf('await purchaseItem(item)'));
    expect(buy).toContain('finally');
    expect(buy).toContain('shoppingRef.current = false');
  });

  it('replaces pending shop UI on an account or circle change and stops stale auto-equipping', () => {
    expect(namedFunction('CustomizeScreen')).toContain('key={`${profile.id}:${circleShop?.id');
    expect(namedFunction('CustomizeSession')).toContain('mountedRef.current = false');
    const buy = namedFunction('buyItem');
    const paid = buy.indexOf('await purchaseItem(item)');
    const guard = buy.indexOf('if (!mountedRef.current) return');
    expect(guard).toBeGreaterThan(paid);
    expect(guard).toBeLessThan(buy.indexOf('await equip(item)'));
  });

  it('offers shared backgrounds and colors without the redundant marshmallow status card', () => {
    const screen = namedFunction('CustomizeSession');
    expect(screen).toContain('BODY_COLORS.map');
    expect(screen).toContain('backgrounds.map');
    expect(namedFunction('chooseBackground')).toContain('await setBackground(background)');
    expect(screen).not.toContain('<Text style={styles.marshmallowStatusTitle}>');
    expect(source.getText()).toContain("require('../../assets/campsite/background-beach.png')");
    expect(source.getText()).toContain("require('../../assets/campsite/background-snow.png')");
    expect(namedFunction('chooseBackground')).toContain("chooseItem(`background:${background}`)");
    expect(namedFunction('equip')).toContain("item.startsWith('background:')");
  });

  it('uses catalog pricing for all paid hats and colors and equips purchased hats as hats', () => {
    const screen = namedFunction('CustomizeSession');
    expect(screen).toContain('orderedHats(circleShop).map');
    expect(screen).toContain('hatShopItem(hat.id)');
    expect(screen).toContain('item ? void chooseItem(item.id) : setAppearance({ hat: hat.id })');
    expect(screen).toContain('<PriceBadge cost={item.cost} />');
    expect(screen).toContain('SHOP_ITEMS.find(listing => listing.id === item)?.cost');
    expect(screen).toContain('<PriceBadge cost={price} />');
    expect(screen).not.toContain('cost={1}');
    expect(namedFunction('equip')).toContain("item.startsWith('hat:')");
    expect(namedFunction('equip')).toContain("setAppearance({ hat: item.slice('hat:'.length) as HatId })");
  });

  it('keeps incomplete hat rows left aligned with equal responsive widths and growing price slots', () => {
    const text = source.getText();
    expect(text).toContain('equalCardWidth(hatGridWidth || contentWidth, 92 * cardScale, 3)');
    expect(text).toContain('width: hatCardWidth');
    expect(text).toContain("hatGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start', gap: Space.sm }");
    expect(text).toContain('hatOption: { flexGrow: 0, flexShrink: 0, minHeight: 172');
    expect(text).toContain("hatPriceSlot: { minHeight: 28, marginTop: 'auto'");
    expect(namedFunction('CustomizeSession')).toContain('<View style={styles.hatPriceSlot}>');
  });

  it('wraps the seven body colors into equal-width, left-aligned cards', () => {
    const text = source.getText();
    expect(text).toContain('equalCardWidth(colorGridWidth || contentWidth, 92 * cardScale, 3)');
    expect(text).toContain('width: colorCardWidth');
    expect(text).toContain("colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm, justifyContent: 'flex-start' }");
    expect(text).toContain('colorOption: { minHeight: 156');
    expect(text).not.toContain('colorOption: { flex: 1');
  });

  it('uses each campsite’s own unlock and catalog price in a two-column grid', () => {
    const text = source.getText();
    expect(text).toContain('listing.id === `background:${background.id}`');
    expect(text).toContain('!hasShopUnlock(circleShop, item.id)');
    expect(text).toContain('equalCardWidth(backgroundGridWidth || contentWidth, 132 * cardScale, 2)');
    expect(text).toContain('width: campsiteCardWidth');
    expect(text).toContain("backgroundGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start', gap: Space.sm }");
    expect(text).not.toContain('<PriceBadge cost={30} />');
  });
});
