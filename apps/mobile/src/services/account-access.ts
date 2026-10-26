import { createClient, type Session } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { requireSupabase } from '@/lib/supabase';
import { networkFetch } from '@/lib/network-fetch';
import { appStorage } from '@/lib/storage';
import { appTourStorageKey } from '@/domain/app-tour-state';
import { characterStorageKey, characterSyncStorageKey } from '@/domain/character';
import { withRetiredDevicePush } from '@/services/push-device-registration';

export type SharedAppLabel = { label: string; minutes: number };
export type SharedAppLimits = {
  userId: string;
  apps: SharedAppLabel[] | null;
  totalDailyMinutes: number;
  updatedAt: string;
};

export type RecoveryNotice = { userId: string; message: string; warning: boolean };
let recoveryNotice: RecoveryNotice | null = null;
const recoveryListeners = new Set<() => void>();
export const getRecoveryNotice = () => recoveryNotice;
export function subscribeRecoveryNotice(listener: () => void) {
  recoveryListeners.add(listener);
  return () => { recoveryListeners.delete(listener); };
}
function publishRecoveryNotice(value: RecoveryNotice | null) {
  recoveryNotice = value;
  recoveryListeners.forEach(listener => { try { listener(); } catch { /* A UI listener cannot undo recovery. */ } });
}
export function clearRecoveryNotice() { publishRecoveryNotice(null); }

const unavailable = 'Account access is unavailable. Please try again.';
const changedAccount = 'The active account changed. Please try again.';
// Browsers do not offer a SecureStore equivalent. Keep the private key only in
// this tab's memory, never localStorage/AsyncStorage, analytics, or snapshots.
const webKeys = new Map<string, string>();
const storageKey = (id: string) => `sumore_login_key_v1.${id}`;
let accountOperation: Promise<unknown> = Promise.resolve();
let recoveryBootstrap: { session: Session; expiresAt: number } | null = null;

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = accountOperation.catch(() => undefined).then(operation);
  accountOperation = next.catch(() => undefined);
  return next;
}

export function normalizeLoginKey(value: string): string | null {
  if (typeof value !== 'string' || value.length > 160) return null;
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^SUMORE[0-9A-F]{48}$/.test(compact)) return null;
  return `SUMORE-${compact.slice(6).match(/.{6}/g)!.join('-')}`;
}

