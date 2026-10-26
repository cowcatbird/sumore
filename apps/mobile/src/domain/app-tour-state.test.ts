import { describe, expect, it, vi } from 'vitest';

import { APP_TOUR_STEP_COUNT, APP_TOUR_VERSION } from './app-tour-content';
import { appTourStorageKey, createAppTourState, parseTourCheckpoint } from './app-tour-state';

const finalStep = APP_TOUR_STEP_COUNT - 1;
const now = '2026-09-14T12:00:00.000Z';
const completed = JSON.stringify({ version: APP_TOUR_VERSION, completedAt: now });
const tick = () => new Promise<void>(resolve => { queueMicrotask(() => queueMicrotask(resolve)); });
function harness() {
  const values = new Map<string, string>();
  const storage = { getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { values.set(key, value); }) };
  const tour = createAppTourState(storage, () => now);
  return { storage, values, tour };
}

describe('profile-scoped tour preferences', () => {
  it('exposes no skip or dismissal shortcut', () => {
    const { tour } = harness();
    expect(tour).not.toHaveProperty('skip');
    expect(tour).not.toHaveProperty('dismiss');
  });

  it.each([['friends', 0], ['customize', 4]] as const)('pauses %s without a checkpoint and continues to the next slide exactly once', async (activity, step) => {
    const { tour, storage, values } = harness();
    tour.bindProfile('person-a'); await tick(); tour.setStep(step);
    expect(tour.suspendActivity(activity, 'person-a')).toBe(true);
    expect(tour.suspendActivity(activity, 'person-a')).toBe(false);
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: false, step, activity });
    tour.bindProfile('person-a'); tour.setStep(3); await tour.complete();
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: false, step, activity });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
    tour.resumeActivity('person-a'); tour.resumeActivity('person-a');
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: true, step: step + 1 });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('rejects activity callbacks from another profile or the wrong slide', async () => {
    const { tour } = harness();
    tour.bindProfile('person-a'); await tick();
    expect(tour.suspendActivity('customize', 'person-a')).toBe(false);
    expect(tour.suspendActivity('friends', 'person-b')).toBe(false);
    expect(tour.suspendActivity('friends', null)).toBe(false);
    tour.suspendActivity('friends', 'person-a');
    tour.resumeActivity('person-b');
    expect(tour.getSnapshot().activity).toBe('friends');
    tour.bindProfile('person-b'); await tick();
    tour.resumeActivity('person-a');
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-b', visible: true, step: 0 });
  });

  it('can recover a failed activity navigation at the same slide and resets an activity on replay or invalidation', async () => {
    const { tour } = harness();
    tour.bindProfile('person-a'); await tick(); tour.setStep(4);
    tour.suspendActivity('customize', 'person-a'); tour.resumeActivity('person-a', false);
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: true, step: 4 });
    tour.suspendActivity('customize', 'person-a'); tour.openTour();
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: true, step: 0 });
    tour.suspendActivity('friends', 'person-a'); tour.invalidate(); tour.resumeActivity('person-a');
    expect(tour.getSnapshot()).toEqual({ profileId: null, visible: false, step: 0 });
  });

  it('does not let a pending storage read reopen an activity', async () => {
    const { tour, storage } = harness();
    const read = Promise.withResolvers<string | null>();
    storage.getItem.mockReturnValueOnce(read.promise);
    tour.bindProfile('person-a'); tour.openTour();
    tour.suspendActivity('friends', 'person-a');
    read.resolve(null); await tick();
    expect(tour.getSnapshot().visible).toBe(false);
    expect(tour.getSnapshot().activity).toBe('friends');
  });

  it('does not read storage until a ready profile is bound, then auto-opens once', async () => {
    const { tour, storage } = harness();
    tour.bindProfile(null);
    expect(storage.getItem).not.toHaveBeenCalled();
    tour.bindProfile('person-a');
    await tick();
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: true, step: 0 });
    tour.bindProfile('person-a');
    expect(storage.getItem).toHaveBeenCalledTimes(1);
  });

  it.each(['skippedAt', 'completedAt'])('does not auto-open a tour with saved %s, but allows explicit replay', async field => {
    const { tour, values } = harness();
    values.set(appTourStorageKey('person-a'), JSON.stringify({ version: APP_TOUR_VERSION, [field]: now }));
    tour.bindProfile('person-a');
    await tick();
    expect(tour.getSnapshot().visible).toBe(false);
    tour.openTour();
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: true, step: 0 });
  });

  it.each(Array.from({ length: finalStep }, (_, step) => step))('does not close or write completion from step %s', async step => {
    const { tour, storage, values } = harness();
    tour.bindProfile('person-a');
    await tick();
    tour.setStep(step);
    await tour.complete();
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: true, step });
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
    expect(tour).not.toHaveProperty('dismiss');
  });

  it('only completes the final step and writes no new skip timestamp', async () => {
    const { tour, storage, values } = harness();
    tour.bindProfile('person-a');
    await tick();
    tour.setStep(finalStep);
    await tour.complete();
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: false, step: finalStep });
    expect(JSON.parse(values.get(appTourStorageKey('person-a'))!)).toEqual({ version: APP_TOUR_VERSION, completedAt: now });
    await tour.complete();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('does not complete an unbound or closed tour', async () => {
    const { tour, storage, values } = harness();
    await tour.complete();
    expect(storage.getItem).not.toHaveBeenCalled();
    values.set(appTourStorageKey('person-a'), completed);
    tour.bindProfile('person-a');
    await tick();
    tour.setStep(finalStep);
    await tour.complete();
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: false, step: 0 });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('preserves a legacy skip timestamp when an explicit replay is completed', async () => {
    const { tour, values } = harness();
    const skippedAt = '2026-09-13T12:00:00.000Z';
    values.set(appTourStorageKey('person-a'), JSON.stringify({ version: APP_TOUR_VERSION, skippedAt }));
    tour.bindProfile('person-a');
    await tick();
    expect(tour.getSnapshot().visible).toBe(false);
    tour.openTour();
    tour.setStep(finalStep);
    await tour.complete();
    expect(parseTourCheckpoint(values.get(appTourStorageKey('person-a'))!)).toEqual({ version: APP_TOUR_VERSION, skippedAt, completedAt: now });
  });

  it('never opens for a stale profile or after cleanup', async () => {
    const { tour, storage, values } = harness();
    const first = Promise.withResolvers<string | null>();
    storage.getItem.mockReturnValueOnce(first.promise);
    values.set(appTourStorageKey('person-b'), completed);
    tour.bindProfile('person-a');
    tour.bindProfile('person-b');
    await tick();
    first.resolve(null);
    await tick();
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-b', visible: false, step: 0 });
    const afterCleanup = Promise.withResolvers<string | null>();
    storage.getItem.mockReturnValueOnce(afterCleanup.promise);
    tour.bindProfile('person-c');
    tour.invalidate();
    afterCleanup.resolve(null);
    await tick();
    expect(tour.getSnapshot()).toEqual({ profileId: null, visible: false, step: 0 });
  });

  it('does not let a pending initial read reset a manually opened tour', async () => {
    const { tour, storage } = harness();
    const read = Promise.withResolvers<string | null>();
    storage.getItem.mockReturnValueOnce(read.promise);
    tour.bindProfile('person-a');
    tour.openTour();
    tour.setStep(3);
    read.resolve(null);
    await tick();
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: true, step: 3 });
  });

  it('keeps an in-flight completion bound to its original profile', async () => {
    const { tour, storage, values } = harness();
    tour.bindProfile('person-a');
    await tick();
    const writeRead = Promise.withResolvers<string | null>();
    storage.getItem.mockReturnValueOnce(writeRead.promise);
    tour.setStep(finalStep);
    const saving = tour.complete();
    await tick();
    tour.bindProfile('person-b');
    await tick();
    writeRead.resolve(null);
    await saving;
    expect(values.has(appTourStorageKey('person-a'))).toBe(true);
    expect(values.has(appTourStorageKey('person-b'))).toBe(false);
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-b', visible: true, step: 0 });
  });

  it('does not let a pending initial read reopen a completed tour', async () => {
    const { tour, storage } = harness();
    const read = Promise.withResolvers<string | null>();
    storage.getItem.mockReturnValueOnce(read.promise);
    tour.bindProfile('person-a');
    tour.openTour();
    tour.setStep(finalStep);
    await tour.complete();
    read.resolve(null);
    await tick();
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-a', visible: false, step: finalStep });
  });

  it('serializes queued completions without mixing profile checkpoints', async () => {
    const { tour, storage, values } = harness();
    tour.bindProfile('person-a');
    await tick();
    const writeRead = Promise.withResolvers<string | null>();
    storage.getItem.mockReturnValueOnce(writeRead.promise);
    tour.setStep(finalStep);
    const savingA = tour.complete();
    await tick();
    tour.bindProfile('person-b');
    await tick();
    tour.setStep(finalStep);
    const savingB = tour.complete();
    expect(storage.setItem).not.toHaveBeenCalled();
    writeRead.resolve(null);
    await Promise.all([savingA, savingB]);
    expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([appTourStorageKey('person-a'), appTourStorageKey('person-b')]);
    expect(values.get(appTourStorageKey('person-a'))).toBe(completed);
    expect(values.get(appTourStorageKey('person-b'))).toBe(completed);
    expect(tour.getSnapshot()).toEqual({ profileId: 'person-b', visible: false, step: finalStep });
  });

  it('allows final completion despite broken storage and does not reopen during the same visit', async () => {
    const { tour, storage } = harness();
    storage.getItem.mockRejectedValue(new Error('Unavailable storage'));
    storage.setItem.mockRejectedValue(new Error('Storage full'));
    tour.bindProfile('person-a');
    await tick();
    expect(tour.getSnapshot().visible).toBe(true);
    tour.setStep(finalStep);
    await expect(tour.complete()).resolves.toBeUndefined();
    expect(tour.getSnapshot().visible).toBe(false);
    tour.invalidate();
    tour.bindProfile('person-a');
    await tick();
    expect(tour.getSnapshot().visible).toBe(false);
  });

  it('recovers the write queue after a failed completion save', async () => {
    const { tour, storage, values } = harness();
    storage.setItem.mockRejectedValueOnce(new Error('Storage full'));
    tour.bindProfile('person-a');
    await tick();
    tour.setStep(finalStep);
    await tour.complete();
    expect(values.has(appTourStorageKey('person-a'))).toBe(false);
    tour.openTour();
    tour.setStep(finalStep);
    await tour.complete();
    expect(values.get(appTourStorageKey('person-a'))).toBe(completed);
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('clamps navigation and does not move a closed tour', async () => {
    const { tour } = harness();
    tour.setStep(finalStep);
    expect(tour.getSnapshot().step).toBe(0);
    tour.bindProfile('person-a');
    await tick();
    tour.setStep(99);
    expect(tour.getSnapshot().step).toBe(finalStep);
    tour.setStep(-2);
    expect(tour.getSnapshot().step).toBe(0);
    tour.setStep(Number.NaN);
    expect(tour.getSnapshot().step).toBe(0);
  });

  it('uses versioned, collision-safe per-profile keys and rejects bad checkpoints', () => {
    expect(appTourStorageKey('a:b')).not.toBe(appTourStorageKey('a%3Ab'));
    expect(appTourStorageKey('person-a')).not.toBe(appTourStorageKey('person-b'));
    for (const raw of [null, '', 'bad json', '{}', '{"version":0,"completedAt":"2026-09-14"}', '{"version":1,"completedAt":"not a date"}']) {
      expect(parseTourCheckpoint(raw)).toBeNull();
    }
    expect(parseTourCheckpoint(completed)?.completedAt).toBe(now);
  });
});
