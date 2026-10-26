/// <reference types="node" />

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../components/campsite-thumbnail.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile('campsite-thumbnail.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function nodes(predicate: (node: ts.Node) => boolean) {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

function tags(name: string) {
  return nodes(node => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === name);
}

describe('static shaded campsite thumbnails', () => {
  it('draws the untouched image first, then its night and distance overlays', () => {
    const image = tags('Image');
    const overlays = tags('Rect');
    expect(image).toHaveLength(1);
    expect(overlays).toHaveLength(2);
    expect(image[0].getText()).toContain('source={source}');
    expect(image[0].getText()).toContain('resizeMode="cover"');
    expect(image[0].getText()).toContain('style={[styles.art, { width: `${sourceWidth / 1080 * 100}%` }]}');
    // RN Web otherwise retains the bitmap's intrinsic dimensions and displays
    // only a corner of the sky inside the small clipped thumbnail.
    expect(source).toContain("art: { width: '100%', height: '100%' }");
    for (const rect of overlays) expect(rect.pos).toBeGreaterThan(image[0].pos);
    expect(overlays[0].getText()).toContain('fill={`url(#${uid}-distance)`}');
    expect(overlays[1].getText()).toContain('fill={`url(#${uid}-night)`}');
    expect(tags('Mask')).toHaveLength(0);
  });

  it('clips the lighting to a fixed image frame without shading labels or prices', () => {
    expect(source).toContain("frame: { width: '100%', height: 132, overflow: 'hidden'");
    expect(source).toContain('style={styles.frame}');
    expect(source).toContain('pointerEvents="none"');
    expect(source).toContain('accessibilityElementsHidden');
    expect(tags('Text')).toHaveLength(0);
    expect(tags('Pressable')).toHaveLength(0);
    const identifiers = nodes(ts.isIdentifier).map(node => (node as ts.Identifier).text);
    expect(identifiers).not.toContain('children');
    expect(identifiers).not.toContain('price');
    expect(identifiers).not.toContain('label');
  });

  it('clips the snow export padding without shrinking its visible painting', () => {
    expect(source).toContain('sourceWidth = 1080');
    expect(source).toContain('width: `${sourceWidth / 1080 * 100}%`');
    const customize = readFileSync(new URL('../app/customize.tsx', import.meta.url), 'utf8');
    expect(customize).toContain("sourceWidth={background.id === 'snow' ? 1139 : 1080}");
  });

  it('uses unique definition IDs and a memoized drawing with no animations or timers', () => {
    const callNames = nodes(ts.isCallExpression).map(node => (node as ts.CallExpression).expression.getText());
    expect(callNames).toContain('memo');
    expect(callNames).toContain('useId');
    expect(callNames.filter(name => /(?:useState|useEffect|useSpriteFrame|useFireGlow|useVisibleAnimation|setInterval|setTimeout|requestAnimationFrame|Animated\.)/.test(name))).toEqual([]);
    expect(tags('Animated.View')).toHaveLength(0);
    expect(tags('LinearGradient')[0].getText()).toContain('id={`${uid}-distance`}');
    expect(tags('RadialGradient')[0].getText()).toContain('id={`${uid}-night`}');
    expect(source).toContain('const uid = `campsite-thumb-${useId().replace(/:/g, \'\')}`');
  });
});
