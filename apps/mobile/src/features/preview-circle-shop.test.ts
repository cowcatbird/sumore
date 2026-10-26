import { describe, expect, it } from 'vitest';

import { SHOP_ITEMS } from '@/domain/circle-shop';
import { demoLimitRemaining, type DemoAction } from '@/domain/demo-screen-time';
import { createPreviewAppState, previewAppSnapshot, updatePreviewScreenTime } from './preview-app-state';
import { initialPreviewShop, LEGACY_PREVIEW_SHOP_KEY, PREVIEW_SHOP_KEY, pressPreviewPanicButton, purchasePreviewItem, restorePreviewShop, setPreviewBackground } from './preview-circle-shop';

describe('isolated preview shared wallet', () => {
  const today = new Date(2026, 8, 17, 12);
  it('starts at zero and keeps explicitly funded purchases across reloads and day changes', () => {
    const first = initialPreviewShop(today);
    expect(first.balance).toBe(0);
    expect(() => purchasePreviewItem(first, 'background:beach')).toThrow('more s’mores');
    const purchased = purchasePreviewItem({ ...first, balance: 200 }, 'background:beach');
    expect(purchased.balance).toBe(170);
    const restored = restorePreviewShop(JSON.stringify(setPreviewBackground(purchased, 'beach')), new Date(2026, 8, 18, 12));
    expect(restored).toMatchObject({ balance: 170, background: 'beach', unlocked: ['background:beach'], localDate: '2026-09-18' });
  });
  it('charges each shared unlock only once with the current 140-smores catalog total', () => {
    let shop = { ...initialPreviewShop(today), balance: 200 };
    for (const { id: item } of SHOP_ITEMS) {
      shop = purchasePreviewItem(shop, item);
      const once = shop;
      shop = purchasePreviewItem(shop, item);
      expect(shop).toBe(once);
    }
    expect(shop.balance).toBe(60);
    expect(shop.unlocked).toHaveLength(17);
    expect(restorePreviewShop(JSON.stringify(shop), today)).toMatchObject({ balance: 60, unlocked: shop.unlocked });
  });
  it('preserves saved spending and old unlocks when new accessories enter the catalog', () => {
    const existing = { ...initialPreviewShop(today), balance: 62, unlocked: ['hat:crown', 'hat:wizard', 'background:beach'], background: 'beach' };
    const restored = restorePreviewShop(JSON.stringify(existing), today);
    expect(restored).toMatchObject(existing);
    const purchased = purchasePreviewItem(restored, 'hat:cat-ears');
    expect(purchased).toMatchObject({ balance: 57, unlocked: [...existing.unlocked, 'hat:cat-ears'], background: 'beach' });
    expect(restored).toMatchObject(existing);
    expect(restorePreviewShop(JSON.stringify(purchased), today)).toMatchObject(purchased);
  });
  it('rejects insufficient funds and locked backgrounds without mutating the wallet', () => {
    const shop = { ...initialPreviewShop(today), balance: 0 };
    expect(() => purchasePreviewItem(shop, 'hat:crown')).toThrow('more s’mores');
    expect(() => setPreviewBackground(shop, 'beach')).toThrow('Unlock');
    expect(() => setPreviewBackground(shop, 'snow')).toThrow('Unlock');
    expect(shop.balance).toBe(0);
    expect(shop.unlocked).toEqual([]);
    expect(setPreviewBackground(shop, 'forest').background).toBe('forest');
  });
  it('starts reset demos with colors and paid campsites locked, and snow costs the same as beach', () => {
    const fresh = restorePreviewShop(null, today);
    expect(fresh).toMatchObject({ balance: 0, unlocked: [], background: 'forest', askedToday: false });
    expect(SHOP_ITEMS.filter(item => item.kind === 'color').map(item => item.cost)).toEqual([5, 5, 5, 5, 5, 5]);
    const funded = { ...fresh, balance: 200 };
    expect(purchasePreviewItem(funded, 'background:snow').balance).toBe(purchasePreviewItem(funded, 'background:beach').balance);
    const snow = setPreviewBackground(purchasePreviewItem(funded, 'background:snow'), 'snow');
    expect(restorePreviewShop(JSON.stringify(snow), today)).toMatchObject({ balance: 170, background: 'snow', unlocked: ['background:snow'] });
    expect(() => setPreviewBackground(snow, 'beach')).toThrow('Unlock');
  });
  it('migrates an older wallet without granting currency or removing purchases', () => {
    expect(PREVIEW_SHOP_KEY).not.toBe(LEGACY_PREVIEW_SHOP_KEY);
    const legacy = { ...initialPreviewShop(today), balance: 62, unlocked: ['hat:crown', 'background:beach'], background: 'beach' };
    const upgraded = restorePreviewShop(null, today, JSON.stringify(legacy));
    expect(upgraded).toMatchObject({ balance: 62, unlocked: legacy.unlocked, background: 'beach' });
    const spent = purchasePreviewItem(upgraded, 'hat:wizard');
    expect(restorePreviewShop(JSON.stringify(spent), today, JSON.stringify(legacy)))
      .toMatchObject({ balance: 57, unlocked: ['hat:crown', 'background:beach', 'hat:wizard'] });
  });
  it.each([0, 62, 200])('preserves an existing balance of %s in current and legacy wallet formats', balance => {
    const saved = { ...initialPreviewShop(today), balance, unlocked: ['hat:crown'] };
    expect(restorePreviewShop(JSON.stringify(saved), today)).toMatchObject(saved);
    expect(restorePreviewShop(null, today, JSON.stringify(saved))).toMatchObject(saved);
  });
  it('does not replace corrupt cached data with a fresh wallet', () => {
    expect(() => restorePreviewShop('invalid', today)).toThrow();
    expect(() => restorePreviewShop(JSON.stringify({ ...initialPreviewShop(today), balance: -1 }), today)).toThrow();
    expect(() => restorePreviewShop(null, today, 'invalid')).toThrow();
    expect(restorePreviewShop(null, today).balance).toBe(0);
  });

  it.each(['Preview circle', 'Your demo circle', 'Our mountain camp'])(
    'migrates only generated circle labels and preserves saved purchases (%s)', name => {
      const saved = { ...initialPreviewShop(today), name, balance: 62,
        unlocked: ['hat:crown', 'background:beach'], background: 'beach' };
      const restored = restorePreviewShop(JSON.stringify(saved), today);
      expect(restored).toMatchObject({ ...saved, name: name === 'Our mountain camp' ? name : 'Your circle' });
    });
});

