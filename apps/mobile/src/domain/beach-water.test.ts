/// <reference types="node" />

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { BEACH_WATER, WATER_DRIFT_X, WATER_DRIFT_Y, WATER_LAYERS, waterRipplePath } from './beach-water';

function parse(relativePath: string) {
  return ts.createSourceFile(relativePath, readFileSync(new URL(relativePath, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function nodes(root: ts.Node, predicate: (node: ts.Node) => boolean) {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

function fn(root: ts.Node, name: string) {
  const found = nodes(root, node => (ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name?.text === name)[0];
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}

function tags(root: ts.Node, name: string) {
  return nodes(root, node => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === name);
}

function calls(root: ts.Node) {
  return nodes(root, ts.isCallExpression).map(node => (node as ts.CallExpression).expression.getText());
}

const water = parse('../components/beach-water.tsx');
const scene = parse('../components/campsite-scene.tsx');
const motion = parse('../components/use-fire-motion.ts');
const frameWork = /(?:setInterval|setTimeout|requestAnimationFrame|addListener|useSpriteFrame|useFireGlow|useEffect)$/;

describe('beach ripple geometry', () => {
  it('keeps every moving, stroked curve inside the water without crossing the palm', () => {
    const horizon = 760;
    const earliestSand = 920;
    const palmLeft = 135;
    const palmRight = 355;
    expect(BEACH_WATER).toEqual({ x: 0, y: 762, width: 1080, height: 164 });
    expect(WATER_DRIFT_X).toBeGreaterThan(0);
    expect(WATER_DRIFT_Y).toBeGreaterThan(0);
    for (const { ripples } of WATER_LAYERS) {
      for (const ripple of ripples) {
        const path = waterRipplePath(ripple);
        // M + C + S: cubic curves remain inside their control-point hull.
        expect(path.match(/[A-Za-z]/g)).toEqual(['M', 'C', 'S']);
        const values = [...path.matchAll(/-?(?:\d+\.?\d*|\.\d+)/g)].map(match => Number(match[0]));
        expect(values).toHaveLength(12);
        expect(values.every(Number.isFinite)).toBe(true);
        const points = Array.from({ length: 6 }, (_, index) => ({ x: values[index * 2], y: values[index * 2 + 1] }));
        // Include the S command's implicit reflection of the previous control.
        points.push({ x: 2 * points[3].x - points[2].x, y: 2 * points[3].y - points[2].y });
        const stroke = ripple.weight / 2;
        const left = Math.min(...points.map(point => point.x)) - WATER_DRIFT_X - stroke;
        const right = Math.max(...points.map(point => point.x)) + WATER_DRIFT_X + stroke;
        const top = Math.min(...points.map(point => point.y)) - WATER_DRIFT_Y - stroke;
        const bottom = Math.max(...points.map(point => point.y)) + WATER_DRIFT_Y + stroke;
        expect(ripple.width).toBeGreaterThan(0);
        expect(ripple.weight).toBeGreaterThan(0);
        expect(Math.max(...points.map(point => Math.abs(point.y - ripple.y)))).toBeLessThanOrEqual(ripple.bend + 0.000001);
        expect(left).toBeGreaterThan(0);
        expect(right).toBeLessThan(BEACH_WATER.width);
        expect(top).toBeGreaterThan(0);
        expect(bottom).toBeLessThan(BEACH_WATER.height);
        expect(BEACH_WATER.y + top).toBeGreaterThan(horizon);
        expect(BEACH_WATER.y + bottom).toBeLessThan(earliestSand);
        expect(right < palmLeft || left > palmRight, `Palm overlap: ${path}`).toBe(true);
      }
    }
  });

  it('uses two slow, sparse layers instead of a high-frequency surface', () => {
    expect(WATER_LAYERS).toHaveLength(2);
    for (const layer of WATER_LAYERS) {
      expect(layer.duration).toBeGreaterThanOrEqual(6_000);
      expect(layer.ripples.length).toBeGreaterThan(0);
      expect(layer.ripples.length).toBeLessThanOrEqual(10);
    }
    expect(new Set(WATER_LAYERS.map(layer => layer.duration)).size).toBe(2);
  });
});

describe('small native water animation', () => {
  it('moves static SVG strips using native view transforms with no React frame loop', () => {
    const layer = fn(water, 'RippleLayer');
    expect(calls(water).filter(name => frameWork.test(name))).toEqual([]);
    expect(calls(layer)).toContain('Animated.loop');
    expect(calls(layer)).toContain('Animated.timing');
    expect(layer.getText()).toContain("useNativeDriver: Platform.OS !== 'web'");
    expect(layer.getText()).toContain('isInteraction: false');
    expect(layer.getText()).toContain('duration: WATER_LAYERS[index].duration');
    expect(tags(layer, 'Animated.View')).toHaveLength(1);
    expect(tags(layer, 'Svg')).toHaveLength(0);
    expect(tags(layer, 'RippleDrawing')).toHaveLength(1);
    const state = nodes(water, node => ts.isVariableDeclaration(node) && !!node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText() === 'useState') as ts.VariableDeclaration[];
    expect(state).toHaveLength(1);
    expect(ts.isArrayBindingPattern(state[0].name)).toBe(true);
    expect((state[0].name as ts.ArrayBindingPattern).elements).toHaveLength(1); // Stable Animated.Value, no state setter.
    expect(state[0].initializer!.getText()).toContain('new Animated.Value(0)');
  });

  it('stops and resets on pause, blur, backgrounding, and Reduce Motion', () => {
    const layer = fn(water, 'RippleLayer');
    expect(layer.getText()).toContain('useVisibleAnimation(enabled, play)');
    expect(layer.getText()).toContain('return () => { loop.stop(); phase.setValue(0); }');
    const gate = fn(motion, 'useVisibleAnimation').getText();
    expect(gate).toContain('useFocusEffect');
    expect(gate).toContain('if (!enabled) return');
    expect(gate).toContain("AppState.addEventListener('change'");
    expect(gate).toContain("AccessibilityInfo.addEventListener('reduceMotionChanged'");
    expect(gate).toContain('AccessibilityInfo.isReduceMotionEnabled()');
    expect(gate).toContain('alive && active && !reduced');
    expect(gate).toContain('alive = false;');
    expect(gate).toContain('motionSub.remove()');
    expect(gate).toContain('stateSub.remove()');
  });

  it('memoizes the static drawing and never masks, warps, or redraws a bitmap', () => {
    const declarations = nodes(water, ts.isVariableDeclaration) as ts.VariableDeclaration[];
    for (const name of ['BeachWater', 'RippleDrawing']) {
      const declaration = declarations.find(node => node.name.getText() === name);
      expect(declaration?.initializer && ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText()).toBe('memo');
    }
    const drawing = fn(water, 'RippleDrawing');
    expect(tags(drawing, 'Svg')).toHaveLength(1);
    expect(calls(drawing)).toContain('useId');
    expect(drawing.getText()).toContain('id={gradient}');
    expect(drawing.getText()).toContain('stroke={`url(#${gradient})`}');
    expect(calls(drawing).filter(name => frameWork.test(name))).toEqual([]);
    expect(calls(drawing)).not.toContain('phase.interpolate');
    for (const forbidden of ['Image', 'Mask', 'Animated.Svg', 'Animated.Path']) expect(tags(water, forbidden)).toHaveLength(0);
    expect(calls(water)).not.toContain('require');
    expect(water.getText()).toContain("overflow: 'hidden'");
    expect(water.getText()).toContain('pointerEvents="none"');
    expect(water.getText()).toContain('unit={width / CAMPSITE.width}');
  });

  it('only mounts over a measured beach scene and honors the scene pause control', () => {
    const mount = tags(fn(scene, 'CampsiteScene'), 'BeachWater');
    expect(mount).toHaveLength(1);
    const conditions: string[] = [];
    let current: ts.Node | undefined = mount[0];
    while (current) {
      if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) conditions.push(current.left.getText());
      current = current.parent;
    }
    expect(conditions).toContain("background === 'beach'");
    expect(conditions).toContain('width > 0');
    expect(mount[0].getText()).toContain('width={width}');
    expect(mount[0].getText()).toContain('enabled={!paused}');
  });
});