async function readKey(id: string) {
  return Platform.OS === 'web' ? webKeys.get(id) ?? null : SecureStore.getItemAsync(storageKey(id));
}
async function saveKey(id: string, key: string) {
  if (Platform.OS === 'web') { webKeys.set(id, key); return; }
  await SecureStore.setItemAsync(storageKey(id), key, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}
async function removeKey(id: string) {
  if (Platform.OS === 'web') { webKeys.delete(id); return; }
  await SecureStore.deleteItemAsync(storageKey(id));
}
async function session(required = true): Promise<Session | null> {
  const result = await requireSupabase().auth.getSession().catch(() => { throw new Error(unavailable); });
  if (result.error) throw new Error(unavailable);
  if (required && !result.data.session) throw new Error('Sign in to sumore first.');
  return result.data.session;
}
async function assertAccount(id: string) {
  if ((await session())?.user.id !== id) throw new Error(changedAccount);
}
async function isolatedRecoverySession(): Promise<Session> {
  if (recoveryBootstrap && recoveryBootstrap.expiresAt > Date.now()) return recoveryBootstrap.session;
  recoveryBootstrap = null;
  // Reuse one memory-only identity across failed attempts. New anonymous users
  // per typo would grow the database and reset the actor's recovery limiter.
  const isolated = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL!.trim(), process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!.trim(), {
    global: { fetch: networkFetch },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const created = await isolated.auth.signInAnonymously({ options: { data: { display_name: 'Camper' } } })
    .catch(() => { throw new Error(unavailable); });
  if (created.error || !created.data.session) throw new Error(unavailable);
  const value = created.data.session;
  recoveryBootstrap = { session: value, expiresAt: typeof value.expires_at === 'number'
    ? value.expires_at * 1000 - 30_000 : Date.now() + 30 * 60_000 };
  return value;
}
async function serializeOwner<T>(operation: (owner: Session) => Promise<T>): Promise<T> {
  // Capture before queuing: an old account's Delete/Rotate click must never be
  // reinterpreted as a request for an account restored ahead of it in the queue.
  const owner = (await session())!;
  return serialize(async () => {
    await assertAccount(owner.user.id);
    return operation(owner);
  });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(unavailable);
  return value as Record<string, unknown>;
}
async function invoke(owner: Session, body: Record<string, unknown>) {
  const { data, error } = await requireSupabase().functions.invoke('account-access', {
    body, headers: { Authorization: `Bearer ${owner.access_token}` },
  }).catch(() => { throw new Error(unavailable); });
  if (error) {
    // Do not surface transport bodies/URLs or SDK errors containing credentials.
    const context = 'context' in error ? error.context : null;
    if (context instanceof Response) {
      if (context.status === 429) throw new Error('Too many attempts. Try again in 15 minutes.');
      if (body.action === 'recover' && context.status === 400) throw new Error('That login key could not be used. Check it and try again.');
      if (context.status === 401) throw new Error('Sign in to sumore first.');
    }
    throw new Error(unavailable);
  }
  const result = object(data);
  if (typeof result.error === 'string') throw new Error(unavailable);
  return result;
}

export function getLoginKey(): Promise<{ key: string | null; hasKey: boolean }> {
  return serializeOwner(async owner => {
    const cached = await readKey(owner.user.id);
    const result = await invoke(owner, { action: 'status', ...(cached ? { key: cached } : {}) });
    await assertAccount(owner.user.id);
    if (cached && result.matches !== true) await removeKey(owner.user.id);
    return { key: result.matches === true ? cached : null, hasKey: result.hasKey === true };
  });
}

// Replaces the previous key. UI must explain this before a user confirms when
// hasKey=true but the key is missing on this device. Server cannot reveal hashes.
export function createLoginKey(): Promise<string> {
  return serializeOwner(async owner => {
    const result = await invoke(owner, { action: 'create' });
    const key = typeof result.key === 'string' ? normalizeLoginKey(result.key) : null;
    if (!key) throw new Error(unavailable);
    await assertAccount(owner.user.id);
    // Do not report success unless the key is retained on this device.
    await saveKey(owner.user.id, key);
    return key;
  });
}

export function revokeLoginKey(): Promise<void> {
  return serializeOwner(async owner => {
    const result = await invoke(owner, { action: 'revoke' });
    if (result.revoked !== true) throw new Error(unavailable);
    await removeKey(owner.user.id);
  });
}

export async function restoreAccount(input: string): Promise<{ userId: string; previousKeyRevoked: boolean; keySaved: boolean }> {
  const key = normalizeLoginKey(input);
  if (!key) throw new Error('Enter a private SUMORE login key, not a friend code.');
  const previousPersisted = await session(false);
  return serialize(async () => {
    const client = requireSupabase();
    if ((await session(false))?.user.id !== previousPersisted?.user.id) throw new Error(changedAccount);
    let previous = previousPersisted;
    if (!previous) {
      // Never emit a temporary account onto the main client's auth listener:
      // that would dismiss AuthGate and show an empty camper before recovery.
      previous = await isolatedRecoverySession();
    }
    const result = await invoke(previous, { action: 'recover', key });
    if (typeof result.userId !== 'string' || typeof result.accessToken !== 'string' || typeof result.refreshToken !== 'string') throw new Error(unavailable);
    if ((await session(false))?.user.id !== previousPersisted?.user.id) throw new Error(changedAccount);
    const installSession = async () => {
      const installed = await client.auth.setSession({ access_token: result.accessToken as string, refresh_token: result.refreshToken as string })
        .catch(() => ({ data: { session: null }, error: new Error(unavailable) }));
      if (installed.error || !installed.data.session || installed.data.session.user.id !== result.userId) {
        // Recovery must not intentionally sign out or destroy the old account.
        // Restore the previous session only if no unrelated account took over.
        const current = await session(false).catch(() => null);
        if (!current || current.user.id === previous.user.id || current.user.id === result.userId) {
          if (previousPersisted) await client.auth.setSession({ access_token: previousPersisted.access_token, refresh_token: previousPersisted.refresh_token }).catch(() => undefined);
          else await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
        }
        throw new Error('The account could not be restored. Your previous account was not deleted.');
      }
      return installed.data.session;
    };
    // Retire only after a valid recovery response, while the old session can
    // still delete its exact device token. Credential cleanup stays unchanged.
    const installed = previousPersisted?.user.id === result.userId ? await installSession()
      : await withRetiredDevicePush(previousPersisted?.user.id ?? null, installSession);
    recoveryBootstrap = null;
    let keySaved = false;
    try { await saveKey(result.userId, key); keySaved = true; } catch { /* Account recovered; UI warns to retain the entered key. */ }
    let previousKeyRevoked = previous.user.id === result.userId || result.cleanupTicket === null;
    if (typeof result.cleanupTicket === 'string') {
      try {
        const finished = await invoke(installed, { action: 'finish', ticket: result.cleanupTicket });
        previousKeyRevoked = finished.previousKeyRevoked === true;
      } catch { /* Never undo a successful login just because optional cleanup failed. */ }
    }
    if (previous.user.id !== result.userId && previousKeyRevoked) await removeKey(previous.user.id).catch(() => undefined);
    const warnings = [
      ...(!keySaved ? ['Save the key you entered somewhere private; this device could not keep a copy.'] : []),
      ...(!previousKeyRevoked ? ['Your previous account’s login key may still work.'] : []),
    ];
    publishRecoveryNotice({ userId: result.userId, warning: warnings.length > 0,
      message: ['Account restored.', ...warnings].join(' ') });
    return { userId: result.userId, previousKeyRevoked, keySaved };
  });
}

export function deleteAccount(): Promise<void> {
  return serializeOwner(async owner => {
    const result = await invoke(owner, { action: 'delete' });
    if (result.deleted !== true) throw new Error(unavailable);
    await removeKey(owner.user.id).catch(() => undefined);
    // Only clear this device if it still has the deleted account. Peer sessions
    // are invalidated by the Auth row deletion, not a blanket sign-out call.
    if ((await session(false).catch(() => null))?.user.id === owner.user.id) {
      await requireSupabase().auth.signOut({ scope: 'local' });
    }
    // Exact, owner-scoped preferences only. Never clear all AsyncStorage, a
    // different account's camper, preview data, or any shared wallet cache.
    await Promise.allSettled([
      characterStorageKey(owner.user.id), characterSyncStorageKey(owner.user.id), appTourStorageKey(owner.user.id),
    ].map(key => appStorage.removeItem(key)));
    if (recoveryNotice?.userId === owner.user.id) clearRecoveryNotice();
  });
}

export function validateSharedAppLabels(entries: SharedAppLabel[] | null, totalDailyMinutes?: number): SharedAppLabel[] | null {
  if (entries !== null && (!Array.isArray(entries) || entries.length > 50)) throw new Error('Choose up to 50 app labels.');
  const clean = entries?.map(entry => {
    const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
    if (!label || [...label].length > 32 || /[\x00-\x1F\x7F]/.test(label) || !Number.isInteger(entry.minutes) || entry.minutes < 1 || entry.minutes > 1440) {
      throw new Error('Use labels up to 32 characters and 1 to 1440 whole minutes.');
    }
    return { label, minutes: entry.minutes };
  }) ?? null;
  if (totalDailyMinutes !== undefined && (!Number.isInteger(totalDailyMinutes) || totalDailyMinutes < 0 || totalDailyMinutes > 72000 || totalDailyMinutes < (clean?.reduce((sum, app) => sum + app.minutes, 0) ?? 0))) {
    throw new Error('The daily total must cover the shared allocations.');
  }
  return clean;
}

function parseSharedLimits(value: unknown): SharedAppLimits {
  const row = object(value);
  if (typeof row.userId !== 'string' || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt)) || typeof row.totalDailyMinutes !== 'number') throw new Error('Shared limits are unavailable.');
  const apps = validateSharedAppLabels(row.apps as SharedAppLabel[] | null, row.totalDailyMinutes);
  return { userId: row.userId, updatedAt: row.updatedAt, totalDailyMinutes: row.totalDailyMinutes, apps };
}

