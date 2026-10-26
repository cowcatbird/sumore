/// <reference types="node" />

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Geometry tests cannot detect a browser-only nested-SVG renderer or a timer
// accidentally moved back into the whole scene. Guard those native regressions
// against parsed code, rather than matching comments or formatting.
function parse(relativePath: string) {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function matchingNodes(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (child: ts.Node) => {
    if (predicate(child)) found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function namedFunction(source: ts.SourceFile, name: string): ts.Node {
  const found = matchingNodes(source, node =>
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name?.text === name,
  )[0];
  if (!found) throw new Error(`Expected the ${name} rendering boundary in ${source.fileName}`);
  return found;
}

function calls(node: ts.Node): string[] {
  return matchingNodes(node, ts.isCallExpression).map(candidate => {
    const expression = (candidate as ts.CallExpression).expression;
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return '';
  });
}

function tags(node: ts.Node, tag: string) {
  return matchingNodes(node, child =>
    (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) && child.tagName.getText() === tag,
  );
}

function sourcePaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourcePaths(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const character = parse('../components/character-sprite.tsx');
const scene = parse('../components/campsite-scene.tsx');
const campfire = parse('../components/campfire.tsx');
const motion = parse('../components/use-fire-motion.ts');
const tickingCalls = ['useSpriteFrame', 'useFireMotion', 'setInterval', 'setTimeout', 'requestAnimationFrame'];

describe('native rendering architecture regression guards', () => {
  it('keeps atlas images and character drawings flat, without nested SVG viewports', () => {
    for (const name of ['AtlasImage', 'CharacterDrawing', 'ColoredMarshmallowStick']) {
      expect(tags(namedFunction(character, name), 'Svg'), name).toHaveLength(0);
    }
    expect(tags(namedFunction(character, 'AtlasImage'), 'Image')).toHaveLength(1);
    expect(calls(namedFunction(character, 'AtlasImage'))).toContain('fitAtlasImage');
  });

  it('renders the supplied color atlas with the original body geometry and directional lighting', () => {
    const drawing = namedFunction(character, 'CharacterDrawing');
    const declarations = Object.fromEntries(matchingNodes(drawing, ts.isVariableDeclaration)
      .map(node => {
        const declaration = node as ts.VariableDeclaration;
        return [declaration.name.getText(), declaration.initializer?.getText()];
      }));
    expect(character.getText()).toContain("require('../../assets/campsite/colored-campers.png')");
    expect(declarations.color).toBe("appearance.color ?? 'cream'");
    expect(declarations.originalCrop).toBe('ORIGINAL_BODY_CROPS[appearance.body]');
    expect(declarations.crop).toBe("color === 'cream' ? originalCrop : coloredBodyCrop(color, appearance.body)");
    expect(declarations.bodyAtlas).toBe("color === 'cream' ? { width: 794, height: 1123 } : COLORED_CAMPER_ATLAS");
    expect(declarations.bodyWidth).toBe('65');
    expect(declarations.bodyHeight).toBe('bodyWidth * originalCrop.h / originalCrop.w');
    expect(declarations.top).toBe('194 - bodyHeight');
    expect(declarations.bodyViewport).toBe('{ x: 43, y: top, width: bodyWidth, height: bodyHeight }');
    expect(declarations.body).toContain("source={color === 'cream' ? BODY : COLORED_CAMPERS}");
    expect(declarations.body).toContain('atlasWidth={bodyAtlas.width} atlasHeight={bodyAtlas.height} crop={crop}');
    expect(declarations.body).toContain('{...bodyViewport} clipId={`${uid}-body-clip`}');

    const clip = tags(drawing, 'ClipPath').find(node => node.getText().includes('-body-clip'))!;
    expect(tags(clip.parent, 'Path')).toHaveLength(0);
    expect(tags(clip.parent, 'Rect').map(node => node.getText())).toEqual(['<Rect {...bodyViewport} />']);
    const mask = tags(drawing, 'Mask').find(node => node.getText().includes('id={`${uid}-body`}'))!;
    expect(mask.getText()).toContain('maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" {...nativeAlphaMask}');
    expect(mask.getText()).toContain("style={{ maskType: 'alpha' }}");
    expect(matchingNodes(mask.parent, ts.isJsxExpression).map(node => node.getText())).toContain('{body}');
    const gradient = tags(drawing, 'LinearGradient').find(node => node.getText().includes('id={`${uid}-shade`}'))!;
    expect(gradient.getText()).toContain('x1="0%" y1="30%" x2="100%" y2="65%"');
    expect(tags(gradient.parent, 'Stop').map(node => node.getText())).toEqual([
      '<Stop offset="0" stopColor="#0A1927" stopOpacity={0.77 - lighting * 0.18} />',
      '<Stop offset="0.36" stopColor="#183040" stopOpacity={0.33} />',
      '<Stop offset="0.72" stopColor="#FFD18B" stopOpacity={0.17 + lighting * 0.23} />',
      '<Stop offset="1" stopColor="#FFAD41" stopOpacity={0.52 + lighting * 0.14} />',
    ]);
    const rectangles = tags(drawing, 'Rect') as ts.JsxSelfClosingElement[];
    const light = rectangles.find(rect => rect.attributes.getText().includes('fill={`url(#${uid}-shade)`}')
      && rect.attributes.getText().includes('mask={`url(#${uid}-body)`}'));
    expect(light).toBeDefined();
    const bodyLayers = matchingNodes(drawing, node => ts.isJsxExpression(node) && node.expression?.getText() === 'body');
    expect(bodyLayers).toHaveLength(2); // The same atlas image supplies pixels and the alpha mask.
    expect(bodyLayers[1].pos).toBeLessThan(light!.pos);
    expect(matchingNodes(drawing, node => ts.isIdentifier(node) && node.text === 'bodyTint')).toHaveLength(0);
    // Matching hand lighting must leave the body's directional lighting unchanged.
    expect(light!.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText() === 'opacity')).toBe(false);
    expect(calls(drawing).filter(call => tickingCalls.includes(call))).toEqual([]);
    expect(drawing.getText()).toContain('source={STICKS}');
    expect(drawing.getText()).toContain('source={HATS}');
  });

  it('keeps the original cream hand and confines matching directional lighting to the white interior', () => {
    const drawing = namedFunction(character, 'CharacterDrawing');
    expect(drawing.getText()).toContain("showMarshmallow && (color !== 'cream' ?");
    const choice = matchingNodes(drawing, node => ts.isConditionalExpression(node)
      && tags(node.whenTrue, 'ColoredMarshmallowStick').length > 0)[0] as ts.ConditionalExpression;
    expect(choice.condition.getText()).toBe("color !== 'cream'");
    expect(choice.whenTrue.getText()).toBe('<ColoredMarshmallowStick color={color} burnt={burnt} uid={uid} />');
    const creamImages = tags(choice.whenFalse, 'AtlasImage');
    expect(creamImages).toHaveLength(1);
    expect(creamImages[0].getText()).toContain('source={STICKS} atlasWidth={794} atlasHeight={1123} crop={handCrop}');
    expect(creamImages[0].getText()).toContain('{...handViewport} clipId={`${uid}-hand-clip`}');
    expect(drawing.getText()).toContain('burnt ? handInteriors.burnt : handInteriors.fresh');
    expect(drawing.getText()).toContain('fitAtlasImage(794, 1123, handCrop, handViewport)');
    expect(drawing.getText()).toContain('handScale = handAtlas.width / 794');
    expect(choice.whenFalse.getText()).toContain('translate(${handAtlas.x} ${handAtlas.y}) scale(${handScale})');
    const clip = tags(drawing, 'ClipPath').find(node => node.getText().includes('-hand-fill-clip'))!;
    expect(tags(clip.parent, 'Path').map(node => node.getText())).toEqual(['<Path d={handInterior.path} />']);
    const shadedHand = tags(choice.whenFalse, 'G').find(node => node.getText().includes('clipPath={`url(#${uid}-hand-fill-clip)`}'))!;
    expect(shadedHand.getText()).toContain('clipRule="nonzero"');
    const layers = tags(shadedHand.parent, 'Rect');
    expect(layers.map(node => node.getText())).toEqual([
      '<Rect {...handInterior.bounds} fill={`url(#${uid}-shade)`} opacity={0.75} />',
    ]);
    expect(tags(shadedHand.parent, 'Image')).toHaveLength(0);
    expect(tags(shadedHand.parent, 'AtlasImage')).toHaveLength(0);
  });

  it('lightens only the painted hand base beneath unchanged directional firelight using its natural alpha', () => {
    const stick = namedFunction(character, 'ColoredMarshmallowStick');
    expect(calls(stick)).toContain('coloredHandArt');
    expect(calls(stick).filter(call => tickingCalls.includes(call))).toEqual([]);
    expect(tags(stick, 'Path')).toHaveLength(0);
    const images = tags(stick, 'AtlasImage');
    expect(images).toHaveLength(2);
    const hand = images.find(node => node.getText().includes('source={COLORED_CAMPERS}'))!;
    expect(hand.getText()).toContain('atlasWidth={COLORED_CAMPER_ATLAS.width} atlasHeight={COLORED_CAMPER_ATLAS.height}');
    expect(hand.getText()).toContain('crop={art.crop} {...HAND_VIEWPORT} clipId={`${uid}-colored-stick-clip`}');
    const clip = tags(stick, 'ClipPath').find(node => node.getText().includes('id={`${uid}-colored-stick-clip`}'))!;
    expect(tags(clip.parent, 'Rect').map(node => node.getText())).toEqual(['<Rect {...HAND_VIEWPORT} />']);
    const masks = tags(stick, 'Mask');
    expect(masks).toHaveLength(1);
    expect(masks[0].getText()).toContain('id={`${uid}-colored-hand`} {...art.hand}');
    expect(masks[0].getText()).toContain('maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" {...nativeAlphaMask}');
    expect(masks[0].getText()).toContain("style={{ maskType: 'alpha' }}");
    expect((masks[0].parent as ts.JsxElement).children.filter(ts.isJsxExpression).map(node => node.expression?.getText())).toEqual(['hand']);
    const filledRectangles = (tags(stick, 'Rect') as ts.JsxSelfClosingElement[])
      .filter(rect => rect.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText() === 'fill'));
    expect(filledRectangles.map(node => node.getText())).toEqual([
      '<Rect {...art.hand} fill="#FFFFFF" opacity={0.28} mask={`url(#${uid}-colored-hand)`} />',
      '<Rect {...art.hand} fill={`url(#${uid}-shade)`} opacity={0.75} mask={`url(#${uid}-colored-hand)`} />',
    ]);
    const paintedPixels = matchingNodes(stick, node => ts.isConditionalExpression(node) && node.condition.getText() === 'burnt')[0];
    expect(paintedPixels.end).toBeLessThan(filledRectangles[0].pos);
    expect(filledRectangles[0].pos).toBeLessThan(filledRectangles[1].pos);
    expect(filledRectangles[0].parent).toBe(filledRectangles[1].parent);
    expect(matchingNodes(stick, node => ts.isIdentifier(node) && node.text === 'bodyTint')).toHaveLength(0);
  });

  it('replaces only the fresh cap when burnt while preserving the painted hand and stick', () => {
    const stick = namedFunction(character, 'ColoredMarshmallowStick');
    expect(stick.getText()).toContain('atlasRegionViewport({ width: 794, height: 1123 }, BURNT_HAND_CROP, HAND_VIEWPORT, BURNT_CAP_REGION)');
    const choices = matchingNodes(stick, ts.isConditionalExpression) as ts.ConditionalExpression[];
    expect(choices).toHaveLength(1);
    const choice = choices[0];
    expect(choice.condition.getText()).toBe('burnt');
    expect(choice.whenFalse.getText()).toBe('hand');
    const retainedHand = tags(choice.whenTrue, 'G');
    expect(retainedHand).toHaveLength(1);
    expect(retainedHand[0].getText()).toContain('clipRule="nonzero" clipPath={`url(#${uid}-colored-stick-below-cap)`}');
    expect((retainedHand[0].parent as ts.JsxElement).children.filter(ts.isJsxExpression).map(node => node.expression?.getText())).toEqual(['hand']);
    const cap = tags(choice.whenTrue, 'AtlasImage');
    expect(cap).toHaveLength(1);
    expect(cap[0].getText()).toContain('source={STICKS} atlasWidth={794} atlasHeight={1123} crop={BURNT_HAND_CROP}');
    expect(cap[0].getText()).toContain('{...HAND_VIEWPORT} clipId={`${uid}-burnt-cap-clip`}');
    expect(retainedHand[0].pos).toBeLessThan(cap[0].pos);
    for (const [id, viewport] of [['colored-stick-below-cap', 'art.stickBelowCap'], ['burnt-cap-clip', 'burntCap']]) {
      const clip = tags(stick, 'ClipPath').find(node => node.getText().includes(`-${id}`))!;
      expect(clip, id).toBeDefined();
      expect(tags(clip.parent, 'Rect').map(node => node.getText())).toEqual([`<Rect {...${viewport}} />`]);
    }
  });

  it('confines both cream hand lighting clips to the original white interiors in atlas coordinates', () => {
    const declaration = matchingNodes(character, node => ts.isVariableDeclaration(node) && node.name.getText() === 'handInteriors')[0] as ts.VariableDeclaration;
    const poses = (declaration.initializer as ts.ObjectLiteralExpression).properties as ts.NodeArray<ts.PropertyAssignment>;
    expect(poses.map(pose => pose.name.getText())).toEqual(['fresh', 'burnt']);
    for (const [index, pose] of poses.entries()) {
      const [x, y] = index === 0 ? [256, 513] : [430, 521];
      const paths = matchingNodes(pose, node => ts.isPropertyAssignment(node) && node.name.getText() === 'path') as ts.PropertyAssignment[];
      const path = (paths[0].initializer as ts.StringLiteral).text;
      expect(path).toMatch(/^M[\d. ]+(L[\d. ]+)+Z$/);
      const points = [...path.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
      expect(points.length).toBeGreaterThan(50);
      expect(Math.min(...points.map(point => point[0]))).toBe(x + 0.5);
      expect(Math.max(...points.map(point => point[0]))).toBe(x + 35.5);
      expect(Math.min(...points.map(point => point[1]))).toBe(y + 0.5);
      expect(Math.max(...points.map(point => point[1]))).toBe(y + 34.5);
      expect(pose.getText()).toContain(`bounds: { x: ${x}, y: ${y}, width: 36, height: 35 }`);
    }
  });

  it('offers the original beach art without changing the default forest or fire position', () => {
    expect(scene.getText()).toContain("beach: require('../../assets/campsite/background-beach.png')");
    expect(namedFunction(scene, 'CampsiteScene').getText()).toContain("background = 'forest'");
    const backdrop = namedFunction(scene, 'CampsiteBackdrop');
    const images = tags(backdrop, 'Image') as ts.JsxSelfClosingElement[];
    expect(images).toHaveLength(1);
    expect(images[0].attributes.getText()).toContain('href={BACKGROUNDS[background]}');
    expect(images[0].attributes.getText()).toContain("width={background === 'snow' ? 1139 : 1080} height={1920}");
    // This edge patch belongs only to the original mountain artwork.
    expect(backdrop.getText()).toContain("{background === 'forest' && <Path");
    expect(namedFunction(scene, 'StarField').getText()).toContain("background === 'beach'");
    expect(namedFunction(scene, 'StarField').getText()).toContain('350 + (y - 350) * 0.55');
    expect(namedFunction(scene, 'AnimatedBigFire').getText()).toContain('x={540} y={1270}');
  });

  it('uses the snow painting with existing lighting and embers, without extra sky stars or beach water', () => {
    expect(scene.getText()).toContain("snow: require('../../assets/campsite/background-snow.png')");
    const sceneBody = namedFunction(scene, 'CampsiteScene');
    const water = tags(sceneBody, 'BeachWater');
    expect(water).toHaveLength(1);
    const waterCondition = matchingNodes(sceneBody, ts.isBinaryExpression)
      .find(node => node.getText().includes("background === 'beach' && <BeachWater"));
    expect(waterCondition).toBeDefined();
    expect(tags(sceneBody, 'GroundLight')).toHaveLength(1);
    expect(tags(sceneBody, 'GroundShadows')).toHaveLength(1);
    const starField = namedFunction(scene, 'StarField');
    const skyStars = (matchingNodes(starField, ts.isVariableDeclaration) as ts.VariableDeclaration[])
      .find(node => node.name.getText() === 'skyStars')!;
    const choice = skyStars.initializer as ts.ConditionalExpression;
    expect(ts.isConditionalExpression(choice)).toBe(true);
    expect(choice.condition.getText()).toBe("background === 'snow'");
    expect(choice.whenTrue.getText()).toBe('[]');
    // Keep the three existing fire embers even when the sky stars are baked in.
    expect(starField.getText()).toContain('<Circle cx={511} cy={966} r={3.2}');
    expect(starField.getText()).toContain('<Circle cx={584} cy={943} r={2.6}');
    expect(starField.getText()).toContain('<Circle cx={542} cy={917} r={2}');
    const backdrop = namedFunction(scene, 'CampsiteBackdrop');
    expect(tags(backdrop, 'Image')).toHaveLength(1);
    expect(tags(backdrop, 'Rect')).toHaveLength(3);
    expect(backdrop.getText()).toContain('fill={`url(#${uid}-distance)`}');
    expect(backdrop.getText()).toContain('fill={`url(#${uid}-night)`}');
    expect(backdrop.getText()).toContain('fill={`url(#${uid}-sky)`}');
  });

  it('uses fresh nonzero crop paths for both the shaded atlas and thumbnails', () => {
    for (const name of ['AtlasImage', 'HatSprite']) {
      const images = tags(namedFunction(character, name), 'Image') as ts.JsxSelfClosingElement[];
      expect(images).toHaveLength(name === 'HatSprite' ? 2 : 1); // thumbnail image plus optional alpha mask
      for (const image of images) {
        const rule = image.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText() === 'clipRule') as ts.JsxAttribute;
        expect(rule).toBeDefined();
        expect(rule.initializer && ts.isStringLiteral(rule.initializer) && rule.initializer.text).toBe('nonzero');
      }
    }
  });

  it('uses the new sheet’s natural alpha for edges and firelight, without hand-traced or transformed paths', () => {
    const drawing = namedFunction(character, 'CharacterDrawing');
    expect(drawing.getText()).toContain('HAT_ATLASES[hatAtlas.sheet]');
    const clip = tags(drawing, 'ClipPath').find(node => node.getText().includes('-hat-clip'))!;
    expect(tags(clip.parent, 'Path')).toHaveLength(0);
    expect(tags(clip.parent, 'Rect').map(node => node.getText())).toEqual(['<Rect {...placement} />']);
    const atlasImages = tags(drawing, 'AtlasImage').filter(node => node.getText().includes('source={HATS}'));
    expect(atlasImages).toHaveLength(2);
    for (const image of atlasImages) {
      expect(image.getText()).toContain('atlasWidth={hatAtlas.width} atlasHeight={hatAtlas.height}');
      expect(image.getText()).toContain('clipId={`${uid}-hat-clip`}');
    }
    const thumbnail = namedFunction(character, 'HatSprite');
    expect(thumbnail.getText()).toContain('HAT_ATLASES[atlas.sheet]');
    expect(tags(thumbnail, 'Path')).toHaveLength(0);
  });

  it('shades tour thumbnails inside their exact alpha silhouette and crop only', () => {
    const hat = namedFunction(character, 'HatSprite');
    const source = hat.getText();
    expect(source).toContain('shaded = false');
    expect(source).toContain('maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" {...nativeAlphaMask}');
    expect(source).toContain('style={{ maskType: \'alpha\' }}');
    expect(source).toContain('mask={`url(#${uid}-thumbnail-mask)`}');
    expect(source).toContain('fill={`url(#${uid}-thumbnail-shade)`}');
    const masks = tags(hat, 'Mask') as ts.JsxOpeningElement[];
    expect(masks).toHaveLength(1);
    for (const [name, value] of [['x', 'crop.x'], ['y', 'crop.y'], ['width', 'crop.w'], ['height', 'crop.h']]) {
      expect(masks[0].attributes.getText()).toContain(`${name}={${value}}`);
    }
    const tour = parse('../components/app-tour.tsx');
    const thumbnails = tags(tour, 'HatSprite') as ts.JsxSelfClosingElement[];
    expect(thumbnails).toHaveLength(2);
    for (const thumbnail of thumbnails) expect(thumbnail.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText() === 'shaded')).toBe(true);
    expect(calls(hat).filter(call => tickingCalls.includes(call))).toEqual([]);
  });

  it('adds only subtle static s’more lighting while retaining original artwork and dimensions', () => {
    const smore = parse('../components/smore-sprite.tsx');
    const sprite = namedFunction(smore, 'SMoreSprite');
    expect(smore.getText()).toContain("require('../../assets/campsite/smore-reward.png')");
    expect(sprite.getText()).toContain('viewBox="0 0 491 340"');
    expect(sprite.getText()).toContain("style={{ maskType: 'alpha' }}");
    expect(sprite.getText()).toContain('mask={`url(#${uid}-shape)`}');
    expect(sprite.getText()).toContain('width: size, height: size, flexShrink: 0');
    expect(sprite.getText()).toContain('accessibilityLabel={decorative ? undefined : \'S’more reward\'}');
    expect(tags(sprite, 'Image')).toHaveLength(2);
    expect(tags(sprite, 'Mask')).toHaveLength(1);
    expect(calls(sprite)).toContain('useId');
    expect(calls(sprite).filter(call => tickingCalls.includes(call))).toEqual([]);
    for (const stop of tags(sprite, 'Stop') as ts.JsxSelfClosingElement[]) {
      const opacity = stop.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText() === 'stopOpacity') as ts.JsxAttribute;
      const value = (opacity.initializer as ts.JsxExpression).expression;
      expect(value && ts.isNumericLiteral(value)).toBe(true);
      expect(Number(value!.getText())).toBeLessThanOrEqual(0.3);
    }
  });

  it('resets only the Android native character surface on geometry changes', () => {
    const sprite = namedFunction(character, 'CharacterSprite');
    const root = tags(sprite, 'Svg')[0] as ts.JsxOpeningElement;
    const key = root.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText() === 'key') as ts.JsxAttribute;
    expect(key?.initializer && ts.isJsxExpression(key.initializer)).toBe(true);
    const expression = (key.initializer as ts.JsxExpression).expression as ts.ConditionalExpression;
    expect(ts.isConditionalExpression(expression)).toBe(true);
    expect(expression.condition.getText()).toBe("Platform.OS === 'android'");
    const identity = expression.whenTrue as ts.CallExpression;
    expect(ts.isCallExpression(identity)).toBe(true);
    expect(identity.expression.getText()).toBe('characterGeometryKey');
    expect(identity.arguments.map(arg => arg.getText())).toEqual(['appearance', 'facing', 'burnt']);
    expect(expression.whenFalse.getText()).toBe('undefined');
    // No animation tick/light value in this key: the small flame stays separate.
    expect(tags(sprite, 'MarshmallowFlame')).toHaveLength(1);
  });

  it('does not subscribe the whole campsite to sprite ticks or timer state', () => {
    const wholeScene = namedFunction(scene, 'CampsiteScene');
    const sceneCalls = calls(wholeScene);
    expect(sceneCalls.filter(name => tickingCalls.includes(name))).toEqual([]);
    expect(sceneCalls.filter(name => name === 'useFireGlow')).toHaveLength(1);
    // Campers must own separate small native canvases, not share a masked root.
    expect(tags(wholeScene, 'Svg')).toHaveLength(0);
    expect(tags(wholeScene, 'CharacterSprite')).toHaveLength(1);
    expect(calls(namedFunction(scene, 'AnimatedBigFire'))).toContain('useSpriteFrame');
  });

  it('keeps static character masks separate from the tiny animated flame canvas', () => {
    for (const name of ['CharacterSprite', 'CharacterDrawing']) {
      expect(calls(namedFunction(character, name)).filter(call => tickingCalls.includes(call)), name).toEqual([]);
    }
    const sprite = namedFunction(character, 'CharacterSprite');
    const roots = matchingNodes(sprite, node => ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'Svg');
    expect(roots).toHaveLength(1);
    expect(tags(roots[0], 'MarshmallowFlame')).toHaveLength(0);
    expect(tags(sprite, 'MarshmallowFlame')).toHaveLength(1);
    const flame = namedFunction(character, 'MarshmallowFlame');
    expect(calls(flame)).toContain('useSpriteFrame');
    expect(tags(flame, 'Svg')).toHaveLength(1);
    expect(tags(flame, 'CharacterDrawing')).toHaveLength(0);
    expect(tags(flame, 'Mask')).toHaveLength(0);
  });

  it('keeps compact-fire ticks out of the full-size campfire dispatcher', () => {
    expect(calls(namedFunction(campfire, 'Campfire')).filter(call => tickingCalls.includes(call))).toEqual([]);
    expect(calls(namedFunction(campfire, 'CompactCampfire'))).toContain('useSpriteFrame');
  });

  it('lets the marshmallow effect overhang the camper without removing atlas clips', () => {
    const sprite = namedFunction(character, 'CharacterSprite');
    const overflow = matchingNodes(sprite, node => ts.isPropertyAssignment(node) && node.name.getText() === 'overflow') as ts.PropertyAssignment[];
    expect(overflow).toHaveLength(1);
    expect(ts.isStringLiteral(overflow[0].initializer) && overflow[0].initializer.text).toBe('visible');
    expect(tags(namedFunction(character, 'MarshmallowFlame'), 'ClipPath')).toHaveLength(1);
  });

  it('keeps flame image sources mounted instead of swapping href on each tick', () => {
    const flame = namedFunction(character, 'MarshmallowFlame');
    const frameMaps = matchingNodes(flame, node => ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === 'FLAMES' &&
      node.expression.name.text === 'map');
    expect(frameMaps).toHaveLength(1);
    expect(tags(frameMaps[0], 'AtlasImage')).toHaveLength(1);
    expect(matchingNodes(flame, node => ts.isElementAccessExpression(node) && node.expression.getText() === 'FLAMES')).toHaveLength(0);
    expect(tags(flame, 'RadialGradient')).toHaveLength(1);
  });

  it('only mounts fire and glow for an actually burnt, visible marshmallow', () => {
    const sprite = namedFunction(character, 'CharacterSprite');
    const effects = matchingNodes(sprite, node => ts.isJsxExpression(node) && tags(node, 'MarshmallowFlame').length > 0);
    expect(effects).toHaveLength(1);
    const gates = matchingNodes(effects[0], node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) as ts.BinaryExpression[];
    expect(gates).toHaveLength(2);
    expect(matchingNodes(effects[0], ts.isIdentifier).map(node => (node as ts.Identifier).text)).toEqual(expect.arrayContaining(['burnt', 'showMarshmallow']));
  });

  it('uses a lifecycle-gated animation value rather than a React glow timer', () => {
    const glowCalls = calls(namedFunction(motion, 'useFireGlow'));
    expect(glowCalls.filter(call => tickingCalls.includes(call))).toEqual([]);
    expect(glowCalls).toContain('useVisibleAnimation');
    expect(glowCalls).toContain('timing');
    expect(glowCalls).toContain('loop');
    expect(calls(namedFunction(motion, 'useVisibleAnimation'))).toContain('useFocusEffect');
  });

  it('does not retain or consume the old whole-scene motion API', () => {
    const retired = new Set(['useFireMotion', 'sampleFireMotion', 'STILL_FIRE']);
    const violations: string[] = [];
    for (const path of sourcePaths(fileURLToPath(new URL('../', import.meta.url)))) {
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      if (matchingNodes(source, node => ts.isIdentifier(node) && retired.has(node.text)).length) violations.push(path);
    }
    expect(violations).toEqual([]);
  });
});
