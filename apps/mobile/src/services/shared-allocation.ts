import { setSharedDailyTotal } from '@/services/account-access';
import { requireSupabase } from '@/lib/supabase';
import type { ScreenTimeStatus } from '@/types/domain';

// Device changes finish before this optional upload. Serialize uploads so a
// slow earlier save cannot overwrite a newer allocation once controls unlock.
let uploads: Promise<void> = Promise.resolve();
let latest: { ownerId: string; total: number; promise: Promise<void> } | null = null;

/** No token/package/icon is ever uploaded. Labels are explicitly user-entered. */
export async function publishDailyAllocation(status: ScreenTimeStatus, ownerId: string) {
  if (!status.available || status.requiresReset || status.mode !== 'daily') return;
  const total = status.blockingEnabled ? status.dailyLimitMinutes : 0;
  if (total == null) return;
  if (latest?.ownerId === ownerId && latest.total === total) return latest.promise;
  const promise = uploads.then(async () => {
    const client = requireSupabase();
    if ((await client.auth.getSession()).data.session?.user.id !== ownerId) return;
    // The server preserves optional labels and rechecks the expected owner
    // under its row lock, including if sign-out happens during this request.
    await setSharedDailyTotal(total, ownerId);
  });
  const request = { ownerId, total, promise };
  latest = request;
  uploads = promise.catch(() => undefined);
  void uploads.then(() => { if (latest === request) latest = null; });
  return promise;
}
