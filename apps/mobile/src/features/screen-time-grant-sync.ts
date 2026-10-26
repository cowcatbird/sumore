import type { ScreenTimeGrant } from '@/domain/screen-time-grants';
import { panicButtonBlockReason } from '@/domain/panic-button';
import type { RecentDecision, ScreenTimeStatus } from '@/types/domain';

type Dependencies = {
  configureAccount: (userId: string | null) => Promise<ScreenTimeStatus>;
  getStatus: () => Promise<ScreenTimeStatus>;
  applyGrant: (grant: ScreenTimeGrant) => Promise<ScreenTimeStatus>;
  claimGrant: (requestId: string) => Promise<ScreenTimeGrant | null>;
  getActiveGrant: () => Promise<ScreenTimeGrant | null>;
  triggerPanic?: (expectedUser: string) => Promise<ScreenTimeGrant>;
  onError: (message: string | null) => void;
  now?: () => number;
};

function canApply(status: ScreenTimeStatus) {
  return status.available && status.authorized && status.blockingEnabled === true &&
    (status.mode !== 'daily' || status.dailyLimitReached === true || !!status.temporaryAccessExpiresAt);
}

function confirmsReceipt(status: ScreenTimeStatus, grant: ScreenTimeGrant) {
  return canApply(status) && !status.shielded && status.appliedGrantId === grant.grantId &&
    (grant.source !== 'panic' || (status.supportsPanicGrants === true && status.appliedRequestId == null)) &&
    (status.appliedRequestId == null || status.appliedRequestId === grant.requestId) &&
    Date.parse(status.temporaryAccessExpiresAt ?? '') === Date.parse(grant.expiresAt);
}

/**
 * One queue owns native account configuration and redemption. Invalidating the
 * generation is synchronous, so an old RPC response can never start a native
 * unlock after sign-out. A native call already entered cannot be cancelled by
 * JS; the next account/reset is therefore serialized after it, before any new
 * account's work. The native adapter must enforce owner and fixed-expiry checks.
 */
