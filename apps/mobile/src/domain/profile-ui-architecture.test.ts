/// <reference types="node" />

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function parse(path: string) {
  const url = new URL(path, import.meta.url);
  return ts.createSourceFile(url.pathname, readFileSync(url, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function collect(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = [];
  const visit = (child: ts.Node) => {
    if (predicate(child)) found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function tags(node: ts.Node, name: string) {
  return collect(node, candidate =>
    (ts.isJsxOpeningElement(candidate) || ts.isJsxSelfClosingElement(candidate)) && candidate.tagName.getText() === name,
  ) as (ts.JsxOpeningElement | ts.JsxSelfClosingElement)[];
}

function attribute(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
  const found = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText() === name);
  return found && ts.isJsxAttribute(found) ? found.initializer?.getText() : undefined;
}

const auth = parse('../components/auth-gate.tsx');
const settings = parse('../app/settings.tsx');
const keyboard = parse('../components/keyboard-form.tsx');

describe('name-only form regression guards', () => {
  it('contains exactly one name field in each onboarding step and Setup, with no handle state', () => {
    expect(tags(auth, 'KeyboardTextInput')).toHaveLength(2);
    expect(tags(settings, 'KeyboardTextInput')).toHaveLength(1);
    for (const source of [auth, settings]) {
      for (const input of tags(source, 'KeyboardTextInput')) {
        expect(attribute(input, 'accessibilityLabel')).toBe('"Your name"');
        expect(attribute(input, 'ref')).toBe('{inputRef}');
        expect(attribute(input, 'returnKeyType')).toBe('"done"');
      }
      expect(collect(source, node => ts.isIdentifier(node) && /^(handle|username|setHandle|setUsername)$/.test(node.text))).toHaveLength(0);
    }
  });

  it('wraps signup, completion, recovery, and Setup in bounded, growable keyboard forms', () => {
    expect(tags(auth, 'KeyboardForm')).toHaveLength(3);
    expect(tags(settings, 'KeyboardForm')).toHaveLength(1);
    expect(tags(keyboard, 'KeyboardAvoidingView')).toHaveLength(0);
    const scroll = tags(keyboard, 'ScrollView')[0];
    expect(attribute(scroll, 'keyboardShouldPersistTaps')).toBe('"handled"');
    expect(attribute(scroll, 'automaticallyAdjustKeyboardInsets')).toBe("{Platform.OS === 'ios'}");
    expect(attribute(scroll, 'onLayout')).toContain('scheduleReveal');
    expect(attribute(scroll, 'onContentSizeChange')).toContain('scheduleReveal');
  });

  it('offers an accessible dismiss control and retains immediate submit guards', () => {
    const dismiss = tags(keyboard, 'Pressable').find(node => attribute(node, 'accessibilityLabel') === '"Dismiss keyboard"');
    expect(dismiss).toBeDefined();
    expect(attribute(dismiss!, 'onPress')).toBe('{Keyboard.dismiss}');
    for (const source of [auth, settings]) {
      expect(collect(source, node => ts.isPropertyAccessExpression(node) && node.getText() === 'submitting.current').length).toBeGreaterThanOrEqual(3);
      expect(collect(source, node => ts.isCallExpression(node) && node.expression.getText() === 'Keyboard.dismiss').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps browser focus auto-scroll from dismissing the text input', () => {
    const mode = attribute(tags(keyboard, 'ScrollView')[0], 'keyboardDismissMode');
    expect(mode).toBe("{Platform.OS === 'ios' ? 'interactive' : Platform.OS === 'android' ? 'on-drag' : 'none'}");
  });

  it('keeps update recovery reachable outside the signed-in app', () => {
    expect(tags(auth, 'AppUpdateNotice')).toHaveLength(3);
    expect(tags(settings, 'AppUpdateNotice')).toHaveLength(1);
    expect(collect(auth, node => ts.isFunctionDeclaration(node) && node.name?.text === 'RecoverAccountScreen')).toHaveLength(1);
  });

  it('covers every current input, including the join-code field', () => {
    const sources = [auth, settings, parse('../app/friends.tsx'), parse('../app/requests.tsx'), parse('../app/index.tsx')];
    let inputs = 0;
    for (const source of sources) {
      expect(tags(source, 'TextInput'), source.fileName).toHaveLength(0);
      for (const input of tags(source, 'KeyboardTextInput')) {
        inputs += 1;
        expect(attribute(input, 'accessibilityLabel'), source.fileName).toBeDefined();
        let parent: ts.Node | undefined = input.parent;
        let hasForm = false;
        while (parent) {
          if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText() === 'KeyboardForm') hasForm = true;
          parent = parent.parent;
        }
        expect(hasForm, source.fileName).toBe(true);
      }
    }
    expect(inputs).toBe(5);
  });

  it('removes the circle reminder and its editor without removing request decisions', () => {
    const requests = parse('../components/circle-requests.tsx');
    expect(tags(requests, 'Modal')).toHaveLength(0);
    expect(tags(requests, 'KeyboardTextInput')).toHaveLength(0);
    expect(collect(requests, node => ts.isIdentifier(node) && /^(groupPolicy|updateGroupPolicy|policyOpen)$/.test(node.text))).toHaveLength(0);
    expect(requests.getText()).toContain("decide(request.id, 'approved')");
    expect(requests.getText()).toContain("decide(request.id, 'denied')");
    const circle = parse('../app/friends.tsx');
    expect(tags(circle, 'ScreenHeader')).toHaveLength(1);
    expect(tags(circle, 'CircleRequests')).toHaveLength(1);
    const legacyRoute = parse('../app/requests.tsx');
    expect(tags(legacyRoute, 'Redirect')).toHaveLength(1);
    expect(legacyRoute.getText()).toContain("pathname: '/friends', params: { section: 'requests' }");
  });

  it('rechecks focus and keyboard frame changes without polling the screen', () => {
    const input = tags(keyboard, 'TextInput')[0];
    expect(attribute(input, 'onFocus')).toContain('focus?.focus');
    expect(attribute(input, 'onSelectionChange')).toContain('focus?.reveal');
    const listeners = collect(keyboard, node => ts.isCallExpression(node) && node.expression.getText() === 'Keyboard.addListener') as ts.CallExpression[];
    expect(listeners.map(node => node.arguments[0].getText())).toEqual(expect.arrayContaining([
      "'keyboardDidShow'", "'keyboardWillChangeFrame'", "'keyboardDidChangeFrame'", "'keyboardWillHide'", "'keyboardDidHide'",
    ]));
    expect(collect(keyboard, node => ts.isCallExpression(node) && node.expression.getText() === 'setInterval')).toHaveLength(0);
  });
});
