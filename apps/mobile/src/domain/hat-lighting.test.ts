import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { HATS } from './character';
import { hatLighting } from './hat-lighting';

const faceAccessories = ['googly-eyes', 'lollipop', 'bubble-gum'] as const;

describe('small face accessory shading', () => {
  it.each(faceAccessories)('%s retains bright source colors with gentle directional shading', hat => {
    const shading = hatLighting(hat);
    expect(shading.ambientOpacity).toBe(0);
    expect(shading.directionalOpacity).toBe(0.22);
    // Even the darkest edge leaves more than 80% of the supplied color visible.
    expect(0.73 * shading.directionalOpacity).toBeLessThan(0.2);
  });

  it('does not change lighting on other headwear', () => {
    for (const hat of HATS) {
      if (faceAccessories.some(id => id === hat.id)) continue;
      expect(hatLighting(hat.id)).toEqual({ ambientOpacity: 0.16, directionalOpacity: 1 });
    }
  });

  it('uses the same per-item shading for campers and shaded thumbnails', () => {
    const renderer = readFileSync(new URL('../components/character-sprite.tsx', import.meta.url), 'utf8');
    expect(renderer.match(/const shading = hatLighting\(hat\)/g)).toHaveLength(2);
    expect(renderer).toContain('fill="#071320" opacity={shading.ambientOpacity}');
    expect(renderer).toContain('fill={`url(#${uid}-hat-shade)`} opacity={shading.directionalOpacity}');
    expect(renderer).toContain('fill={`url(#${uid}-thumbnail-shade)`} opacity={shading.directionalOpacity}');
  });
});
