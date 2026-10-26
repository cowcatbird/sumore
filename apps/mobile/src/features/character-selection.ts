import type { CharacterAppearance } from '@/domain/character';
import { unlockedAppearance, type CircleShop } from '@/domain/circle-shop';

type CharacterSelectionEditor = {
  getState: () => { appearance: CharacterAppearance };
  setAppearance: (patch: Partial<CharacterAppearance>) => void;
};

/** Merge into the current editor, including edits received while buying an item. */
export function applyCharacterSelection(
  editor: CharacterSelectionEditor | null,
  shop: CircleShop | null | undefined,
  patch: Partial<CharacterAppearance>,
) {
  if (!editor) return;
  const current = unlockedAppearance(shop, editor.getState().appearance);
  // Only sanitize the previous look. A just-purchased patch may arrive before
  // React commits its unlock snapshot; the save RPC remains authoritative.
  editor.setAppearance({ ...current, ...patch });
}
