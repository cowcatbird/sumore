/** Auxiliary routes such as the store are deliberately not swipe destinations. */
export const MAIN_TAB_NAMES = ['index', 'screen-time', 'friends', 'settings'] as const;

export function getSwipeTabRoutes<T extends { name: string }>(routes: readonly T[]): T[] {
  return MAIN_TAB_NAMES.flatMap(name => {
    const route = routes.find(candidate => candidate.name === name);
    return route ? [route] : [];
  });
}
