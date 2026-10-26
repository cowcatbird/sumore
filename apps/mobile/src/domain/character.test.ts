import { describe, expect, it } from 'vitest';

import {
  HATS,
  BODY_COLORS,
  characterStorageKey,
  characterSyncStorageKey,
  defaultAppearance,
  loadCharacterCache,
  normalizeAppearance,
  isCharacterAppearance,
  parseCharacterCache,
  parseSharedCharacter,
  sameAppearance,
  parseStoredAppearance,
  serializeAppearance,
  serializeCharacterCache,
} from './character';

const newHats = [
  { id: 'beanie', label: 'Beanie' },
  { id: 'bucket', label: 'Bucket' },
  { id: 'headband', label: 'Headband' },
  { id: 'propeller', label: 'Propeller' },
  { id: 'wizard', label: 'Wizard' },
  { id: 'pirate', label: 'Pirate' },
  { id: 'clown', label: 'Clown' },
  { id: 'viking', label: 'Viking' },
] as const;

const newAccessories = [
  { id: 'cat-ears', label: 'Cat ears' },
  { id: 'sunflower', label: 'Sunflower' },
  { id: 'lollipop', label: 'Lollipop' },
  { id: 'bubble-gum', label: 'Bubble gum' },
  { id: 'googly-eyes', label: 'Googly eyes' },
  { id: 'disguise-glasses', label: 'Disguise glasses' },
] as const;

