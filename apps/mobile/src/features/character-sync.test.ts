import { describe, expect, it, vi } from 'vitest';

import { BODY_COLORS, type CharacterAppearance, type CharacterCache, type SharedCharacter } from '@/domain/character';
import { createCharacterSync } from './character-sync';

const cat: CharacterAppearance = { hat: 'cat', body: 'short' };
const cow: CharacterAppearance = { hat: 'cow', body: 'tall' };
const shared = (appearance: CharacterAppearance | null, revision = 0): SharedCharacter => ({ appearance, revision });
const local = (appearance: CharacterAppearance, pending = false, baseRevision: number | null = null): CharacterCache => ({ appearance, pending, baseRevision });
function setup(initial = shared(null), sharedMode = true) {
  const writeCache = vi.fn<(cache: CharacterCache) => Promise<void>>().mockResolvedValue(undefined);
  const save = vi.fn<(appearance: CharacterAppearance, revision: number) => Promise<SharedCharacter>>()
    .mockImplementation(async (appearance, revision) => shared(appearance, revision + 1));
  const onState = vi.fn();
  const reconcile = vi.fn().mockResolvedValue(undefined);
  const sync = createCharacterSync({ sharedMode, writeCache, save, onState, reconcile });
  sync.receive(initial);
  return { sync, save, writeCache, onState, reconcile };
}

