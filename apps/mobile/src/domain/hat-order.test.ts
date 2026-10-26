import { describe, expect, it } from 'vitest';

import { HATS, type HatId } from './character';
import { orderedHats, type CircleShop, type ShopItemId } from './circle-shop';

const originalCatalog = HATS.map(hat => ({ ...hat }));
const catalogIds = originalCatalog.map(hat => hat.id);
const paidHats = ['crown', 'wizard', 'pirate', 'clown', 'viking', 'cat-ears', 'bubble-gum', 'googly-eyes', 'disguise-glasses'] as const;
const lockedPriceOrder: HatId[] = ['wizard', 'pirate', 'clown', 'viking', 'cat-ears', 'bubble-gum', 'googly-eyes', 'disguise-glasses', 'crown'];
const freeHatIds: HatId[] = [
  'none', 'cowboy', 'cow', 'cat', 'sunglasses', 'duck', 'top-hat', 'halo',
  'beanie', 'bucket', 'headband', 'propeller', 'sunflower', 'lollipop',
];
const emptyShop: CircleShop = {
  id: 'test-circle', name: 'Our circle', balance: 200, unlocked: [], background: 'forest',
  localDate: '2026-09-18', timeZone: 'UTC', askedToday: false, eligibleToday: true,
  dayStartedAt: '2026-09-18T00:00:00Z', nextAwardAt: '2026-09-19T00:00:00Z',
};
const ids = (shop: CircleShop | null | undefined) => orderedHats(shop).map(hat => hat.id);

describe('available-first hat ordering', () => {
  it('keeps the catalog order when every hat is unlocked and returns a new array', () => {
    const shop: CircleShop = { ...emptyShop, unlocked: paidHats.map(hat => `hat:${hat}` as const) };
    const ordered = orderedHats(shop);
    expect(ordered.map(hat => hat.id)).toEqual(catalogIds);
    expect(ordered).toEqual(originalCatalog);
    expect(ordered).not.toBe(HATS);
  });

  it('puts free hats first and locked five-s’more hats before the ten-s’more crown', () => {
    expect(ids(emptyShop)).toEqual([...freeHatIds, ...lockedPriceOrder]);
    // Funds do not mean ownership, and being unable to afford a hat does not
    // alter its position among the other locked hats.
    expect(ids({ ...emptyShop, balance: 0 })).toEqual(ids(emptyShop));
    expect(ids({ ...emptyShop, balance: 10_000 })).toEqual(ids(emptyShop));
  });

  it.each(paidHats)('moves purchased %s into the available section without reshuffling its peers', hat => {
    const shop: CircleShop = { ...emptyShop, unlocked: [`hat:${hat}`] };
    const available = catalogIds.filter(id => freeHatIds.includes(id) || id === hat);
    const locked = lockedPriceOrder.filter(id => id !== hat);
    expect(ids(shop)).toEqual([...available, ...locked]);
  });

  it.each([undefined, null])('keeps paid hats locked when the wallet is %s', shop => {
    expect(ids(shop)).toEqual([...freeHatIds, ...lockedPriceOrder]);
  });

  it('keeps equal-priced hats and available hats in catalog order, not purchase order', () => {
    const shop: CircleShop = {
      ...emptyShop,
      unlocked: ['hat:viking', 'hat:pirate', 'hat:crown', 'color:blue', 'background:beach'],
    };
    expect(ids(shop)).toEqual([
      'none', 'cowboy', 'cow', 'cat', 'sunglasses', 'duck', 'top-hat', 'halo', 'crown',
      'beanie', 'bucket', 'headband', 'propeller', 'pirate', 'viking', 'sunflower', 'lollipop',
      'wizard', 'clown', 'cat-ears', 'bubble-gum', 'googly-eyes', 'disguise-glasses',
    ]);
    expect(ids({ ...shop, unlocked: [...shop.unlocked].reverse() })).toEqual(ids(shop));
  });

  it('preserves every hat, its metadata, and both inputs across all ownership combinations', () => {
    for (let mask = 0; mask < 2 ** paidHats.length; mask += 1) {
      const owned = paidHats.filter((_hat, index) => (mask & (1 << index)) !== 0);
      const unlocked: ShopItemId[] = owned.map(hat => `hat:${hat}` as const);
      const shop: CircleShop = { ...emptyShop, unlocked };
      const before = JSON.stringify(shop);
      const ordered = orderedHats(shop);
      const expectedAvailable = catalogIds.filter(id => freeHatIds.includes(id) || owned.some(hat => hat === id));
      const expectedLocked = lockedPriceOrder.filter(id => !owned.some(hat => hat === id));

      expect(ordered.map(hat => hat.id)).toEqual([...expectedAvailable, ...expectedLocked]);
      expect(ordered).toHaveLength(originalCatalog.length);
      expect(new Set(ordered.map(hat => hat.id)).size).toBe(originalCatalog.length);
      for (const hat of ordered) expect(hat).toEqual(originalCatalog.find(original => original.id === hat.id));
      expect(ordered).not.toBe(HATS);
      expect(orderedHats(shop)).not.toBe(ordered);
      expect(JSON.stringify(shop)).toBe(before);
      expect(HATS).toEqual(originalCatalog);
    }
    expect(ids(emptyShop)).toEqual([...freeHatIds, ...lockedPriceOrder]);
  });
});
