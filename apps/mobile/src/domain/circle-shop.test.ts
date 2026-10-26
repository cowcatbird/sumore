import { describe, expect, it } from 'vitest';

import { BODY_COLORS, defaultAppearance, HATS } from './character';
import { canPurchaseShopItem, canUseAppearance, canUseBackground, hasShopUnlock, hatShopItem, isShopItemId, parseCircleShop, SHOP_ITEMS, unlockedAppearance, type CircleShop } from './circle-shop';

const paidHats = ['crown', 'wizard', 'pirate', 'clown', 'viking', 'cat-ears', 'bubble-gum', 'googly-eyes', 'disguise-glasses'] as const;
const paidColors = BODY_COLORS.map(({ id }) => id).filter(id => id !== 'cream');

const shop: CircleShop = {
  id: 'test-circle', name: 'Our circle', balance: 99, unlocked: [], background: 'forest',
  localDate: '2026-09-17', timeZone: 'America/Los_Angeles', askedToday: false, eligibleToday: true,
  dayStartedAt: '2026-09-17T07:00:00Z', nextAwardAt: '2026-09-18T07:00:00Z', initializedAt: '2026-09-16T18:00:00Z',
};

describe('shared circle shop', () => {
  it('lists only the requested items and prices', () => {
    expect(SHOP_ITEMS.map(({ id, cost }) => [id, cost])).toEqual([
      ['hat:crown', 10], ['hat:wizard', 5], ['hat:pirate', 5], ['hat:clown', 5], ['hat:viking', 5],
      ['hat:cat-ears', 5], ['hat:bubble-gum', 5], ['hat:googly-eyes', 5], ['hat:disguise-glasses', 5],
      ['color:red', 5], ['color:orange', 5], ['color:yellow', 5], ['color:green', 5],
      ['color:blue', 5], ['color:pink', 5], ['background:beach', 30], ['background:snow', 30],
    ]);
    expect(isShopItemId('crown')).toBe(false);
    expect(isShopItemId('__proto__')).toBe(false);
    expect(isShopItemId('color:cream')).toBe(false);
    expect(SHOP_ITEMS.filter(({ kind }) => kind === 'color').map(({ id, label }) => [id, label]))
      .toEqual(BODY_COLORS.filter(({ id }) => id !== 'cream').map(({ id, label }) => [`color:${id}`, label]));
  });

  it('maps only paid hats to catalog entries, preserving every other free hat', () => {
    for (const { id: hat, label } of HATS) {
      const listing = hatShopItem(hat);
      if (paidHats.some(paid => paid === hat)) {
        expect(listing).toEqual({ id: `hat:${hat}`, label, cost: hat === 'crown' ? 10 : 5, kind: 'hat' });
        expect(listing).toBe(SHOP_ITEMS.find(item => item.id === `hat:${hat}`));
      } else {
        expect(listing).toBeUndefined();
        expect(isShopItemId(`hat:${hat}`)).toBe(false);
        expect(canUseAppearance(undefined, { hat, body: 'tall' })).toBe(true);
        expect(unlockedAppearance(undefined, { hat, body: 'tall' })).toEqual({ hat, body: 'tall' });
      }
    }
  });

  it('reads a server balance without adding a starter gift or synthesizing rewards', () => {
    expect(parseCircleShop(shop)).toEqual(shop);
    expect(parseCircleShop({ ...shop, balance: 0, askedToday: true })?.balance).toBe(0);
    expect(parseCircleShop(undefined)).toBeUndefined();
    expect(parseCircleShop({})).toBeUndefined();
  });

  it('keeps one unlock per item and never mutates server payloads', () => {
    const unlocked = ['hat:crown', 'hat:crown', 'background:beach'];
    const parsed = parseCircleShop({ ...shop, unlocked, background: 'beach', unrelated: 'ignored' });
    expect(parsed?.unlocked).toEqual(['hat:crown', 'background:beach']);
    expect(unlocked).toHaveLength(3);
    expect(parsed).not.toHaveProperty('unrelated');
  });

  it('round-trips all catalog unlocks and preserves existing ownership after repricing', () => {
    const unlocked = SHOP_ITEMS.map(({ id }) => id);
    const parsed = parseCircleShop(JSON.parse(JSON.stringify({ ...shop, unlocked, background: 'beach' })));
    expect(parsed?.unlocked).toEqual(unlocked);
    for (const item of SHOP_ITEMS) {
      expect(isShopItemId(item.id)).toBe(true);
      expect(hasShopUnlock(parsed, item.id)).toBe(true);
      expect(canPurchaseShopItem(parsed, item.id)).toBe(false);
    }
    const legacyUnlocks = ['hat:crown', 'color:blue', 'color:orange', 'color:pink'] as const;
    const legacy = parseCircleShop({ ...shop, balance: 0, unlocked: legacyUnlocks });
    expect(legacy?.unlocked).toEqual(legacyUnlocks);
    for (const color of ['red', 'yellow', 'green'] as const) {
      expect(hasShopUnlock(legacy, `color:${color}`)).toBe(false);
    }
  });

  it('rejects malformed balances, group state, and unsupported unlocks', () => {
    for (const override of [
      { balance: -1 }, { balance: 0.5 }, { balance: '99' }, { balance: Number.MAX_SAFE_INTEGER + 1 },
      { unlocked: ['hat:admin'] }, { unlocked: ['color:purple'] }, { unlocked: ['color:cream'] },
      { unlocked: null }, { background: 'beach' }, { background: 'snow' }, { background: 'space' },
      { background: 'snow', unlocked: ['background:beach'] },
      { id: '' }, { name: ' ' }, { askedToday: 'false' }, { eligibleToday: undefined },
      { localDate: '2026-02-30' }, { localDate: '2026-9-17' }, { timeZone: '' },
      { nextAwardAt: 'tomorrow' }, { dayStartedAt: undefined }, { initializedAt: 'not-a-date' },
      { dayStartedAt: '2026-02-30T07:00:00Z' }, { nextAwardAt: shop.dayStartedAt },
    ]) expect(parseCircleShop({ ...shop, ...override })).toBeUndefined();
  });

  it('accepts server microseconds and optional initialization metadata', () => {
    const { initializedAt: _ignored, ...legacy } = shop;
    const value = { ...legacy, nextAwardAt: '2026-09-18T07:00:00.123456+00:00' };
    expect(parseCircleShop(value)).toEqual(value);
  });

  it('displays affordability without spending locally or selling an unlock twice', () => {
    expect(canPurchaseShopItem(shop, 'background:beach')).toBe(true);
    expect(canPurchaseShopItem({ ...shop, balance: 29 }, 'background:beach')).toBe(false);
    expect(canPurchaseShopItem({ ...shop, balance: 0 }, 'hat:crown')).toBe(false);
    expect(canPurchaseShopItem({ ...shop, unlocked: ['hat:crown'] }, 'hat:crown')).toBe(false);
    expect(canPurchaseShopItem(undefined, 'hat:crown')).toBe(false);
    expect(shop.balance).toBe(99);
    expect(shop.unlocked).toEqual([]);
  });

  it.each(SHOP_ITEMS)('uses the exact shared-wallet affordability boundary for $id', item => {
    expect(canPurchaseShopItem({ ...shop, balance: item.cost - 1 }, item.id)).toBe(false);
    expect(canPurchaseShopItem({ ...shop, balance: item.cost }, item.id)).toBe(true);
    expect(canPurchaseShopItem({ ...shop, balance: item.cost + 1 }, item.id)).toBe(true);
    expect(canPurchaseShopItem({ ...shop, balance: item.cost, unlocked: [item.id] }, item.id)).toBe(false);
    expect(canPurchaseShopItem(undefined, item.id)).toBe(false);
    expect(canPurchaseShopItem(null, item.id)).toBe(false);
  });

  it('checks shared unlocks for colors and crown while leaving existing free items available', () => {
    expect(canUseAppearance(undefined, defaultAppearance)).toBe(true);
    expect(canUseAppearance(shop, { hat: 'cat', body: 'tall', color: 'cream' })).toBe(true);
    expect(canUseAppearance(shop, { hat: 'crown', body: 'tall' })).toBe(false);
    expect(canUseAppearance(shop, { ...defaultAppearance, color: 'pink' })).toBe(false);
    const owned: CircleShop = { ...shop, unlocked: ['hat:crown', 'color:pink'] };
    expect(hasShopUnlock(owned, 'hat:crown')).toBe(true);
    expect(canUseAppearance(owned, { hat: 'crown', body: 'tall', color: 'pink' })).toBe(true);
    expect(canUseAppearance(owned, { hat: 'crown', body: 'tall', color: 'orange' })).toBe(false);
  });

  it.each(paidHats)('requires the current circle to own %s for both bodies and every paid color', hat => {
    const item = hatShopItem(hat)!;
    for (const body of ['short', 'tall'] as const) {
      const appearance = { hat, body };
      for (const unavailable of [undefined, null, shop]) {
        expect(canUseAppearance(unavailable, appearance)).toBe(false);
        expect(unlockedAppearance(unavailable, appearance)).toEqual({ hat: 'none', body });
      }
      const owned: CircleShop = { ...shop, unlocked: [item.id] };
      expect(canUseAppearance(owned, appearance)).toBe(true);
      expect(unlockedAppearance(owned, appearance)).toEqual(appearance);
      for (const color of paidColors) {
        const colored = { ...appearance, color };
        expect(canUseAppearance(owned, colored)).toBe(false);
        expect(unlockedAppearance(owned, colored)).toEqual({ ...appearance, color: 'cream' });
        const fullyOwned: CircleShop = { ...owned, unlocked: [item.id, `color:${color}`] };
        expect(canUseAppearance(fullyOwned, colored)).toBe(true);
        expect(unlockedAppearance(fullyOwned, colored)).toEqual(colored);
        // Ownership in a former circle never carries to a new empty circle.
        expect(unlockedAppearance({ ...shop, id: 'another-circle' }, colored)).toEqual({ hat: 'none', body, color: 'cream' });
        expect(unlockedAppearance(fullyOwned, colored)).toEqual(colored);
        expect(colored).toEqual({ hat, body, color });
      }
    }
  });

  it.each(paidColors)('hides unverified %s without altering stored preferences or free hats', color => {
    const appearance = { hat: 'beanie', body: 'tall', color } as const;
    expect(unlockedAppearance(undefined, appearance)).toEqual({ ...appearance, color: 'cream' });
    expect(unlockedAppearance({ ...shop, unlocked: [`color:${color}`] }, appearance)).toEqual(appearance);
    expect(appearance.color).toBe(color);
    expect(shop.unlocked).toEqual([]);
    expect(shop.balance).toBe(99);
  });

  it.each(['beach', 'snow'] as const)('leaves the forest free and requires the exact shared %s unlock', background => {
    const other = background === 'beach' ? 'snow' : 'beach';
    expect(canUseBackground(undefined, 'forest')).toBe(true);
    expect(canUseBackground(shop, background)).toBe(false);
    expect(canUseBackground(undefined, background)).toBe(false);
    expect(canUseBackground({ ...shop, unlocked: [`background:${other}`] }, background)).toBe(false);
    const owned: CircleShop = { ...shop, unlocked: [`background:${background}`], background };
    expect(canUseBackground(owned, background)).toBe(true);
    expect(parseCircleShop(JSON.parse(JSON.stringify(owned)))).toEqual(owned);
  });
});