describe('shared character synchronization', () => {
  it.each(BODY_COLORS.filter(({ id }) => id !== 'cream'))('publishes, caches and receives a $label color-only change', async ({ id: color }) => {
    const { sync, save, writeCache } = setup(shared(cat, 5));
    await sync.hydrate(null);
    sync.setAppearance({ color });
    await vi.waitFor(() => expect(sync.getState().status).toBe('saved'));
    expect(save).toHaveBeenCalledExactlyOnceWith({ ...cat, color }, 5);
    expect(writeCache).toHaveBeenLastCalledWith(local({ ...cat, color }, false, 6));
    sync.receive(shared(cat, 7));
    expect(sync.getState().appearance).toEqual(cat);
    sync.receive(shared({ ...cat, color }, 8));
    expect(sync.getState().appearance).toEqual({ ...cat, color });
    sync.setAppearance({ color: 'cream' });
    await vi.waitFor(() => expect(sync.getState().status).toBe('saved'));
    expect(save).toHaveBeenLastCalledWith(cat, 8);
  });
  it('gently imports a legacy local look only into revision-zero unset server state', async () => {
    const { sync, save, writeCache } = setup();
    await sync.hydrate(local(cat));
    expect(save).toHaveBeenCalledExactlyOnceWith(cat, 0);
    expect(sync.getState()).toMatchObject({ appearance: cat, shared: true, status: 'saved' });
    expect(writeCache).toHaveBeenLastCalledWith(local(cat, false, 1));
  });

  it('does not overwrite an existing remote look with an older ordinary cache', async () => {
    const { sync, save } = setup(shared(cow, 4));
    await sync.hydrate(local(cat));
    expect(sync.getState()).toMatchObject({ appearance: cow, shared: true });
    expect(save).not.toHaveBeenCalled();
  });

  it('shows rapid edits immediately and serializes saves with the acknowledged revision', async () => {
    const { sync, save } = setup();
    const first = Promise.withResolvers<SharedCharacter>();
    save.mockReturnValueOnce(first.promise);
    await sync.hydrate(null);
    sync.setAppearance(cat);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    sync.setAppearance({ body: 'tall' });
    sync.setAppearance({ hat: 'crown' });
    const latest: CharacterAppearance = { hat: 'crown', body: 'tall' };
    expect(sync.getState().appearance).toEqual(latest);
    first.resolve(shared(cat, 1));
    await vi.waitFor(() => expect(sync.getState().status).toBe('saved'));
    expect(save.mock.calls).toEqual([[cat, 0], [latest, 1]]);
    expect(sync.getState()).toMatchObject({ appearance: latest, shared: true });
  });

  it('ignores old polling results after a newer saved character', async () => {
    const { sync } = setup(shared(cat, 5));
    await sync.hydrate(null);
    sync.receive(shared(cow, 4));
    expect(sync.getState().appearance).toEqual(cat);
  });

  it('applies a newer remote look that arrived during the final cache write', async () => {
    const { sync, writeCache } = setup();
    const finalCache = Promise.withResolvers<void>();
    writeCache.mockResolvedValueOnce(undefined).mockReturnValueOnce(finalCache.promise);
    await sync.hydrate(null);
    sync.setAppearance(cat);
    await vi.waitFor(() => expect(writeCache).toHaveBeenCalledTimes(2));
    sync.receive(shared(cow, 2));
    finalCache.resolve();
    await vi.waitFor(() => expect(sync.getState()).toMatchObject({ appearance: cow, shared: true, status: 'saved' }));
  });

  it('recognizes a committed save even if polling saw it before the response timed out', async () => {
    const { sync, save } = setup();
    const request = Promise.withResolvers<SharedCharacter>();
    save.mockReturnValueOnce(request.promise);
    await sync.hydrate(null);
    sync.setAppearance(cat);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    sync.receive(shared(cat, 1));
    request.reject(new Error('Connection timed out'));
    await vi.waitFor(() => expect(sync.getState()).toMatchObject({ appearance: cat, shared: true, status: 'saved', error: null }));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('never upgrades a legacy import to a newer revision while cache persistence is pending', async () => {
    const { sync, save, writeCache } = setup();
    const caching = Promise.withResolvers<void>();
    writeCache.mockReturnValueOnce(caching.promise);
    save.mockRejectedValueOnce(new Error('Revision conflict'));
    const importing = sync.hydrate(local(cat));
    sync.receive(shared(cow, 1));
    caching.resolve();
    await importing;
    expect(save).toHaveBeenCalledExactlyOnceWith(cat, 0);
    expect(sync.getState()).toMatchObject({ appearance: cow, shared: true, status: 'saved' });
  });

  it('restores pending offline edits when their base revision still matches', async () => {
    const { sync, save } = setup(shared(cow, 3));
    await sync.hydrate(local(cat, true, 3));
    expect(save).toHaveBeenCalledExactlyOnceWith(cat, 3);
    expect(sync.getState()).toMatchObject({ appearance: cat, shared: true, status: 'saved' });
  });

  it('requires explicit retry before overwriting a conflicting remote edit', async () => {
    const { sync, save, reconcile } = setup(shared(cow, 5));
    await sync.hydrate(local(cat, true, 2));
    expect(save).not.toHaveBeenCalled();
    expect(sync.getState()).toMatchObject({ appearance: cat, shared: false, status: 'error' });
    await sync.retry();
    expect(reconcile).toHaveBeenCalled();
    expect(save).toHaveBeenCalledExactlyOnceWith(cat, 5);
    expect(sync.getState().shared).toBe(true);
  });

  it('does not claim local artwork previews are shared or send remote requests', async () => {
    const { sync, save } = setup(shared(null), false);
    await sync.hydrate(local(cat));
    sync.setAppearance(cow);
    await vi.waitFor(() => expect(sync.getState().status).toBe('saved'));
    expect(sync.getState().shared).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('stops queued saves and UI callbacks when the profile session is replaced', async () => {
    const { sync, save, writeCache, onState } = setup();
    const caching = Promise.withResolvers<void>();
    writeCache.mockReturnValue(caching.promise);
    await sync.hydrate(null);
    sync.setAppearance(cat);
    sync.stop();
    const notifications = onState.mock.calls.length;
    caching.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(save).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledTimes(notifications);
  });

  it('keeps an offline-copy warning when the remote save succeeded but caching failed', async () => {
    const { sync, writeCache } = setup();
    writeCache.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Storage full'));
    await sync.hydrate(null);
    sync.setAppearance(cat);
    await vi.waitFor(() => expect(sync.getState().status).toBe('error'));
    expect(sync.getState()).toMatchObject({ appearance: cat, shared: true });
    expect(sync.getState().error).toContain('offline copy');
    sync.receive(shared(cat, 1));
    expect(sync.getState().status).toBe('error');
  });
});
