import { describe, expect, it, vi } from 'vitest';

import { characterStorageKey, characterSyncStorageKey, loadCharacterCache, parseCharacterCache, parseSharedCharacter, serializeCharacterCache } from './character';

describe('shared character metadata and offline cache', () => {
  it('round-trips shared and pending colors without accepting arbitrary fill values', () => {
    const appearance = { hat: 'cat', body: 'tall', color: 'pink' } as const;
    expect(parseSharedCharacter({ appearance, revision: 3 })).toEqual({ appearance, revision: 3 });
    const cache = { appearance, pending: true, baseRevision: 3 };
    expect(parseCharacterCache(serializeCharacterCache(cache))).toEqual(cache);
    const invalid = { ...appearance, color: 'url(secret)' };
    expect(parseSharedCharacter({ appearance: invalid, revision: 3 })).toBeUndefined();
    expect(() => parseCharacterCache(JSON.stringify({ version: 2, appearance: invalid, pending: true, baseRevision: 3 }))).toThrow('Invalid saved camper');
  });
  it('validates remote cosmetic IDs and revision without trusting burnt-state fields', () => {
    expect(parseSharedCharacter({ appearance: { hat: 'cat', body: 'tall', burnt: true }, revision: 2 }))
      .toEqual({ appearance: { hat: 'cat', body: 'tall' }, revision: 2 });
    expect(parseSharedCharacter({ appearance: null, revision: 0 })).toEqual({ appearance: null, revision: 0 });
    for (const input of [undefined, null, {}, { appearance: {}, revision: 0 }, { appearance: null, revision: -1 }, { appearance: null, revision: '1' }, { appearance: { hat: 'admin', body: 'tall' }, revision: 2 }]) {
      expect(parseSharedCharacter(input)).toBeUndefined();
    }
  });

  it('persists unsent edits with their base revision, not just a cosmetic preview', () => {
    const pending = { appearance: { hat: 'crown', body: 'short' } as const, pending: true, baseRevision: 4 };
    expect(parseCharacterCache(serializeCharacterCache(pending))).toEqual(pending);
    expect(parseCharacterCache('{"hat":"cow","body":"tall"}')).toEqual({ appearance: { hat: 'cow', body: 'tall' }, pending: false, baseRevision: null });
  });

  it('uses a separate v2 key so embedded older builds can keep reading v1', async () => {
    expect(characterSyncStorageKey('person')).not.toEqual(characterStorageKey('person'));
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('{"version":1,"appearance":{"hat":"halo","body":"short"}}');
    expect(await loadCharacterCache('person', read)).toEqual({ appearance: { hat: 'halo', body: 'short' }, pending: false, baseRevision: null });
    expect(read.mock.calls).toEqual([[characterSyncStorageKey('person')], [characterStorageKey('person')]]);
  });

  it('does not resurrect an old v1 look when a v2 cache is present', async () => {
    const cache = { appearance: { hat: 'cow', body: 'tall' } as const, pending: false, baseRevision: 3 };
    const read = vi.fn().mockResolvedValue(serializeCharacterCache(cache));
    expect(await loadCharacterCache('person', read)).toEqual(cache);
    expect(read).toHaveBeenCalledExactlyOnceWith(characterSyncStorageKey('person'));
  });

  it('keeps caches isolated between profiles and local artwork previews', () => {
    expect(new Set(['person-a', 'person-b', ''].map(characterSyncStorageKey)).size).toBe(3);
  });
});
