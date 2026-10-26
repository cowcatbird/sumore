import { describe, expect, it, vi } from 'vitest';

import { BODY_COLORS, type CharacterAppearance, type SharedCharacter } from '@/domain/character';
import type { CircleShop } from '@/domain/circle-shop';
import { applyCharacterSelection } from './character-selection';
import { createCharacterSync } from './character-sync';

const emptyShop: CircleShop = {
  id: 'test-circle', name: 'Our circle', balance: 200, unlocked: [], background: 'forest',
  localDate: '2026-09-18', timeZone: 'UTC', askedToday: false, eligibleToday: true,
  dayStartedAt: '2026-09-18T00:00:00Z', nextAwardAt: '2026-09-19T00:00:00Z',
};

async function editor(appearance: CharacterAppearance) {
  const save = vi.fn<(appearance: CharacterAppearance, revision: number) => Promise<SharedCharacter>>()
    .mockImplementation(async (appearance, revision) => ({ appearance, revision: revision + 1 }));
  const sync = createCharacterSync({
    sharedMode: true, writeCache: async () => undefined, save,
    onState: () => undefined, reconcile: async () => undefined,
  });
  sync.receive({ appearance, revision: 1 });
  await sync.hydrate(null);
  return { sync, save };
}

describe('applying character selections after a purchase', () => {
  it('preserves newer body and color snapshots when a retained hat callback completes', async () => {
    const { sync, save } = await editor({ hat: 'cat', body: 'short' });
    let shop = emptyShop;
    const finishPurchase = () => applyCharacterSelection(sync, shop, { hat: 'wizard' });

    // Both the character and group unlocks changed while the purchase awaited.
    sync.receive({ appearance: { hat: 'cow', body: 'tall', color: 'pink' }, revision: 5 });
    shop = { ...emptyShop, unlocked: ['color:pink', 'hat:wizard'] };
    finishPurchase();

    const expected: CharacterAppearance = { hat: 'wizard', body: 'tall', color: 'pink' };
    expect(sync.getState().appearance).toEqual(expected);
    await vi.waitFor(() => expect(sync.getState().status).toBe('saved'));
    expect(save).toHaveBeenCalledExactlyOnceWith(expected, 5);
  });

  it.each(['crown', 'wizard', 'pirate', 'clown', 'viking', 'cat-ears', 'bubble-gum', 'googly-eyes', 'disguise-glasses'] as const)(
    'does not reject newly bought %s before the unlock snapshot renders', async hat => {
      const { sync, save } = await editor({ hat: 'cow', body: 'tall', color: 'blue' });
      const previousShop: CircleShop = { ...emptyShop, unlocked: ['color:blue'] };

      applyCharacterSelection(sync, previousShop, { hat });

      const expected = { hat, body: 'tall', color: 'blue' };
      expect(sync.getState().appearance).toEqual(expected);
      await vi.waitFor(() => expect(sync.getState().status).toBe('saved'));
      expect(save).toHaveBeenCalledExactlyOnceWith(expected, 1);
    },
  );

  it.each(BODY_COLORS.filter(({ id }) => id !== 'cream'))('preserves a newer hat when a completed $label purchase changes only color', async ({ id: color }) => {
    const { sync, save } = await editor({ hat: 'cat', body: 'short' });
    const finishPurchase = () => applyCharacterSelection(sync, emptyShop, { color });
    sync.receive({ appearance: { hat: 'beanie', body: 'tall' }, revision: 4 });

    finishPurchase();

    const expected = { hat: 'beanie', body: 'tall', color };
    expect(sync.getState().appearance).toEqual(expected);
    await vi.waitFor(() => expect(sync.getState().status).toBe('saved'));
    expect(save).toHaveBeenCalledExactlyOnceWith(expected, 4);
  });

  it('sanitizes old locked cosmetics without rejecting the newly bought patch', async () => {
    const { sync } = await editor({ hat: 'crown', body: 'tall', color: 'pink' });
    applyCharacterSelection(sync, emptyShop, { hat: 'pirate' });
    expect(sync.getState().appearance).toEqual({ hat: 'pirate', body: 'tall' });
    await vi.waitFor(() => expect(sync.getState().status).toBe('saved'));
  });

  it('reads rapid local edits directly rather than waiting for a React render', async () => {
    const { sync, save } = await editor({ hat: 'cat', body: 'short' });
    const pending = Promise.withResolvers<SharedCharacter>();
    save.mockReturnValueOnce(pending.promise);
    const shop: CircleShop = { ...emptyShop, unlocked: ['color:blue'] };
    const select = (patch: Partial<CharacterAppearance>) => applyCharacterSelection(sync, shop, patch);
    select({ body: 'tall' });
    select({ color: 'blue' });
    select({ hat: 'clown' });

    const expected = { hat: 'clown', body: 'tall', color: 'blue' };
    expect(sync.getState().appearance).toEqual(expected);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    pending.resolve({ appearance: { hat: 'cat', body: 'tall' }, revision: 2 });
    await vi.waitFor(() => expect(sync.getState().status).toBe('saved'));
    expect(save).toHaveBeenLastCalledWith(expected, 2);
  });

  it('does nothing after the character session stops or before its editor exists', async () => {
    const original: CharacterAppearance = { hat: 'cat', body: 'short' };
    const { sync, save } = await editor(original);
    sync.stop();
    applyCharacterSelection(sync, emptyShop, { hat: 'wizard' });
    applyCharacterSelection(null, emptyShop, { hat: 'wizard' });
    expect(sync.getState().appearance).toEqual(original);
    expect(save).not.toHaveBeenCalled();
  });
});
