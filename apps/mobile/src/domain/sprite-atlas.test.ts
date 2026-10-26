/// <reference types="node" />

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { CAMPFIRE_ORIGIN, camperRect, campsitePositions } from './campsite-layout';
import { CHARACTER_MIRROR_X, fitAtlasImage, MARSHMALLOW_EFFECT_PADDING, MARSHMALLOW_FLAME_CROP, marshmallowEffectViewport, marshmallowFlameViewport } from './sprite-atlas';

describe('native-safe sprite atlas placement', () => {
  it('clips hat thumbnails to the atlas crop, including their letterboxed margins', () => {
    const path = new URL('../components/character-sprite.tsx', import.meta.url);
    const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const thumbnail = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'HatSprite',
    );
    expect(thumbnail?.body).toBeDefined();
    const body = thumbnail!.body!;
    const elements: (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) elements.push(node);
      ts.forEachChild(node, visit);
    };
    visit(body);
    const attribute = (node: (typeof elements)[number], name: string) => {
      const prop = node.attributes.properties.find((value): value is ts.JsxAttribute =>
        ts.isJsxAttribute(value) && value.name.getText(source) === name,
      );
      return prop?.initializer?.getText(source);
    };
    const clip = elements.find(node => node.tagName.getText(source) === 'ClipPath');
    const image = elements.find(node => node.tagName.getText(source) === 'Image');
    const cropRect = elements.find(node => node.tagName.getText(source) === 'Rect' && attribute(node, 'x') === '{crop.x}');
    expect(clip).toBeDefined();
    expect(image).toBeDefined();
    expect(cropRect).toBeDefined();
    expect(attribute(clip!, 'id')).toBe('{`${uid}-thumbnail-clip`}');
    expect(attribute(image!, 'clipPath')).toBe('{`url(#${uid}-thumbnail-clip)`}');
    expect(['x', 'y', 'width', 'height'].map(name => attribute(cropRect!, name)))
      .toEqual(['{crop.x}', '{crop.y}', '{crop.w}', '{crop.h}']);
    // The stable clip ID hook must run before the early return for "none".
    expect(ts.isVariableStatement(body.statements[0])).toBe(true);
    expect(body.statements[0].getText(source)).toContain('useId()');
  });

  it('places the short body at its requested location, not the SVG origin', () => {
    const crop = { x: 443, y: 459, w: 133, h: 214 };
    const viewport = { x: 43, y: 194 - 65 * crop.h / crop.w, width: 65, height: 65 * crop.h / crop.w };
    const image = fitAtlasImage(794, 1123, crop, viewport);
    const scale = image.width / 794;
    expect(image.x + crop.x * scale).toBeCloseTo(viewport.x);
    expect(image.y + crop.y * scale).toBeCloseTo(viewport.y);
    expect(image.y + (crop.y + crop.h) * scale).toBeCloseTo(194);
    expect(image.height / 1123).toBeCloseTo(scale);
  });

  it('preserves aspect ratio and centers a crop inside a wider viewport', () => {
    const image = fitAtlasImage(1000, 500, { x: 100, y: 50, w: 200, h: 100 }, { x: 20, y: 30, width: 100, height: 25 });
    expect(image).toEqual({ x: 20, y: 17.5, width: 250, height: 125 });
    expect(image.x + 100 * 0.25).toBe(45);
    expect(image.y + 50 * 0.25).toBe(30);
  });

  it('preserves aspect ratio and centers a crop inside a taller viewport', () => {
    const image = fitAtlasImage(1000, 500, { x: 100, y: 50, w: 200, h: 100 }, { x: 20, y: 30, width: 50, height: 100 });
    expect(image).toEqual({ x: -5, y: 55, width: 250, height: 125 });
    expect(image.x + 100 * 0.25).toBe(20);
    expect(image.y + 50 * 0.25).toBe(67.5);
  });

  it('uses exactly the supplied flame crop and previous flame attachment', () => {
    expect(MARSHMALLOW_FLAME_CROP).toEqual({ x: 211, y: 125, w: 605, h: 760 });
    expect(marshmallowFlameViewport('right')).toEqual({ x: 128, y: 99, width: 27, height: 34 });
    expect(marshmallowFlameViewport('left')).toEqual({ x: -4, y: 99, width: 27, height: 34 });
  });

  it('keeps left and right flame endpoints mirrored around the camper center', () => {
    const right = marshmallowFlameViewport('right');
    const left = marshmallowFlameViewport('left');
    expect(left.x).toBe(CHARACTER_MIRROR_X - right.x - right.width);
    expect(left.x + left.width).toBe(CHARACTER_MIRROR_X - right.x);
    expect(left.y).toBe(right.y);
  });
});

