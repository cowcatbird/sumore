import type { Session } from '@supabase/supabase-js';

import { withAccountTimeout } from '@/lib/account-timeout';

/** A late storage read must not undo a newer sign-in/sign-out event. */
export async function restoreLatestSession({
  read,
  revision,
  accept,
}: {
  read: () => PromiseLike<{ data: { session: Session | null }; error: Error | null }>;
  revision: () => number;
  accept: (session: Session | null) => void;
}) {
  const startingRevision = revision();
  try {
    const { data, error } = await withAccountTimeout(
      read(),
      'Restoring your account took too long. Check your connection and tap Retry.',
    );
    if (revision() !== startingRevision) return;
    if (error) throw error;
    accept(data.session);
  } catch (error) {
    // A stale failure is just as obsolete as a stale successful result.
    if (revision() === startingRevision) throw error;
  }
}
