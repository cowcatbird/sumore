import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { requireSupabase } from '@/lib/supabase';

export type DevicePushReceipt = { ownerId: string; token: string; projectId: string; buildId: string };
type KnownToken = Pick<DevicePushReceipt, 'ownerId' | 'token'> & { uncertainStage?: boolean };
const receiptKey = 'sumore_push_registration_v1';
const journalKey = 'sumore_push_device_tokens_v1';
const unavailable = 'Could not safely disconnect this device’s notifications. Check your connection and try again.';
const changedAccount = 'The active account changed. Try enabling notifications again.';
let writes: Promise<void> = Promise.resolve();
let generation = 0;
let transitions = 0;

// Keep real persistence work in this queue, independently of a screen's timeout.
// Account transitions invalidate native work immediately, then wait for writes.
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = writes.then(operation);
  writes = next.then(() => undefined, () => undefined);
  return next;
}

export function captureDevicePushRegistration(isCurrent: () => boolean): () => boolean {
  const version = generation;
  const startedOutsideTransition = transitions === 0;
  return () => startedOutsideTransition && transitions === 0 && generation === version && isCurrent();
}

function knownToken(value: unknown): value is KnownToken {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<KnownToken>;
  return typeof item.ownerId === 'string' && item.ownerId.length > 0 && typeof item.token === 'string'
    && item.token.length <= 256 && /^Expo(nent)?PushToken\[[^\]\s]+\]$/.test(item.token)
    && (item.uncertainStage === undefined || typeof item.uncertainStage === 'boolean');
}

async function read(key: string): Promise<string | null> {
  return Platform.OS === 'web' ? null : SecureStore.getItemAsync(key);
}
async function save(key: string, value: unknown): Promise<void> {
  if (Platform.OS !== 'web') await SecureStore.setItemAsync(key, JSON.stringify(value), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
async function remove(key: string): Promise<void> {
  if (Platform.OS !== 'web') await SecureStore.deleteItemAsync(key);
}

async function receipt(strict = false): Promise<DevicePushReceipt | null> {
  const raw = await read(receiptKey);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (knownToken(value) && typeof (value as DevicePushReceipt).projectId === 'string'
      && typeof (value as DevicePushReceipt).buildId === 'string') return value as DevicePushReceipt;
  } catch { /* Invalid storage cannot justify a broader deletion. */ }
  if (strict) throw new Error(unavailable);
  return null;
}

async function journal(): Promise<KnownToken[]> {
  const raw = await read(journalKey);
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every(knownToken)) return value;
  } catch { /* Preserve the journal for a retry, never guess its owner/token. */ }
  throw new Error(unavailable);
}

async function assertSession(ownerId: string | null) {
  const { data, error } = await requireSupabase().auth.getSession();
  if (error || (data.session?.user.id ?? null) !== ownerId) throw new Error(changedAccount);
}
function assertCurrent(isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error(changedAccount);
}

export const readDevicePushReceipt = () => receipt();

export function saveDevicePushReceipt(value: DevicePushReceipt, isCurrent: () => boolean): Promise<void> {
  return serialize(async () => {
    assertCurrent(isCurrent);
    await assertSession(value.ownerId);
    assertCurrent(isCurrent);
    await save(receiptKey, value);
  });
}

/** Only this device's known tokens are journaled; no user-wide token queries. */
export function persistDevicePushToken(token: string, platform: 'ios' | 'android', ownerId: string,
  isCurrent: () => boolean): Promise<void> {
  const current = captureDevicePushRegistration(isCurrent);
  return serialize(async () => {
    assertCurrent(current);
    if (!knownToken({ ownerId, token })) throw new Error('Could not register this device. Try Enable again.');
    const client = requireSupabase();
    const { data: identity, error: identityError } = await client.auth.getUser();
    if (identityError || identity.user?.id !== ownerId) throw new Error(changedAccount);
    assertCurrent(current);
    const tokens = await journal();
    const saved = await receipt(true);
    // Preserve a previous receipt before a rotated token can replace it.
    for (const item of [...(saved ? [{ ownerId: saved.ownerId, token: saved.token }] : []), { ownerId, token }]) {
      if (tokens.some(known => known.ownerId === item.ownerId && known.token === item.token)) continue;
      tokens.push(item);
    }
    const staging = tokens.find(item => item.ownerId === ownerId && item.token === token)!;
    const previouslyUncertain = staging.uncertainStage === true;
    staging.uncertainStage = true;
    // A crash/timeout after this point can leave a delayed disabled insert.
    // Persist that uncertainty before sending the request, including retries.
    await save(journalKey, tokens);
    assertCurrent(current);
    await assertSession(ownerId);
    assertCurrent(current);
    const { data: staged, error: stageError } = await client.from('device_push_tokens').upsert({
      user_id: ownerId, token, platform, disabled_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
    }, { onConflict: 'token' }).select('id').single();
    if (stageError || typeof staged?.id !== 'string') throw new Error('Could not save this device for notifications.');
    // A successful retry does not prove an earlier timed-out request finished.
    if (!previouslyUncertain) delete staging.uncertainStage;
    await save(journalKey, tokens);
    assertCurrent(current);
    await assertSession(ownerId);
    assertCurrent(current);
    // Activation cannot resurrect a row deleted during an account transition.
    // A late staging UPSERT is harmless to delivery because it stays disabled.
    const { data: activated, error: activateError } = await client.from('device_push_tokens')
      .update({ disabled_at: null, last_seen_at: new Date().toISOString() })
      .eq('id', staged.id).eq('user_id', ownerId).eq('token', token).select('id').maybeSingle();
    if (activateError || activated?.id !== staged.id) throw new Error('Could not connect notifications. Try Enable again.');
    assertCurrent(current);
  });
}

/** Hold the gate through auth replacement so another Enable cannot overtake it. */
export function withRetiredDevicePush<T>(ownerId: string | null, changeAccount: () => Promise<T>): Promise<T> {
  generation += 1;
  transitions += 1;
  return serialize(async () => {
    try {
      await assertSession(ownerId);
      if (ownerId !== null) {
        const known = await journal();
        const saved = await receipt(true);
        // Old-build receipts still identify a token that must be retired.
        const tokens = new Set(known.filter(item => item.ownerId === ownerId).map(item => item.token));
        if (saved?.ownerId === ownerId) tokens.add(saved.token);
        for (const token of tokens) {
          await assertSession(ownerId);
          const { error } = await requireSupabase().from('device_push_tokens').delete()
            .eq('user_id', ownerId).eq('token', token);
          if (error) throw new Error(unavailable);
          await assertSession(ownerId);
        }
        // Only clear knowledge after all exact deletions were acknowledged.
        // Missing receipts are legacy clients: never infer another device's token.
        if (tokens.size) {
          // A transport timeout can outlive this DELETE and later insert a
          // disabled row. Retain its identity for future owner-authorized
          // cleanup; never let another account take over or delete that row.
          const retained = known.filter(item => item.ownerId !== ownerId || item.uncertainStage);
          if (retained.length) await save(journalKey, retained); else await remove(journalKey);
          if (saved?.ownerId === ownerId) await remove(receiptKey);
        }
      }
      await assertSession(ownerId);
    } catch {
      // Storage and transport errors can carry token-bearing request details.
      // Leave the auth session unchanged and retain knowledge for a retry.
      throw new Error(unavailable);
    }
    return changeAccount();
  }).finally(() => { transitions -= 1; });
}