describe('padded marshmallow flame effects', () => {
  it.each(['left', 'right'] as const)('preserves the flame attachment inside the %s effect', facing => {
    const flame = marshmallowFlameViewport(facing);
    const effect = marshmallowEffectViewport(facing);
    const padding = MARSHMALLOW_EFFECT_PADDING;
    expect(effect.x + padding).toBe(flame.x);
    expect(effect.y + padding).toBe(flame.y);
    expect(effect.width).toBe(flame.width + 2 * padding);
    expect(effect.height).toBe(flame.height + 2 * padding);

    // Moving the image into its padded local canvas must not move or rescale
    // the actual atlas pixels relative to the camper's hand.
    const originalImage = fitAtlasImage(1024, 1024, MARSHMALLOW_FLAME_CROP, flame);
    const localImage = fitAtlasImage(1024, 1024, MARSHMALLOW_FLAME_CROP, {
      x: padding, y: padding, width: flame.width, height: flame.height,
    });
    expect(effect.x + localImage.x).toBeCloseTo(originalImage.x);
    expect(effect.y + localImage.y).toBeCloseTo(originalImage.y);
    expect(localImage.width).toBeCloseTo(originalImage.width);
    expect(localImage.height).toBeCloseTo(originalImage.height);
  });

  it.each(['left', 'right'] as const)('contains the entire flame and glow for a %s-facing camper', facing => {
    const flame = marshmallowFlameViewport(facing);
    const effect = marshmallowEffectViewport(facing);
    const padding = MARSHMALLOW_EFFECT_PADDING;
    expect(padding).toBeGreaterThanOrEqual(19); // 22px glow radius extends 19px below the flame.
    const glow = { cx: padding + flame.width / 2, cy: padding + flame.height - 3, rx: 28, ry: 22 };
    expect(padding).toBeGreaterThanOrEqual(0);
    expect(padding + flame.width).toBeLessThanOrEqual(effect.width);
    expect(padding + flame.height).toBeLessThanOrEqual(effect.height);
    expect(glow.cx - glow.rx).toBeGreaterThanOrEqual(0);
    expect(glow.cy - glow.ry).toBeGreaterThanOrEqual(0);
    expect(glow.cx + glow.rx).toBeLessThanOrEqual(effect.width);
    expect(glow.cy + glow.ry).toBeLessThanOrEqual(effect.height);
  });

  it('keeps the padded left and right canvases mirrored without clipping at the camper bounds', () => {
    const right = marshmallowEffectViewport('right');
    const left = marshmallowEffectViewport('left');
    expect(left.x).toBe(CHARACTER_MIRROR_X - right.x - right.width);
    expect(left.x + left.width).toBe(CHARACTER_MIRROR_X - right.x);
    expect(left.y).toBe(right.y);
    // These effects intentionally cross the avatar's old 0..160 clipping box.
    expect(left.x).toBeLessThan(0);
    expect(right.x + right.width).toBeGreaterThan(160);
  });

  it.each([57, 100, 160, 240])('keeps the flame and glow anchored when the camper is %ipx wide', size => {
    const scale = size / 160;
    for (const facing of ['left', 'right'] as const) {
      const flame = marshmallowFlameViewport(facing);
      const effect = marshmallowEffectViewport(facing);
      const padding = MARSHMALLOW_EFFECT_PADDING;
      expect(effect.x * scale + padding * scale).toBeCloseTo(flame.x * scale);
      expect(effect.y * scale + padding * scale).toBeCloseTo(flame.y * scale);
      expect((padding + flame.width / 2 - 28) * scale).toBeGreaterThanOrEqual(0);
      expect((padding + flame.width / 2 + 28) * scale).toBeLessThanOrEqual(effect.width * scale);
      expect((padding + flame.height - 3 + 22) * scale).toBeLessThanOrEqual(effect.height * scale);
    }
  });

  it.each([2, 3, 4, 5, 6])('preserves flame anchors in every slot of a %i-person campsite', count => {
    for (const sceneWidth of [320, 390, 560]) {
      for (const slot of campsitePositions(count)) {
        const rect = camperRect(sceneWidth, slot);
        const scale = rect.width / 160;
        const facing = slot.x > CAMPFIRE_ORIGIN.x ? 'left' : 'right';
        const flame = marshmallowFlameViewport(facing);
        const effect = marshmallowEffectViewport(facing);
        expect(rect.left + (effect.x + MARSHMALLOW_EFFECT_PADDING) * scale).toBeCloseTo(rect.left + flame.x * scale);
        expect(rect.top + (effect.y + MARSHMALLOW_EFFECT_PADDING) * scale).toBeCloseTo(rect.top + flame.y * scale);
        expect(effect.width * scale).toBeGreaterThan(flame.width * scale);
        expect(effect.height * scale).toBeGreaterThan(flame.height * scale);
      }
    }
  });
});
