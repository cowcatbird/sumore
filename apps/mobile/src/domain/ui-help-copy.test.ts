/// <reference types="node" />
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SMORE_REWARD_EXPLANATION } from './rewards';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

function helps(path: string) {
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: { title: string; paragraphs: string[] }[] = [];
  const text = (node: ts.Node): string => {
    if (ts.isJsxText(node) || ts.isStringLiteral(node)) return node.text.trim();
    if (ts.isIdentifier(node) && node.text === 'SMORE_REWARD_EXPLANATION') return SMORE_REWARD_EXPLANATION;
    const words: string[] = [];
    ts.forEachChild(node, child => { const value = text(child); if (value) words.push(value); });
    return words.join(' ');
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === 'HelpButton') {
      const title = node.openingElement.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(file) === 'title');
      const label = title && ts.isJsxAttribute(title) && title.initializer && ts.isStringLiteral(title.initializer) ? title.initializer.text : 'user-authored';
      result.push({ title: label, paragraphs: node.children.filter(ts.isJsxElement).map(child => child.children.map(text).join(' ').trim()) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

describe('minimal help copy', () => {
  it('removes Name, Notifications and Your camper help, including the signup name popup', () => {
    const titles = ['../app/settings.tsx', '../app/customize.tsx', '../components/auth-gate.tsx'].flatMap(path => helps(path).map(help => help.title));
    expect(titles).not.toContain('Your name');
    expect(titles).not.toContain('Notifications');
    expect(titles).not.toContain('Your camper');
    expect(titles).not.toContain('Your account');
    const auth = source('../components/auth-gate.tsx');
    expect(auth).not.toContain('Pick a name your friends recognize');
    expect(auth).not.toContain('Up to {MAX_DISPLAY_NAME_LENGTH} characters.');
    expect(auth).toContain('Save your private login key in Setup to recover your account later.');
  });

  it.each(['../app/index.tsx', '../app/friends.tsx', '../components/circle-requests.tsx', '../components/screen-time-controls.tsx'])(
    'keeps authored help to three short paragraphs without em dashes: %s', path => {
      for (const help of helps(path).filter(help => help.title !== 'user-authored')) {
        expect(help.paragraphs.length, help.title).toBeLessThanOrEqual(3);
        for (const paragraph of help.paragraphs) {
          expect(paragraph.split(/\s+/).length, help.title).toBeLessThanOrEqual(25);
          expect(paragraph, help.title).not.toContain('—');
        }
      }
    },
  );

  it('preserves critical device consent, safety, account-loss and request information', () => {
    const blocking = source('../components/screen-time-controls.tsx');
    for (const phrase of ['your selected apps, not your circle', 'App choices stay on this device', 'Earlier use today counts when supported', 'this device receives it', '30-second confirmation', 'revoke access', 'phone’s Settings']) expect(blocking).toContain(phrase);
    const settings = source('../app/settings.tsx');
    expect(source('../components/account-controls.tsx')).toContain('Anyone with this key can sign in as you');
    expect(source('../services/notifications.ts')).toContain('Permission is off in phone Settings.');
    expect(settings).toContain('accessibilityRole="alert"');
    const home = source('../app/index.tsx');
    for (const phrase of ['five per hour', 'expire in 20 minutes', 'even if denied or cancelled', 'Your circle misses today’s s’more', 'SMORE_REWARD_EXPLANATION']) expect(home).toContain(phrase);
    expect(SMORE_REWARD_EXPLANATION).toContain('everyone goes a full day without asking for time');
    expect(SMORE_REWARD_EXPLANATION).toContain('one s’more');
    expect(home).not.toContain('Totals cover the past year');
    expect(SMORE_REWARD_EXPLANATION).not.toMatch(/measured usage|under.*limit|past year/i);
    const circle = source('../app/friends.tsx');
    expect(circle).toContain('Share codes only with trusted friends.');
    expect(circle).toContain('App selections and usage stay private.');
  });
});
