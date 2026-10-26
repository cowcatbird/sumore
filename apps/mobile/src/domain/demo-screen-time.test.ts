import { describe, expect, it } from 'vitest';

import { createDemoLimitState, demoAskBlockReason, demoLimitBaseTotal, demoLimitReducer, demoLimitRemaining,
  demoLimitTotal, parseDemoMinutes, type DemoAction, type DemoApp, type DemoState } from './demo-screen-time';

const apply = (state: DemoState, ...actions: DemoAction[]) => actions.reduce(demoLimitReducer, state);
const selected = () => apply(createDemoLimitState(), { type: 'toggle', app: 'Games' });
const exhausted = () => apply(selected(), { type: 'minutes', minutes: 7 }, { type: 'enable' }, { type: 'simulate' }, { type: 'simulate' });

describe('pure simulated screen time', () => {
  it('starts off without selected apps and requires setup before requests', () => {
    const state = createDemoLimitState();
    expect(state).toMatchObject({ apps: [], enabled: false, used: 0, approvedMinutes: 0 });
    expect(demoAskBlockReason(state)).toContain('Set up a daily allowance');
    expect(demoLimitReducer(state, { type: 'enable' })).toBe(state);
    expect(demoLimitReducer(state, { type: 'simulate' })).toBe(state);
    expect(demoLimitReducer(state, { type: 'grant', minutes: 15 })).toBe(state);
  });

  it('clamps five-minute usage to a custom budget and only permits asking at zero', () => {
    let state = apply(selected(), { type: 'minutes', minutes: 7 }, { type: 'enable' });
    expect(demoAskBlockReason(state)).toContain('remaining time');
    state = demoLimitReducer(state, { type: 'simulate' });
    expect(state.used).toBe(5); expect(demoLimitRemaining(state)).toBe(2);
    state = demoLimitReducer(state, { type: 'simulate' });
    expect(state.used).toBe(7); expect(demoLimitRemaining(state)).toBe(0);
    expect(demoAskBlockReason(state)).toBeNull();
    expect(demoLimitReducer(state, { type: 'simulate' }).used).toBe(7);
    expect(demoLimitReducer(state, { type: 'enable' })).toBe(state);
  });

  it.each([5, 10, 15, 30])('adds exactly %s approved minutes without resetting already consumed minutes', minutes => {
    const state = demoLimitReducer(exhausted(), { type: 'grant', minutes });
    expect(state.used).toBe(7); expect(state.approvedMinutes).toBe(minutes);
    expect(demoLimitBaseTotal(state)).toBe(7); expect(demoLimitTotal(state)).toBe(7 + minutes);
    expect(demoLimitRemaining(state)).toBe(minutes);
    expect(demoLimitRemaining(state) / demoLimitTotal(state)).toBe(minutes / (7 + minutes));
    expect(demoAskBlockReason(state)).toContain('remaining time');
    let consumed = state;
    for (let n = 0; n < minutes / 5; n++) consumed = demoLimitReducer(consumed, { type: 'simulate' });
    expect(consumed.used).toBe(7 + minutes); expect(demoAskBlockReason(consumed)).toBeNull();
  });

  it.each([-1, 0, 7, 15.5, 1440, NaN, Infinity])('rejects invalid grant %s', minutes => {
    const state = exhausted(); expect(demoLimitReducer(state, { type: 'grant', minutes })).toBe(state);
  });

  it('accumulates multiple approvals against unchanged base and actual used total', () => {
    const state = apply(exhausted(), { type: 'grant', minutes: 5 }, { type: 'simulate' }, { type: 'grant', minutes: 15 });
    expect(state).toMatchObject({ used: 12, approvedMinutes: 20 });
    expect(demoLimitBaseTotal(state)).toBe(7); expect(demoLimitTotal(state)).toBe(27); expect(demoLimitRemaining(state)).toBe(15);
  });

  it('uses the sum of selected per-app budgets plus bonus and leaves unselected budgets unchanged', () => {
    let state = apply(selected(), { type: 'toggle', app: 'Social feed' },
      { type: 'perApp', allocations: { Games: 8, 'Social feed': 7, 'Short videos': undefined } });
    expect(state.enabled).toBe(true); expect(state.mode).toBe('perApp');
    expect(state.allocations['Short videos']).toBe(30);
    expect(demoLimitBaseTotal(state)).toBe(15);
    state = apply(state, { type: 'simulate' }, { type: 'simulate' }, { type: 'simulate' }, { type: 'grant', minutes: 10 });
    expect(state.used).toBe(15); expect(demoLimitTotal(state)).toBe(25); expect(demoLimitRemaining(state)).toBe(10);
  });

  it('rejects partial/invalid per-app configurations and unknown app IDs', () => {
    const state = apply(selected(), { type: 'toggle', app: 'Social feed' });
    expect(demoLimitReducer(state, { type: 'perApp', allocations: { Games: 7 } })).toBe(state);
    expect(demoLimitReducer(state, { type: 'perApp', allocations: { Games: 7, 'Social feed': 0 } })).toBe(state);
    expect(demoLimitReducer(state, { type: 'toggle', app: 'Unknown' as DemoApp })).toBe(state);
  });

  it('stopping makes requests ineligible and restarting clears old usage and bonus', () => {
    const granted = apply(exhausted(), { type: 'grant', minutes: 15 });
    const stopped = demoLimitReducer(granted, { type: 'stop' });
    expect(stopped.enabled).toBe(false); expect(demoAskBlockReason(stopped)).toContain('Set up');
    expect(demoLimitReducer(stopped, { type: 'simulate' })).toBe(stopped);
    expect(demoLimitReducer(stopped, { type: 'grant', minutes: 10 })).toBe(stopped);
    const enabled = demoLimitReducer(stopped, { type: 'enable' });
    expect(enabled).toMatchObject({ used: 0, approvedMinutes: 0, enabled: true });
    expect(demoLimitTotal(enabled)).toBe(7);
  });

  it.each([
    { type: 'minutes', minutes: 11 }, { type: 'toggle', app: 'Social feed' },
    { type: 'perApp', allocations: { Games: 18 } }, { type: 'reset' },
  ] satisfies DemoAction[])('reconfiguration %j clears prior usage and bonus', action => {
    const stopped = apply(exhausted(), { type: 'grant', minutes: 15 }, { type: 'stop' });
    const next = demoLimitReducer(stopped, action);
    expect(next).toMatchObject({ used: 0, approvedMinutes: 0 });
    if (action.type === 'reset') expect(next).toEqual(createDemoLimitState());
  });

  it.each(['', '0', '-1', '1441', '2.5', '1e2', ' 15', '15 ', 'NaN', 'Infinity'])('rejects invalid custom minutes %j', text => {
    expect(parseDemoMinutes(text)).toBeNull();
  });
  it.each(['1', '17', '30', '239', '1440'])('accepts whole custom minutes %s', text => {
    expect(parseDemoMinutes(text)).toBe(Number(text));
  });
});
