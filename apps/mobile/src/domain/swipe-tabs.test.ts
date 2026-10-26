import { describe, expect, it } from 'vitest';

import { getSwipeTabRoutes, MAIN_TAB_NAMES } from './swipe-tabs';

describe('main swipe destinations', () => {
  it('uses the four explicit main routes in visible tab order', () => {
    expect(MAIN_TAB_NAMES).toEqual(['index', 'screen-time', 'friends', 'settings']);
    const routes = ['customize', 'settings', 'requests', 'friends', 'index', 'screen-time', 'modal']
      .map(name => ({ name, key: `${name}-key` }));
    expect(getSwipeTabRoutes(routes).map(route => route.name)).toEqual(MAIN_TAB_NAMES);
  });

  it('preserves the router objects, keys, and deep-link params without mutating its order', () => {
    const params = Object.freeze({ section: 'friends', invite: '1' });
    const friends = Object.freeze({ name: 'friends', key: 'friends-existing', params });
    const camp = Object.freeze({ name: 'index', key: 'camp-existing' });
    const routes = Object.freeze([friends, camp]);
    const result = getSwipeTabRoutes(routes);
    expect(result).toEqual([camp, friends]);
    expect(result[0]).toBe(camp);
    expect(result[1]).toBe(friends);
    expect('params' in result[1] ? result[1].params : undefined).toBe(params);
    expect(routes).toEqual([friends, camp]);
  });

  it('does not synthesize missing routes or admit hidden routes with similar names', () => {
    expect(getSwipeTabRoutes([])).toEqual([]);
    expect(getSwipeTabRoutes([
      { name: 'screen-time/settings' }, { name: 'customize' }, { name: 'requests' }, { name: 'friends' },
    ])).toEqual([{ name: 'friends' }]);
  });

  it('does not create duplicate pager destinations for duplicate route names', () => {
    const first = { name: 'friends', key: 'first' };
    expect(getSwipeTabRoutes([first, { name: 'friends', key: 'second' }])).toEqual([first]);
  });
});
