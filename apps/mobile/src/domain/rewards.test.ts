/// <reference types="node" />

import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { nextSMoreProgress, SMORE_REWARD_EXPLANATION, sMoreRewardLabel } from './rewards';
import type { CircleShop } from './circle-shop';

const shop: CircleShop = {
  id: 'circle', name: 'Our circle', balance: 99, unlocked: [], background: 'forest',
  localDate: '2026-09-17', timeZone: 'America/Los_Angeles', askedToday: false, eligibleToday: true,
  dayStartedAt: '2026-09-17T07:00:00Z', nextAwardAt: '2026-09-18T07:00:00Z',
};

describe('s’more reward presentation', () => {
  it.each([
    [0, '0 circle s’mores'],
    [1, '1 circle s’more'],
    [99, '99 circle s’mores'],
  ])('describes %s rewards without changing the authoritative count', (count, label) => {
    expect(sMoreRewardLabel(count as number)).toBe(label);
  });

  it('shows only the shared wallet and keeps the original reward sprite', () => {
    const source = readFileSync(new URL('../app/index.tsx', import.meta.url), 'utf8');
    const parsed = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let spriteCount = 0;
    const visibleCopy: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(parsed) === 'SMoreSprite') spriteCount += 1;
      if (ts.isJsxText(node) || ts.isStringLiteral(node)) visibleCopy.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    expect(spriteCount).toBe(1);
    expect(visibleCopy.join(' ')).toContain('Circle s’mores');
    expect(visibleCopy.join(' ')).not.toMatch(/golden marshmallow/i);
    expect(source).toContain("circleShop?.balance ?? '—'");
    expect(source).toContain('sMoreRewardLabel(circleShop.balance)');
    expect(source).toContain('Customize camper');
    expect(source).toContain('Your circle misses today’s s’more');
    expect(source).toContain('even if cancelled or denied');
    expect(source).not.toMatch(/you\?\.golden|campfire\.groupGolden/);
    expect(source).toContain('nextSMoreProgress(circleShop, now)');
  });

  it('uses the same circle’s chosen campsite in the Home and Circle renderer', () => {
    const source = readFileSync(new URL('../components/campfire.tsx', import.meta.url), 'utf8');
    expect(source).toContain('const { circleShop } = useApp()');
    expect(source).toContain("background={background ?? circleShop?.background ?? 'forest'}");
  });

  it('shows elapsed group day from server boundaries, not measured app usage', () => {
    const result = nextSMoreProgress(shop, new Date('2026-09-17T19:00:00Z'));
    expect(result).toEqual({ fraction: 0.5, label: 'Keep the whole circle request-free', state: 'earning' });
    expect(nextSMoreProgress(shop, new Date(shop.dayStartedAt)).fraction).toBe(0);
    expect(nextSMoreProgress(shop, new Date('2026-09-18T06:59:59Z')).fraction).toBeLessThan(1);
  });

  it('stops the whole group after any member asks, even with a later next award', () => {
    const asked = { ...shop, askedToday: true, nextAwardAt: '2026-09-19T07:00:00Z' };
    expect(nextSMoreProgress(asked, new Date('2026-09-17T19:00:00Z')))
      .toEqual({ fraction: 0, label: 'Fresh start tomorrow', state: 'burnt' });
  });

  it('waits for the first complete day rather than rewarding a partial joining day', () => {
    const partial = { ...shop, eligibleToday: false, nextAwardAt: '2026-09-19T07:00:00Z' };
    expect(nextSMoreProgress(partial, new Date('2026-09-17T19:00:00Z')))
      .toEqual({ fraction: 0, label: 'Starts tomorrow', state: 'waiting' });
    expect(nextSMoreProgress({ ...partial, askedToday: true }, new Date('2026-09-17T19:00:00Z')).label).toBe('Starts tomorrow');
  });

  it('uses the circle timezone even when the phone or UTC has reached a different date', () => {
    const now = new Date('2026-09-18T02:00:00Z');
    expect(now.toISOString().slice(0, 10)).not.toBe(shop.localDate);
    expect(nextSMoreProgress(shop, now).fraction).toBeCloseTo(19 / 24);
    expect(nextSMoreProgress({ ...shop, timeZone: 'Asia/Tokyo' }, now).state).toBe('loading');
  });

  it.each([
    ['2026-03-08', '2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z', '2026-03-08T19:30:00Z'],
    ['2026-11-01', '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z', '2026-11-01T19:30:00Z'],
  ])('respects server boundaries on the short or long DST day %s', (localDate, dayStartedAt, nextAwardAt, midpoint) => {
    expect(nextSMoreProgress({ ...shop, localDate, dayStartedAt, nextAwardAt }, new Date(midpoint)).fraction).toBe(0.5);
  });

  it('waits for a new server snapshot at rollover instead of awarding locally', () => {
    const unchanged = structuredClone(shop);
    expect(nextSMoreProgress(shop, new Date(shop.nextAwardAt)).state).toBe('loading');
    expect(nextSMoreProgress({ ...shop, nextAwardAt: '2026-09-19T07:00:00Z' }, new Date('2026-09-18T12:00:00Z')).state).toBe('loading');
    expect(shop).toEqual(unchanged);
    expect(shop.balance).toBe(99);
  });

  it('does not invent progress when the wallet, dates, clock, or timezone are unavailable', () => {
    const now = new Date('2026-09-17T19:00:00Z');
    expect(nextSMoreProgress(undefined, now).state).toBe('loading');
    expect(nextSMoreProgress(shop, new Date('invalid')).state).toBe('loading');
    for (const override of [
      { localDate: '2026-09-18' }, { localDate: 'invalid' }, { dayStartedAt: 'invalid' },
      { nextAwardAt: shop.dayStartedAt }, { dayStartedAt: '2026-09-17T20:00:00Z' },
      { timeZone: 'Not/A_Timezone' },
    ]) expect(nextSMoreProgress({ ...shop, ...override }, now).state).toBe('loading');
  });

  it('describes one whole-circle no-request day without claiming measured usage', () => {
    expect(SMORE_REWARD_EXPLANATION).toContain('one s’more');
    expect(SMORE_REWARD_EXPLANATION).toContain('everyone goes a full day without asking');
    expect(SMORE_REWARD_EXPLANATION).not.toMatch(/past year|below.*limit|measured|—/i);
  });
});
