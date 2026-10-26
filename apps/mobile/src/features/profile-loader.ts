import { withAccountTimeout } from '@/lib/account-timeout';
import type { AppSnapshot } from '@/types/domain';

export { ACCOUNT_LOAD_TIMEOUT_MS, withAccountTimeout } from '@/lib/account-timeout';

/**
 * Polls, foreground events, and realtime can request the same profile at once.
 * Share those reads, but wait for an older read before refreshing a saved edit.
 * A signed-out or different account must never receive an old read's result.
 */
export function createProfileLoader({
  load,
  onSnapshot,
  onLoading,
}: {
  load: () => Promise<AppSnapshot>;
  onSnapshot: (snapshot: AppSnapshot) => void;
  onLoading: (loading: boolean) => void;
}) {
  let userId: string | null = null;
  let generation = 0;
  let pending: Promise<void> | null = null;
  let lastSnapshot: string | null = null;

  function setUser(nextUserId: string | null) {
    if (nextUserId === userId) return;
    userId = nextUserId;
    generation += 1;
    pending = null;
    lastSnapshot = null;
    onLoading(Boolean(userId));
  }

  function refresh(afterMutation = false): Promise<void> {
    if (!userId) return Promise.resolve();
    if (pending) {
      if (!afterMutation) return pending;
      const previous = pending;
      const requestedGeneration = generation;
      // A write may have finished while a pre-write read was in flight. Fetch
      // again afterwards, even when that previous read failed.
      return previous.catch(() => undefined).then(() => {
        if (generation === requestedGeneration) return refresh();
      });
    }

    const requestedUser = userId;
    const requestedGeneration = generation;
    // After initial hydration, background polling should not toggle the global
    // loading flag and rerender every tab twice per unchanged server response.
    const showLoading = lastSnapshot === null || afterMutation;
    if (showLoading) onLoading(true);
    const request = withAccountTimeout(
      Promise.resolve().then(load),
      'Loading your profile took too long. Check your connection and tap Retry. Your account has not been reset.',
    ).then(snapshot => {
      if (generation !== requestedGeneration || userId !== requestedUser) return;
      if (snapshot.profile.id !== requestedUser) {
        throw new Error('We could not verify this profile. Tap Retry to reload your account.');
      }
      const serialized = JSON.stringify(snapshot);
      if (serialized !== lastSnapshot) {
        lastSnapshot = serialized;
        onSnapshot(snapshot);
      }
    }).catch(error => {
      if (generation === requestedGeneration && userId === requestedUser) throw error;
    }).finally(() => {
      if (pending === request) {
        pending = null;
        if (showLoading) onLoading(false);
      }
    });
    pending = request;
    return request;
  }

  return { setUser, refresh };
}
