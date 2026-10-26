import { APP_TOUR_STEP_COUNT, APP_TOUR_VERSION, appTourSlides, type TourActivity } from './app-tour-content';

export type TourCheckpoint = { version: number; skippedAt?: string; completedAt?: string };
export type TourState = { profileId: string | null; visible: boolean; step: number; activity?: TourActivity };
type Storage = { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<unknown> };

export function appTourStorageKey(profileId: string) {
  return `sumore:app-tour:v${APP_TOUR_VERSION}:${encodeURIComponent(profileId)}`;
}

export function parseTourCheckpoint(raw: string | null): TourCheckpoint | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<TourCheckpoint> | null;
    if (!value || value.version !== APP_TOUR_VERSION) return null;
    const validDate = (date: unknown): date is string => typeof date === 'string' && Number.isFinite(Date.parse(date));
    const skippedAt = validDate(value.skippedAt) ? value.skippedAt : undefined;
    const completedAt = validDate(value.completedAt) ? value.completedAt : undefined;
    return skippedAt || completedAt ? { version: APP_TOUR_VERSION, skippedAt, completedAt } : null;
  } catch { return null; }
}

/** Small external store so late storage reads cannot reopen a tour for another account. */
export function createAppTourState(storage: Storage, now = () => new Date().toISOString()) {
  let state: TourState = { profileId: null, visible: false, step: 0 };
  let generation = 0;
  let intent = 0;
  let writes: Promise<void> = Promise.resolve();
  const completedHere = new Set<string>();
  const listeners = new Set<() => void>();
  const update = (next: TourState) => { state = next; listeners.forEach(listener => listener()); };

  function bindProfile(profileId: string | null) {
    if (state.profileId === profileId) return;
    generation += 1;
    intent += 1;
    update({ profileId, visible: false, step: 0 });
    if (!profileId || completedHere.has(profileId)) return;
    const expectedGeneration = generation;
    const expectedIntent = intent;
    void storage.getItem(appTourStorageKey(profileId)).catch(() => null).then(raw => {
      if (generation !== expectedGeneration || intent !== expectedIntent || state.profileId !== profileId) return;
      if (!parseTourCheckpoint(raw)) update({ profileId, visible: true, step: 0 });
    });
  }

  function openTour() {
    if (!state.profileId) return;
    intent += 1;
    update({ profileId: state.profileId, visible: true, step: 0 });
  }

  function setStep(step: number) {
    if (!state.visible || !Number.isInteger(step)) return;
    update({ ...state, step: Math.max(0, Math.min(APP_TOUR_STEP_COUNT - 1, step)) });
  }

  function suspendActivity(activity: TourActivity, owner: string | null): boolean {
    if (!owner || state.profileId !== owner || !state.visible
      || appTourSlides('ios')[state.step]?.activity !== activity) return false;
    intent += 1;
    update({ ...state, visible: false, activity });
    return true;
  }

  function resumeActivity(owner: string | null, advance = true) {
    if (!owner || state.profileId !== owner || state.visible || !state.activity) return;
    intent += 1;
    update({ profileId: owner, visible: true, step: Math.min(APP_TOUR_STEP_COUNT - 1, state.step + (advance ? 1 : 0)) });
  }

  function complete(): Promise<void> {
    const profileId = state.profileId;
    if (!profileId || !state.visible || state.step !== APP_TOUR_STEP_COUNT - 1) return writes;
    intent += 1;
    completedHere.add(profileId);
    update({ ...state, visible: false });
    const timestamp = now();
    const key = appTourStorageKey(profileId);
    // Each write captures its owner. Replay completion preserves the earlier
    // skip timestamp, and changing accounts cannot redirect an in-flight save.
    writes = writes.then(async () => {
      const previous = parseTourCheckpoint(await storage.getItem(key).catch(() => null));
      const next = { ...previous, version: APP_TOUR_VERSION, completedAt: timestamp };
      await storage.setItem(key, JSON.stringify(next));
    }).catch(() => {
      // A preference write must never trap someone in onboarding. This visit
      // stays completed; an unavailable store may show the tour next launch.
    });
    return writes;
  }

  function invalidate() {
    generation += 1;
    intent += 1;
    update({ profileId: null, visible: false, step: 0 });
  }

  return { bindProfile, openTour, setStep, suspendActivity, resumeActivity, complete, invalidate,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