describe('character appearance', () => {
  it('starts with an unadorned short camper without request-derived status', () => {
    expect(defaultAppearance).toEqual({ hat: 'none', body: 'short' });
  });

  it('preserves the existing headwear order and appends the six new accessories', () => {
    expect(HATS.slice(0, 9)).toEqual([
      { id: 'none', label: 'None' },
      { id: 'cowboy', label: 'Cowboy' },
      { id: 'cow', label: 'Cow' },
      { id: 'cat', label: 'Cat' },
      { id: 'sunglasses', label: 'Sunglasses' },
      { id: 'duck', label: 'Duck' },
      { id: 'top-hat', label: 'Top hat' },
      { id: 'halo', label: 'Halo' },
      { id: 'crown', label: 'Crown' },
    ]);
    expect(HATS.slice(9, 17)).toEqual(newHats);
    expect(HATS.slice(17)).toEqual(newAccessories);
    expect(HATS).toHaveLength(23);
    expect(new Set(HATS.map(({ id }) => id)).size).toBe(23);
    for (const { id } of HATS) expect(normalizeAppearance({ hat: id }).hat).toBe(id);
  });

  it.each(HATS)('round-trips $label with both bodies and every supported color', ({ id: hat }) => {
    for (const body of ['short', 'tall'] as const) {
      for (const color of [undefined, ...BODY_COLORS.map(({ id }) => id)]) {
        const appearance = { hat, body, ...(color === undefined ? {} : { color }) };
        const normalized = { hat, body, ...(color === undefined || color === 'cream' ? {} : { color }) };
        expect(isCharacterAppearance(appearance)).toBe(true);
        expect(normalizeAppearance(appearance)).toEqual(normalized);
        expect(normalizeAppearance(normalized)).toEqual(normalized);
        expect(sameAppearance(appearance, normalized)).toBe(true);
        expect(parseStoredAppearance(JSON.stringify(appearance))).toEqual(normalized);
        expect(parseStoredAppearance(serializeAppearance(appearance))).toEqual(normalized);
        expect(parseSharedCharacter(JSON.parse(JSON.stringify({ appearance, revision: 42 })))).toEqual({
          appearance: normalized, revision: 42,
        });
        for (const pending of [false, true]) {
          for (const baseRevision of [null, 0, 42, Number.MAX_SAFE_INTEGER]) {
            const cache = { appearance, pending, baseRevision };
            expect(parseCharacterCache(serializeCharacterCache(cache))).toEqual({
              appearance: normalized, pending, baseRevision,
            });
          }
        }
      }
    }
  });

  it.each([...newHats, ...newAccessories])('loads $label from current cache or legacy profile storage without losing sync state', async ({ id: hat }) => {
    const appearance = { hat, body: 'tall', color: 'pink' } as const;
    const profileId = `camper-${hat}`;
    const v2Key = characterSyncStorageKey(profileId);
    const v1Key = characterStorageKey(profileId);
    const current = { appearance, pending: true, baseRevision: 7 };
    const reads: string[] = [];
    expect(await loadCharacterCache(profileId, async key => {
      reads.push(key);
      return key === v2Key ? serializeCharacterCache(current) : serializeAppearance(defaultAppearance);
    })).toEqual(current);
    expect(reads).toEqual([v2Key]);

    for (const legacy of [JSON.stringify(appearance), serializeAppearance(appearance)]) {
      reads.length = 0;
      expect(await loadCharacterCache(profileId, async key => {
        reads.push(key);
        return key === v1Key ? legacy : null;
      })).toEqual({ appearance, pending: false, baseRevision: null });
      expect(reads).toEqual([v2Key, v1Key]);
    }
  });

  it('rejects unknown hats from shared and pending state while defaulting only the invalid local field', () => {
    for (const hat of ['unknown-hat', 'Beanie', 'bucket ', 'wizard-hat', '__proto__', 'constructor', '', null, 1, [], {}]) {
      const appearance = { hat, body: 'tall', color: 'blue' };
      const normalized = { hat: 'none', body: 'tall', color: 'blue' };
      expect(isCharacterAppearance(appearance)).toBe(false);
      expect(normalizeAppearance(appearance)).toEqual(normalized);
      expect(parseStoredAppearance(JSON.stringify(appearance))).toEqual(normalized);
      expect(parseSharedCharacter({ appearance, revision: 2 })).toBeUndefined();
      expect(() => parseCharacterCache(JSON.stringify({
        version: 2, appearance, pending: true, baseRevision: 1,
      }))).toThrow('Invalid saved camper.');
    }
  });

  it('preserves all valid cosmetic selections', () => {
    expect(normalizeAppearance({ hat: 'cat', body: 'tall' })).toEqual({
      hat: 'cat', body: 'tall',
    });
  });

  it('keeps old campers cream and lists all six painted body colors in rainbow order', () => {
    expect(BODY_COLORS.map(({ id, hex }) => [id, hex])).toEqual([
      ['cream', '#FFF9ED'], ['red', '#FF6464'], ['orange', '#F3DBB5'], ['yellow', '#F8FF8F'],
      ['green', '#C3F4D0'], ['blue', '#A9DBFF'], ['pink', '#F4C3E1'],
    ]);
    expect(normalizeAppearance({ ...defaultAppearance, color: 'cream' })).toEqual(defaultAppearance);
    for (const color of BODY_COLORS.map(({ id }) => id).filter(id => id !== 'cream')) {
      const look = { hat: 'cow', body: 'tall', color } as const;
      expect(normalizeAppearance(look)).toEqual(look);
      expect(parseStoredAppearance(serializeAppearance(look))).toEqual(look);
    }
  });

  it('rejects unsupported shared colors but safely normalizes old local preferences', () => {
    for (const color of ['purple', 'Red', 'green ', 'color:red', '#123456', '__proto__', null, 1, [], {}]) {
      expect(isCharacterAppearance({ ...defaultAppearance, color })).toBe(false);
      expect(normalizeAppearance({ ...defaultAppearance, color })).toEqual(defaultAppearance);
    }
    expect(isCharacterAppearance(defaultAppearance)).toBe(true);
    expect(isCharacterAppearance({ ...defaultAppearance, color: 'cream' })).toBe(true);
  });

  it('includes colors in synchronization equality while treating omitted cream as equivalent', () => {
    expect(sameAppearance(defaultAppearance, { ...defaultAppearance, color: 'cream' })).toBe(true);
    expect(sameAppearance(defaultAppearance, { ...defaultAppearance, color: 'blue' })).toBe(false);
    expect(sameAppearance({ ...defaultAppearance, color: 'blue' }, { ...defaultAppearance, color: 'pink' })).toBe(false);
    expect(sameAppearance({ ...defaultAppearance, color: 'pink' }, { ...defaultAppearance, color: 'pink' })).toBe(true);
    expect(sameAppearance(null, defaultAppearance)).toBe(false);
  });

  it('defaults missing values independently without discarding valid choices', () => {
    expect(normalizeAppearance({ hat: 'cow', body: 'giant', marshmallow: null })).toEqual({
      ...defaultAppearance, hat: 'cow',
    });
  });

  it('rejects arrays, strings, null, and unsupported hat ids', () => {
    for (const value of [undefined, null, [], 'cow', 42, { hat: '__proto__' }]) {
      expect(normalizeAppearance(value)).toEqual(defaultAppearance);
    }
  });

  it('does not retain unknown fields or mutate input', () => {
    const original = { hat: 'crown', body: 'tall', secret: 'unused' };
    expect(normalizeAppearance(original)).toEqual({ hat: 'crown', body: 'tall' });
    expect(original).toEqual({ hat: 'crown', body: 'tall', secret: 'unused' });
  });

  it('migrates the initial unversioned preference format', () => {
    expect(parseStoredAppearance('{"hat":"halo","body":"tall"}')).toEqual({
      hat: 'halo', body: 'tall',
    });
  });

  it('ignores old plain and burnt selections in both saved formats', () => {
    for (const marshmallow of ['plain', 'burnt']) {
      const legacyAppearance = { hat: 'cowboy', body: 'short', marshmallow };
      const expected = { hat: 'cowboy', body: 'short' };
      expect(parseStoredAppearance(JSON.stringify(legacyAppearance))).toEqual(expected);
      expect(parseStoredAppearance(JSON.stringify({ version: 1, appearance: legacyAppearance }))).toEqual(expected);
    }
  });

  it('never persists request-derived status, even when supplied by legacy callers', () => {
    const legacyAppearance = { hat: 'cat', body: 'tall', marshmallow: 'burnt', askedToday: true, burnt: true } as const;
    expect(normalizeAppearance(legacyAppearance)).toEqual({ hat: 'cat', body: 'tall' });
    expect(JSON.parse(serializeAppearance(legacyAppearance))).toEqual({
      version: 1,
      appearance: { hat: 'cat', body: 'tall' },
    });
  });

  it('round-trips versioned preferences', () => {
    const appearance = { hat: 'top-hat', body: 'tall' } as const;
    expect(parseStoredAppearance(serializeAppearance(appearance))).toEqual(appearance);
  });

  it('fails visibly for malformed storage or unsupported versions', () => {
    for (const raw of ['broken json', 'null', '[]', '42', '"cow"', '{"version":2,"appearance":{}}', '{"version":1}', '{"version":1,"appearance":null}', '{"version":1,"appearance":[]}', '{"version":"1","appearance":{}}']) {
      expect(() => parseStoredAppearance(raw)).toThrow();
    }
  });

  it('defaults malformed individual fields in otherwise valid saved preferences', () => {
    expect(parseStoredAppearance('{"version":1,"appearance":{"hat":[],"body":{},"marshmallow":"burnt"}}')).toEqual(defaultAppearance);
    expect(parseStoredAppearance('{"version":1,"appearance":{"hat":"duck","body":null}}')).toEqual({
      hat: 'duck', body: 'short',
    });
  });

  it('keeps preview and different profiles in separate storage slots', () => {
    expect(characterStorageKey('')).toBe(characterStorageKey('local-preview'));
    expect(characterStorageKey('alice')).not.toBe(characterStorageKey('bob'));
    expect(characterStorageKey('alice')).not.toBe(characterStorageKey(''));
  });
});
