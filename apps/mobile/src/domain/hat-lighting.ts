import type { HatId } from './character';

/** Small face accessories need less firelight shading than opaque headwear:
 * preserve the white eyes/stick and the candy's supplied colors/highlights.
 */
export function hatLighting(hat: HatId) {
  if (hat === 'googly-eyes' || hat === 'lollipop' || hat === 'bubble-gum') {
    return { ambientOpacity: 0, directionalOpacity: 0.22 };
  }
  return { ambientOpacity: 0.16, directionalOpacity: 1 };
}
