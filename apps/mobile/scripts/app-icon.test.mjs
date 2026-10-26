import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { expo } = require('../app.json');
const Jimp = require('jimp-compact');
const iconPath = fileURLToPath(new URL('../assets/campsite/sumore-app-icon-charcoal.png', import.meta.url));

describe('charcoal launcher icon', () => {
  it('uses the opaque icon on iOS and legacy Android', () => {
    expect(expo.icon).toBe('./assets/campsite/sumore-app-icon-charcoal.png');
    expect(expo.ios.icon).toBe(expo.icon);
  });

  it('keeps the original transparent logo for adaptive foreground and splash', () => {
    expect(expo.android.adaptiveIcon).toMatchObject({
      backgroundColor: '#24282C',
      foregroundImage: './assets/campsite/sumore.png',
    });
    expect(expo.plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen')[1].image)
      .toBe('./assets/campsite/sumore.png');
  });

  it('has a square opaque canvas with charcoal corners and background', async () => {
    const image = await Jimp.read(iconPath);
    const { width, height, data } = image.bitmap;
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(1024);
    for (let offset = 3; offset < data.length; offset += 4) {
      if (data[offset] !== 255) throw new Error('Launcher icon must be opaque');
    }
    const inset = Math.floor(width * 0.05);
    const middle = Math.floor(width / 2);
    const backgroundPoints = [
      [0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1],
      [inset, inset], [width - 1 - inset, inset],
      [inset, height - 1 - inset], [width - 1 - inset, height - 1 - inset],
      [middle, 0], [middle, height - 1], [0, middle], [width - 1, middle],
    ];
    for (const [x, y] of backgroundPoints) {
      const { r, g, b } = Jimp.intToRGBA(image.getPixelColor(x, y));
      expect(Math.abs(r - 36), `red at (${x}, ${y})`).toBeLessThanOrEqual(3);
      expect(Math.abs(g - 40), `green at (${x}, ${y})`).toBeLessThanOrEqual(3);
      expect(Math.abs(b - 44), `blue at (${x}, ${y})`).toBeLessThanOrEqual(3);
    }
  });
});
