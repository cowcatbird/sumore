export type HatId = 'none' | 'cowboy' | 'cow' | 'cat' | 'sunglasses' | 'duck' | 'top-hat' | 'halo' | 'crown'
  | 'beanie' | 'bucket' | 'headband' | 'propeller' | 'wizard' | 'pirate' | 'clown' | 'viking'
  | 'cat-ears' | 'sunflower' | 'lollipop' | 'bubble-gum' | 'googly-eyes' | 'disguise-glasses';
export type BodyColorId = 'cream' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'pink';

export type CharacterAppearance = {
  hat: HatId;
  body: 'short' | 'tall';
  /** Omitted by older clients; absence is the original cream camper. */
  color?: BodyColorId;
};

export type SharedCharacter = {
  appearance: CharacterAppearance | null;
  revision: number;
};

export type CharacterCache = {
  appearance: CharacterAppearance;
  pending: boolean;
  baseRevision: number | null;
};

export const HATS: readonly { id: HatId; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'cowboy', label: 'Cowboy' },
  { id: 'cow', label: 'Cow' },
  { id: 'cat', label: 'Cat' },
  { id: 'sunglasses', label: 'Sunglasses' },
  { id: 'duck', label: 'Duck' },
  { id: 'top-hat', label: 'Top hat' },
  { id: 'halo', label: 'Halo' },
  { id: 'crown', label: 'Crown' },
  { id: 'beanie', label: 'Beanie' },
  { id: 'bucket', label: 'Bucket' },
  { id: 'headband', label: 'Headband' },
  { id: 'propeller', label: 'Propeller' },
  { id: 'wizard', label: 'Wizard' },
  { id: 'pirate', label: 'Pirate' },
  { id: 'clown', label: 'Clown' },
  { id: 'viking', label: 'Viking' },
  { id: 'cat-ears', label: 'Cat ears' },
  { id: 'sunflower', label: 'Sunflower' },
  { id: 'lollipop', label: 'Lollipop' },
  { id: 'bubble-gum', label: 'Bubble gum' },
  { id: 'googly-eyes', label: 'Googly eyes' },
  { id: 'disguise-glasses', label: 'Disguise glasses' },
];

export const BODY_COLORS: readonly { id: BodyColorId; label: string; hex: string }[] = [
  { id: 'cream', label: 'Cream', hex: '#FFF9ED' },
  { id: 'red', label: 'Soft red', hex: '#FF6464' },
  { id: 'orange', label: 'Soft orange', hex: '#F3DBB5' },
  { id: 'yellow', label: 'Soft yellow', hex: '#F8FF8F' },
  { id: 'green', label: 'Soft green', hex: '#C3F4D0' },
  { id: 'blue', label: 'Soft blue', hex: '#A9DBFF' },
  { id: 'pink', label: 'Soft pink', hex: '#F4C3E1' },
];

export const defaultAppearance: Readonly<CharacterAppearance> = {
  hat: 'none',
  body: 'short',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Stored preferences are untrusted: preserve supported cosmetics, default the
 * rest. A marshmallow's state comes from today's requests, never this storage.
 * In particular, ignore the marshmallow choice in the early artwork preview.
 */
export function normalizeAppearance(value: unknown): CharacterAppearance {
  const source = isRecord(value) ? value : {};
  const color = BODY_COLORS.find(({ id }) => id === source.color)?.id;
  return {
    hat: HATS.some(({ id }) => id === source.hat) ? (source.hat as HatId) : defaultAppearance.hat,
    body: source.body === 'tall' ? 'tall' : 'short',
    // Keep the original object shape for cream, including old embedded builds.
    ...(color && color !== 'cream' ? { color } : {}),
  };
}

export function isCharacterAppearance(value: unknown): value is CharacterAppearance {
  return isRecord(value)
    && HATS.some(({ id }) => id === value.hat)
    && (value.body === 'short' || value.body === 'tall')
    && (value.color === undefined || BODY_COLORS.some(({ id }) => id === value.color));
}

export function sameAppearance(left: CharacterAppearance | null | undefined, right: CharacterAppearance | null | undefined) {
  return left?.hat === right?.hat && left?.body === right?.body
    && (left?.color ?? 'cream') === (right?.color ?? 'cream');
}

/** Undefined means this server does not support shared cosmetics yet. */
export function parseSharedCharacter(value: unknown): SharedCharacter | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return undefined;
  if (value.appearance !== null && !isCharacterAppearance(value.appearance)) return undefined;
  return {
    appearance: value.appearance === null ? null : normalizeAppearance(value.appearance),
    revision: Number(value.revision),
  };
}

export function parseCharacterCache(raw: string): CharacterCache {
  const value: unknown = JSON.parse(raw);
  if (isRecord(value) && value.version === 2) {
    if (!isCharacterAppearance(value.appearance) || typeof value.pending !== 'boolean'
      || (value.baseRevision !== null && (!Number.isSafeInteger(value.baseRevision) || Number(value.baseRevision) < 0))) {
      throw new Error('Invalid saved camper.');
    }
    return { appearance: normalizeAppearance(value.appearance), pending: value.pending, baseRevision: value.baseRevision as number | null };
  }
  return { appearance: parseStoredAppearance(raw), pending: false, baseRevision: null };
}

export function serializeCharacterCache(cache: CharacterCache) {
  return JSON.stringify({ version: 2, ...cache, appearance: normalizeAppearance(cache.appearance) });
}

/** Also reads the original, unversioned preference object. */
export function parseStoredAppearance(raw: string): CharacterAppearance {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('Invalid saved camper.');
  if ('version' in value) {
    if (value.version !== 1 || !isRecord(value.appearance)) {
      throw new Error('Unsupported saved camper version.');
    }
    return normalizeAppearance(value.appearance);
  }
  return normalizeAppearance(value);
}

export function serializeAppearance(appearance: CharacterAppearance): string {
  return JSON.stringify({ version: 1, appearance: normalizeAppearance(appearance) });
}

export function characterStorageKey(profileId: string): string {
  return `sumore:character:v1:${profileId || 'local-preview'}`;
}

export function characterSyncStorageKey(profileId: string): string {
  return `sumore:character:v2:${profileId || 'local-preview'}`;
}

/** Keep v1 untouched so an older embedded app can still read its old look. */
export async function loadCharacterCache(profileId: string, read: (key: string) => Promise<string | null>) {
  const current = await read(characterSyncStorageKey(profileId));
  const raw = current ?? await read(characterStorageKey(profileId));
  return raw === null ? null : parseCharacterCache(raw);
}