export function createScreenTimeGrantSync({ configureAccount, getStatus, applyGrant, claimGrant, getActiveGrant, triggerPanic, onError, now = Date.now }: Dependencies) {
  let userId: string | null | undefined;
  let generation = 0;
  let configuredGeneration = -1;
  let queue: Promise<void> = Promise.resolve();
  let pendingSync: { generation: number; promise: Promise<void> } | null = null;
  let pendingPanic: { generation: number; promise: Promise<void> } | null = null;
  let latestDecision: RecentDecision = null;
  let lastError: string | null = null;
  const completedRequests = new Set<string>();

  /**
   * Identity for a receipt that has already been dealt with.
   *
   * A request grant is identified by the approval behind it, so a retry of the
   * same approval is recognised. A panic grant has no approval, so it is
   * identified by the grant itself — which is equally stable, because the
   * server mints exactly one per press.
   */
  function receiptKey(grant: ScreenTimeGrant) {
    return grant.requestId ?? grant.grantId;
  }

  const current = (expectedGeneration: number, expectedUser: string | null) =>
    generation === expectedGeneration && userId === expectedUser;

  function report(message: string | null) {
    if (message === lastError) return;
    lastError = message;
    onError(message);
  }

  function enqueue(expectedGeneration: number, expectedUser: string | null, work: () => Promise<void>, propagateError = false) {
    const result = queue.then(async () => {
      if (!current(expectedGeneration, expectedUser)) return;
      try {
        await work();
      } catch (error) {
        if (current(expectedGeneration, expectedUser)) {
          report(`Screen Time: ${error instanceof Error ? error.message : 'Could not apply your approved time. We’ll retry when you reconnect.'}`);
        }
        if (propagateError) throw error;
      }
    });
    // Neither a failed native operation nor an observer exception should poison
    // subsequent account cleanup. Callers can safely schedule without awaiting.
    queue = result.catch(() => undefined);
    return propagateError ? result : queue;
  }

  async function ensureAccount(expectedGeneration: number, expectedUser: string | null) {
    if (configuredGeneration === expectedGeneration) return;
    await configureAccount(expectedUser);
    if (!current(expectedGeneration, expectedUser)) return;
    configuredGeneration = expectedGeneration;
  }

  function setUser(nextUser: string | null): Promise<void> {
    if (nextUser === userId) return queue;
    userId = nextUser;
    generation += 1;
    latestDecision = null;
    completedRequests.clear();
    pendingSync = null;
    pendingPanic = null;
    report(null);
    const expectedGeneration = generation;
    return enqueue(expectedGeneration, nextUser, () => ensureAccount(expectedGeneration, nextUser));
  }

  /**
   * React cleanup is not sign-out. Cancel JS work without clearing the device's
   * persisted selection, restrictions or grant. A later setUser rebinds even
   * the same account, preserving native state while rejecting old responses.
   */
  function invalidate() {
    generation += 1;
    userId = undefined;
    configuredGeneration = -1;
    latestDecision = null;
    completedRequests.clear();
    pendingSync = null;
    pendingPanic = null;
    // Do not notify an unmounted observer. Preserve lastError so the next
    // setUser can clear a previous error during a Strict Mode effect replay.
  }

  function assertOwner(grant: ScreenTimeGrant, expectedUser: string, requestId?: string) {
    if (grant.requesterId !== expectedUser || (requestId && grant.requestId !== requestId)) {
      throw new Error('The server returned time for a different account or request. No apps were unlocked.');
    }
  }

  function expired(grant: ScreenTimeGrant) {
    const expiry = Date.parse(grant.expiresAt);
    return Date.parse(grant.serverNow) >= expiry || now() >= expiry;
  }

  async function applyReceipt(grant: ScreenTimeGrant, expectedGeneration: number, expectedUser: string) {
    assertOwner(grant, expectedUser);
    if (expired(grant)) {
      // An immutable expired receipt is terminal, not a failed attempt that may
      // be retried to start a fresh timer. Never apply or extend it.
      completedRequests.add(receiptKey(grant));
      return false;
    }
    const before = await getStatus();
    if (!current(expectedGeneration, expectedUser)) return false;
    if (!canApply(before)) { report(null); return false; }
    if (expired(grant)) { completedRequests.add(receiptKey(grant)); return false; }
    if (confirmsReceipt(before, grant)) {
      completedRequests.add(receiptKey(grant));
      return true;
    }

    const applied = await applyGrant(grant);
    if (!current(expectedGeneration, expectedUser)) return false;
    if (expired(grant)) { completedRequests.add(receiptKey(grant)); return false; }
    if (!confirmsReceipt(applied, grant)) {
      throw new Error('Your approved time was not confirmed on this phone. We’ll retry without extending its expiry.');
    }
    // Only successful confirmation reaches this marker. Lost responses/failures
    // remain retryable; the server/native receipt keeps the original deadline.
    completedRequests.add(receiptKey(grant));
    return true;
  }

  /**
   * Spending and applying share the account-bound native queue. Never issue a
   * second charge to recover a lost response; restore the original deadline.
   */
  function pressPanicButton(balance: number): Promise<void> {
    if (!userId || !triggerPanic) return Promise.reject(new Error('Sign in before using panic access.'));
    const expectedUser = userId;
    const expectedGeneration = generation;
    if (pendingPanic?.generation === expectedGeneration) return pendingPanic.promise;

    const promise = enqueue(expectedGeneration, expectedUser, async () => {
      await ensureAccount(expectedGeneration, expectedUser);
      if (!current(expectedGeneration, expectedUser)) return;
      const initial = await getStatus();
      if (!current(expectedGeneration, expectedUser)) return;
      const initialReason = panicButtonBlockReason(initial, balance);
      if (initialReason) throw new Error(initialReason);

      let receipt = await getActiveGrant();
      if (!current(expectedGeneration, expectedUser)) return;
      // A prior press may have reached the server but not this device. Recover
      // it without charging again; another device's approval works the same way.
      if (!receipt || expired(receipt)) {
        const beforeSpend = await getStatus();
        if (!current(expectedGeneration, expectedUser)) return;
        const reason = panicButtonBlockReason(beforeSpend, balance);
        if (reason) throw new Error(reason);
        try {
          receipt = await triggerPanic(expectedUser);
          if (receipt.source !== 'panic') throw new Error('The server returned an invalid panic grant.');
        } catch {
          if (!current(expectedGeneration, expectedUser)) return;
          // Read-only recovery is safe even if the write's response was lost.
          receipt = await getActiveGrant().catch(() => null);
          if (!receipt || receipt.source !== 'panic' || expired(receipt)) {
            throw new Error('Could not confirm panic access. Refresh to check your circle balance and restore any granted time before trying again.');
          }
        }
      }
      if (!current(expectedGeneration, expectedUser)) return;
      try {
        if (!await applyReceipt(receipt, expectedGeneration, expectedUser)) {
          throw new Error('The phone is not ready to unlock apps.');
        }
      } catch {
        if (!current(expectedGeneration, expectedUser)) return;
        throw new Error('Your extra-time grant was recorded, but this phone has not confirmed the unlock. Check Screen Time permissions and refresh to restore that same time; do not spend another s’more.');
      }
      if (current(expectedGeneration, expectedUser)) report(null);
    }, true);
    const pending = { generation: expectedGeneration, promise };
    pendingPanic = pending;
    const clearPending = () => { if (pendingPanic === pending) pendingPanic = null; };
    void promise.then(clearPending, clearPending);
    return promise;
  }

  function sync(decision?: RecentDecision): Promise<void> {
    if (decision !== undefined) latestDecision = decision;
    if (!userId) return queue;
    const expectedUser = userId;
    const expectedGeneration = generation;
    if (pendingSync?.generation === expectedGeneration) return pendingSync.promise;

    const promise = enqueue(expectedGeneration, expectedUser, async () => {
      await ensureAccount(expectedGeneration, expectedUser);
      if (!current(expectedGeneration, expectedUser)) return;
      const status = await getStatus();
      if (!current(expectedGeneration, expectedUser)) return;
      // Unsupported binaries, denied permission, disabled restrictions and
      // an unused daily allowance must not start an approved break's timer.
      if (!canApply(status)) { report(null); return; }

      // Claim can succeed remotely even if its response was lost. Reconcile it
      // first on every retry before considering any newer approval.
      const active = await getActiveGrant();
      if (!current(expectedGeneration, expectedUser)) return;
      if (active) {
        assertOwner(active, expectedUser);
        await applyReceipt(active, expectedGeneration, expectedUser);
        if (!current(expectedGeneration, expectedUser)) return;
        if (!expired(active)) { report(null); return; }
      }

      const approved = latestDecision;
      if (!approved || approved.status !== 'approved' || (approved.minutes !== 15 && approved.minutes !== 30) || completedRequests.has(approved.id)) {
        report(null);
        return;
      }
      // Permission may have changed during the server read. Check again before
      // consuming the one-use claim/start timestamp.
      const beforeClaim = await getStatus();
      if (!current(expectedGeneration, expectedUser)) return;
      if (!canApply(beforeClaim)) { report(null); return; }
      const receipt = await claimGrant(approved.id);
      if (!current(expectedGeneration, expectedUser)) return;
      if (receipt) {
        assertOwner(receipt, expectedUser, approved.id);
        await applyReceipt(receipt, expectedGeneration, expectedUser);
        if (!current(expectedGeneration, expectedUser)) return;
      }
      report(null);
    });
    const pending = { generation: expectedGeneration, promise };
    pendingSync = pending;
    void promise.finally(() => { if (pendingSync === pending) pendingSync = null; });
    return promise;
  }

  return { setUser, sync, pressPanicButton, invalidate };
}