export async function setSharedAppLimits(entries: SharedAppLabel[] | null, totalDailyMinutes?: number, expectedOwnerId?: string): Promise<SharedAppLimits | null> {
  const apps = validateSharedAppLabels(entries, totalDailyMinutes);
  const owner = (await session())!;
  const expected = expectedOwnerId ?? owner.user.id;
  if (expected !== owner.user.id) throw new Error(changedAccount);
  const { data, error } = await requireSupabase().rpc('set_shared_app_limits', {
    entries: apps, allocation_minutes: totalDailyMinutes ?? null, expected_user_id: expected,
  });
  if (error) throw new Error('Your shared limits could not be saved.');
  await assertAccount(expected);
  return data === null ? null : parseSharedLimits(data);
}

export async function getCircleAppLimits(): Promise<SharedAppLimits[]> {
  const { data, error } = await requireSupabase().rpc('get_circle_app_limits');
  if (error || !Array.isArray(data)) throw new Error('Shared limits are unavailable.');
  return data.map(parseSharedLimits);
}

export async function setSharedDailyTotal(totalDailyMinutes: number, expectedOwnerId: string): Promise<SharedAppLimits> {
  validateSharedAppLabels(null, totalDailyMinutes);
  const owner = (await session())!;
  if (owner.user.id !== expectedOwnerId) throw new Error(changedAccount);
  const { data, error } = await requireSupabase().rpc('set_shared_daily_total', {
    allocation_minutes: totalDailyMinutes, expected_user_id: expectedOwnerId,
  });
  if (error) throw new Error('Your shared daily total could not be saved.');
  await assertAccount(expectedOwnerId);
  return parseSharedLimits(data);
}