describe('isolated preview panic purchase', () => {
  const today = new Date(2026, 8, 17, 12);
  function exhaustedState() {
    let state = createPreviewAppState(today);
    for (const action of [{ type: 'toggle', app: 'Games' }, { type: 'minutes', minutes: 5 },
      { type: 'enable' }, { type: 'simulate' }] satisfies DemoAction[]) state = updatePreviewScreenTime(state, action);
    return state;
  }

  it.each([[0, 0], [1, 0], [3, 2]])('burns every camper and adds fifteen local minutes with an initial balance of %s', (balance, remainingBalance) => {
    const state = exhaustedState();
    const shop = { ...initialPreviewShop(today), balance };
    const next = pressPreviewPanicButton(state, shop);
    expect(next.shop).toMatchObject({ balance: remainingBalance, askedToday: true, eligibleToday: false });
    expect(next.state).toMatchObject({ burnt: true, askedToday: true, screenTime: { used: 5, approvedMinutes: 15 } });
    expect(demoLimitRemaining(next.state.screenTime)).toBe(15);
    const snapshot = previewAppSnapshot(next.state, next.shop, today);
    expect(snapshot.campfire.seats.every(seat => seat.askedToday)).toBe(true);
    expect(snapshot.circleShop?.balance).toBe(remainingBalance);
    expect(state).toMatchObject({ burnt: false, askedToday: false, screenTime: { approvedMinutes: 0 } });
    expect(shop).toMatchObject({ balance, askedToday: false });
  });

  it.each([[0, 0], [3, 2]])('rejects a repeated confirmation without another charge or extra time from balance %s', (balance, remainingBalance) => {
    const next = pressPreviewPanicButton(exhaustedState(), { ...initialPreviewShop(today), balance });
    expect(() => pressPreviewPanicButton(next.state, next.shop)).toThrow('remaining screen time');
    expect(next.shop.balance).toBe(remainingBalance);
    expect(next.state.screenTime.approvedMinutes).toBe(15);
  });

  it.each(['unconfigured', 'disabled', 'unselected', 'time-remaining', 'active-extra-time'] as const)(
    'does not spend or burn when %s at confirmation', scenario => {
      const eligible = exhaustedState();
      const state = scenario === 'unconfigured' ? createPreviewAppState(today)
        : { ...eligible, screenTime: { ...eligible.screenTime,
          ...(scenario === 'disabled' ? { enabled: false } : {}),
          ...(scenario === 'unselected' ? { apps: [] } : {}),
          ...(scenario === 'time-remaining' ? { used: 0 } : {}),
          ...(scenario === 'active-extra-time' ? { approvedMinutes: 15 } : {}),
        } };
      const shop = initialPreviewShop(today);
      const before = JSON.stringify({ state, shop });
      expect(() => pressPreviewPanicButton(state, shop)).toThrow();
      expect(JSON.stringify({ state, shop })).toBe(before);
    });

  it.each([-1, 0.5, Number.NaN, Infinity])('rejects invalid balance %s without adding time or burning campers', balance => {
    const state = exhaustedState();
    const shop = { ...initialPreviewShop(today), balance };
    expect(() => pressPreviewPanicButton(state, shop)).toThrow();
    expect(shop.balance).toBe(balance);
    expect(state).toMatchObject({ burnt: false, askedToday: false, screenTime: { approvedMinutes: 0 } });
  });

  it('does not spend when the demo cannot represent another fifteen minutes', () => {
    const eligible = exhaustedState();
    const state = { ...eligible, screenTime: { ...eligible.screenTime,
      approvedMinutes: Number.MAX_SAFE_INTEGER, used: Number.MAX_SAFE_INTEGER + 5 } };
    const shop = initialPreviewShop(today);
    expect(() => pressPreviewPanicButton(state, shop)).toThrow('Your s’more was not spent');
    expect(shop.balance).toBe(0);
    expect(state.burnt).toBe(false);
  });
});
