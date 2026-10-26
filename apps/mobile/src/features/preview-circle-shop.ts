import { canUseBackground, parseCircleShop, SHOP_ITEMS, type BackgroundId, type CircleShop, type ShopItemId } from '@/domain/circle-shop';
import { demoLimitReducer } from '@/domain/demo-screen-time';
import { PANIC_MINUTES, previewPanicButtonBlockReason } from '@/domain/panic-button';
import type { PreviewAppState } from '@/features/preview-app-state';

export const PREVIEW_SHOP_KEY = 'sumore:local-art-preview:circle-shop:v2';
export const LEGACY_PREVIEW_SHOP_KEY = 'sumore:local-art-preview:circle-shop:v1';

/** Migrate only former generated labels; never rewrite a user-chosen name. */
export function restoredCircleName(name: string): string {
  return /^(?:Preview circle|Your demo circle)$/.test(name) ? 'Your circle' : name;
}

/** Explicit artwork preview only. Production currency is never created here. */
export function initialPreviewShop(now = new Date()): CircleShop {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return {
    id: 'local-art-preview-circle', name: 'Your circle', balance: 0, unlocked: [], background: 'forest',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    localDate: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
    askedToday: false, eligibleToday: true, dayStartedAt: today.toISOString(), nextAwardAt: next.toISOString(), initializedAt: now.toISOString(),
  };
}

export function restorePreviewShop(raw: string | null, now = new Date(), legacyRaw: string | null = null): CircleShop {
  const today = initialPreviewShop(now);
  if (raw === null && legacyRaw === null) return today;
  const saved = parseCircleShop(JSON.parse(raw ?? legacyRaw!));
  if (!saved || saved.id !== today.id) throw new Error('The circle wallet could not be loaded.');
  // Preserve saved balances and purchases, including older wallet formats.
  // Reloads, migrations, and clock changes never refill a spent wallet.
  // A burnt day is carried across reloads, but only within the same local day.
  // Tomorrow recomputes clean, exactly as the server's day boundary does.
  const burntToday = saved.askedToday && saved.localDate === today.localDate;
  return { ...today, name: restoredCircleName(saved.name), balance: saved.balance,
    unlocked: saved.unlocked, background: saved.background, initializedAt: saved.initializedAt,
    askedToday: burntToday };
}

export function purchasePreviewItem(shop: CircleShop, itemId: ShopItemId): CircleShop {
  const item = SHOP_ITEMS.find(item => item.id === itemId);
  if (!item) throw new Error('Choose an item from the shop.');
  if (shop.unlocked.includes(itemId)) return shop;
  if (shop.balance < item.cost) throw new Error('Your circle needs more s’mores.');
  return { ...shop, balance: shop.balance - item.cost, unlocked: [...shop.unlocked, itemId] };
}

/** One local transition: spend, burn the circle, and credit simulated time. */
export function pressPreviewPanicButton(state: PreviewAppState, shop: CircleShop): { state: PreviewAppState; shop: CircleShop } {
  const blockReason = previewPanicButtonBlockReason(state.screenTime, shop.balance);
  if (blockReason) throw new Error(blockReason);
  const screenTime = demoLimitReducer(state.screenTime, { type: 'grant', minutes: PANIC_MINUTES });
  if (screenTime.approvedMinutes - state.screenTime.approvedMinutes !== PANIC_MINUTES) {
    throw new Error('The extra minutes could not be added. Your s’more was not spent.');
  }
  return {
    state: { ...state, burnt: true, askedToday: true, recentDecision: null, screenTime },
    shop: { ...shop, balance: Math.max(0, shop.balance - 1), askedToday: true, eligibleToday: false },
  };
}

export function setPreviewBackground(shop: CircleShop, background: BackgroundId): CircleShop {
  if (!canUseBackground(shop, background)) throw new Error('Unlock this background first.');
  return { ...shop, background };
}
