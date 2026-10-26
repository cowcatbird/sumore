import { HATS, type BodyColorId, type CharacterAppearance, type HatId } from './character';

export type BackgroundId = 'forest' | 'beach' | 'snow';
export type ShopItemId = 'hat:crown' | 'hat:wizard' | 'hat:pirate' | 'hat:clown' | 'hat:viking'
  | 'hat:cat-ears' | 'hat:bubble-gum' | 'hat:googly-eyes' | 'hat:disguise-glasses'
  | `color:${Exclude<BodyColorId, 'cream'>}` | `background:${Exclude<BackgroundId, 'forest'>}`;

export type ShopItem = {
  id: ShopItemId;
  label: string;
  cost: number;
  kind: 'hat' | 'color' | 'background';
};

/** Display catalog only. Prices, balances and unlocks are enforced by the server. */
export const SHOP_ITEMS: readonly ShopItem[] = [
  { id: 'hat:crown', label: 'Crown', cost: 10, kind: 'hat' },
  { id: 'hat:wizard', label: 'Wizard', cost: 5, kind: 'hat' },
  { id: 'hat:pirate', label: 'Pirate', cost: 5, kind: 'hat' },
  { id: 'hat:clown', label: 'Clown', cost: 5, kind: 'hat' },
  { id: 'hat:viking', label: 'Viking', cost: 5, kind: 'hat' },
  { id: 'hat:cat-ears', label: 'Cat ears', cost: 5, kind: 'hat' },
  { id: 'hat:bubble-gum', label: 'Bubble gum', cost: 5, kind: 'hat' },
  { id: 'hat:googly-eyes', label: 'Googly eyes', cost: 5, kind: 'hat' },
  { id: 'hat:disguise-glasses', label: 'Disguise glasses', cost: 5, kind: 'hat' },
  { id: 'color:red', label: 'Soft red', cost: 5, kind: 'color' },
  { id: 'color:orange', label: 'Soft orange', cost: 5, kind: 'color' },
  { id: 'color:yellow', label: 'Soft yellow', cost: 5, kind: 'color' },
  { id: 'color:green', label: 'Soft green', cost: 5, kind: 'color' },
  { id: 'color:blue', label: 'Soft blue', cost: 5, kind: 'color' },
  { id: 'color:pink', label: 'Soft pink', cost: 5, kind: 'color' },
  { id: 'background:beach', label: 'Beach', cost: 30, kind: 'background' },
  { id: 'background:snow', label: 'Snow', cost: 30, kind: 'background' },
];

/** A missing listing means the hat is free, not that it needs a purchase. */
export function hatShopItem(hat: HatId): ShopItem | undefined {
  return SHOP_ITEMS.find(item => item.kind === 'hat' && item.id === `hat:${hat}`);
}

/** A server snapshot of one group's shared wallet, not a sum of personal wallets. */
export type CircleShop = {
  id: string;
  name: string;
  balance: number;
  unlocked: ShopItemId[];
  background: BackgroundId;
  localDate: string;
  timeZone: string;
  askedToday: boolean;
  eligibleToday: boolean;
  dayStartedAt: string;
  nextAwardAt: string;
  initializedAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isShopItemId(value: unknown): value is ShopItemId {
  return SHOP_ITEMS.some(({ id }) => id === value);
}

export function isBackgroundId(value: unknown): value is BackgroundId {
  return value === 'forest' || value === 'beach' || value === 'snow';
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    && isLocalDate(value.slice(0, 10))
    && Number.isFinite(Date.parse(value));
}

function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const midnight = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().slice(0, 10) === value;
}

/** Invalid or unsupported snapshots stay unavailable; never invent a local balance. */
export function parseCircleShop(value: unknown): CircleShop | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.name !== 'string' || !value.name.trim()
    || !Number.isSafeInteger(value.balance) || Number(value.balance) < 0
    || !Array.isArray(value.unlocked) || !value.unlocked.every(isShopItemId)
    || !isBackgroundId(value.background)
    || !isLocalDate(value.localDate)
    || typeof value.timeZone !== 'string' || !value.timeZone.trim()
    || typeof value.askedToday !== 'boolean'
    || typeof value.eligibleToday !== 'boolean'
    || !isTimestamp(value.dayStartedAt)
    || !isTimestamp(value.nextAwardAt)
    || (value.initializedAt !== undefined && !isTimestamp(value.initializedAt))) return undefined;
  if (value.background !== 'forest' && !value.unlocked.includes(`background:${value.background}`)) return undefined;
  if (Date.parse(value.nextAwardAt) <= Date.parse(value.dayStartedAt)) return undefined;
  return {
    id: value.id,
    name: value.name,
    balance: Number(value.balance),
    unlocked: [...new Set(value.unlocked as ShopItemId[])],
    background: value.background,
    localDate: value.localDate,
    timeZone: value.timeZone,
    askedToday: value.askedToday,
    eligibleToday: value.eligibleToday,
    dayStartedAt: value.dayStartedAt,
    nextAwardAt: value.nextAwardAt,
    ...(value.initializedAt === undefined ? {} : { initializedAt: value.initializedAt }),
  };
}

export function hasShopUnlock(shop: CircleShop | null | undefined, item: ShopItemId) {
  return shop?.unlocked.includes(item) ?? false;
}

/** Available hats first, then locked hats cheapest-first. Preserve catalog
 * order within ties, without rearranging the shared catalog itself. */
export function orderedHats(shop: CircleShop | null | undefined) {
  return HATS.map((hat, index) => {
    const item = hatShopItem(hat.id);
    const locked = !!item && !hasShopUnlock(shop, item.id);
    return { hat, index, locked, cost: locked ? item.cost : 0 };
  }).sort((a, b) => Number(a.locked) - Number(b.locked) || a.cost - b.cost || a.index - b.index)
    .map(({ hat }) => hat);
}

/** Button state only. A purchase RPC must recheck membership, price and funds. */
export function canPurchaseShopItem(shop: CircleShop | null | undefined, item: ShopItemId) {
  const listing = SHOP_ITEMS.find(({ id }) => id === item);
  return !!shop && !!listing && !hasShopUnlock(shop, item) && shop.balance >= listing.cost;
}

/** Selection UI only. The server independently checks a saved look's unlocks. */
export function canUseAppearance(shop: CircleShop | null | undefined, appearance: CharacterAppearance) {
  const hatItem = hatShopItem(appearance.hat);
  if (hatItem && !hasShopUnlock(shop, hatItem.id)) return false;
  if (appearance.color && appearance.color !== 'cream' && !hasShopUnlock(shop, `color:${appearance.color}`)) return false;
  return true;
}

/** Hide stale paid selections when changing circles or awaiting shared unlocks.
 * This is presentation only; it never rewrites cached preferences or a wallet. */
export function unlockedAppearance(shop: CircleShop | null | undefined, appearance: CharacterAppearance): CharacterAppearance {
  const hatItem = hatShopItem(appearance.hat);
  return {
    ...appearance,
    ...(hatItem && !hasShopUnlock(shop, hatItem.id) ? { hat: 'none' as const } : {}),
    ...(appearance.color && appearance.color !== 'cream' && !hasShopUnlock(shop, `color:${appearance.color}`)
      ? { color: 'cream' as const } : {}),
  };
}

export function canUseBackground(shop: CircleShop | null | undefined, background: BackgroundId) {
  return background === 'forest' || hasShopUnlock(shop, `background:${background}`);
}
