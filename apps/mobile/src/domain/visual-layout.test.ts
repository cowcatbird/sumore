import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { AppColorsDark, Radius, Shadow, Space, Type } from '@/constants/theme';
import { formControlStyle } from '@/constants/form-layout';

vi.mock('react-native', () => ({
  Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
}));

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// Evaluate the real style factory without mounting data providers or native features.
function stylesFor(path: string) {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const factory = source.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => declaration.name.getText(source) === 'createStyles');
  if (!factory) throw new Error(`Missing style factory in ${path}`);
  return runInNewContext(`${ts.transpile(`const ${factory.getText(source)};`)}; createStyles(c);`, {
    c: AppColorsDark, Radius, Shadow, Space, Type, formControlStyle, StyleSheet: { create: (styles: unknown) => styles },
  }) as Record<string, Record<string, unknown>>;
}

describe('polished page geometry', () => {
  const camp = stylesFor('../app/index.tsx');
  const circle = stylesFor('../app/friends.tsx');

  it('keeps secondary camp controls at least 44 points tall', () => {
    for (const name of ['dressUp', 'motionButton', 'walletLink', 'countChip', 'takeBack', 'askPlate']) {
      expect(camp[name].minHeight).toBeGreaterThanOrEqual(44);
    }
    expect(camp.closeButton.width).toBeGreaterThanOrEqual(44);
    expect(camp.closeButton.height).toBeGreaterThanOrEqual(44);
    expect(circle.closeButton.width).toBeGreaterThanOrEqual(44);
    expect(circle.closeButton.height).toBeGreaterThanOrEqual(44);
  });

  it('allows enlarged labels and request options to grow instead of clipping', () => {
    expect(camp.brandRow.flexWrap).toBe('wrap');
    expect(camp.clearingHeading.flexWrap).toBe('wrap');
    expect(camp.option.height).toBeUndefined();
    expect(camp.option.minHeight).toBeGreaterThanOrEqual(96);
    expect(circle.section.height).toBeUndefined();
    expect(circle.person.height).toBeUndefined();
  });

  it('retains 44-point Circle targets without turning every row into a filled button', () => {
    for (const name of ['section', 'codePlate', 'inviteButton']) {
      expect(circle[name].minHeight).toBeGreaterThanOrEqual(44);
      expect(circle[name].height).toBeUndefined();
    }
    expect(circle.section.backgroundColor).toBeUndefined();
    expect(circle.person.backgroundColor).toBeUndefined();
    expect(circle.person.borderRadius).toBeUndefined();
    expect(circle.inviteButton.backgroundColor).toBe(AppColorsDark.ember);
    expect(circle.inviteCard.backgroundColor).toBe(AppColorsDark.wool);
    expect(circle.inviteCard.borderTopColor).toBe(AppColorsDark.emberLow);
  });

  it('lets Circle headings, long names and revealed codes wrap around their controls', () => {
    expect(circle.rosterHeading.flexWrap).toBe('wrap');
    expect(circle.section.flexWrap).toBe('wrap');
    expect(circle.codePlate.flexWrap).toBe('wrap');
    expect(circle.codeValueRow.flexShrink).toBe(1);
    expect(circle.codePlateValue.flexShrink).toBe(1);
    expect(circle.personCopy).toMatchObject({ flex: 1, minWidth: 0 });
    expect(circle.personName.height).toBeUndefined();
    expect(circle.addCopy).toMatchObject({ flex: 1, minWidth: 0 });
    expect(circle.inviteButtonText.flexShrink).toBe(1);
    expect(circle.tag.width).toBe(44);
    expect(circle.tag.height).toBe(44);
  });

  it('keeps the unfilled progress track visible against its card', () => {
    expect(camp.progressTrack.backgroundColor).not.toBe(camp.progressCard.backgroundColor);
    expect(camp.progressFill.backgroundColor).toBe(AppColorsDark.ember);
  });

  it('retains the page-title band and adds a semantic heading without fixed heights', () => {
    const header = read('../components/screen-header.tsx');
    expect(header).toContain('accessibilityRole="header"');
    expect(header).toContain('<BlanketBand />');
    const styles = stylesFor('../components/screen-header.tsx');
    expect(styles.header.height).toBeUndefined();
    expect(styles.headingRow.height).toBeUndefined();
  });

  it('gives every tab the same highlight wrapper without altering glyph alignment', () => {
    const layout = read('../app/_layout.tsx');
    const light = read('../components/tab-light.tsx');
    expect(layout.match(/<TabLightIcon routeName="[^"]+" focused=\{focused\}/g)).toHaveLength(4);
    expect(light).toContain('width: 44, height: 26');
    expect(layout.match(/translateY: 2/g)).toHaveLength(1);
  });
});
