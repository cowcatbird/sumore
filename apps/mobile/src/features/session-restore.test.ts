import type { Session } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { restoreLatestSession } from './session-restore';

describe('startup account restoration', () => {
  it('restores a saved session without creating a new account', async () => {
    const session = { user: { id: 'caleb' } } as Session;
    const accept = vi.fn();
    await restoreLatestSession({
      read: async () => ({ data: { session }, error: null }),
      revision: () => 0,
      accept,
    });
    expect(accept).toHaveBeenCalledExactlyOnceWith(session);
  });

  it('does not overwrite SIGNED_IN with a late signed-out startup result', async () => {
    let revision = 0;
    const deferred = Promise.withResolvers<{ data: { session: null }; error: null }>();
    const accept = vi.fn();
    const restoring = restoreLatestSession({ read: () => deferred.promise, revision: () => revision, accept });
    revision += 1; // A newer SIGNED_IN event already set the provider session.
    deferred.resolve({ data: { session: null }, error: null });
    await restoring;
    expect(accept).not.toHaveBeenCalled();
  });

  it('does not bring back a previous account after SIGNED_OUT', async () => {
    let revision = 0;
    const deferred = Promise.withResolvers<{ data: { session: Session }; error: null }>();
    const accept = vi.fn();
    const restoring = restoreLatestSession({ read: () => deferred.promise, revision: () => revision, accept });
    revision += 1;
    deferred.resolve({ data: { session: { user: { id: 'previous-person' } } as Session }, error: null });
    await restoring;
    expect(accept).not.toHaveBeenCalled();
  });

  it('ignores stale restore failures after a newer auth event', async () => {
    let revision = 0;
    const deferred = Promise.withResolvers<never>();
    const accept = vi.fn();
    const restoring = restoreLatestSession({ read: () => deferred.promise, revision: () => revision, accept });
    revision += 1;
    deferred.reject(new Error('Storage error for obsolete read'));
    await expect(restoring).resolves.toBeUndefined();
    expect(accept).not.toHaveBeenCalled();
  });

  it('surfaces a current restore failure rather than treating it as signed out', async () => {
    const accept = vi.fn();
    await expect(restoreLatestSession({
      read: async () => ({ data: { session: null }, error: new Error('Could not restore saved account') }),
      revision: () => 0,
      accept,
    })).rejects.toThrow('Could not restore saved account');
    expect(accept).not.toHaveBeenCalled();
  });
});
