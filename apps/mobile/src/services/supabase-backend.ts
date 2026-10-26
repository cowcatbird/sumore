import type { AuthChangeEvent, RealtimeChannel, Session } from '@supabase/supabase-js';

import { isValidDisplayName, MAX_DISPLAY_NAME_LENGTH, normalizeDisplayName } from '@/domain/profile';
import { type CharacterAppearance, isCharacterAppearance, parseSharedCharacter, type SharedCharacter } from '@/domain/character';
import { parseScreenTimeGrant, type ScreenTimeGrant } from '@/domain/screen-time-grants';
import { isBackgroundId, parseCircleShop, SHOP_ITEMS, type BackgroundId, type CircleShop, type ShopItemId } from '@/domain/circle-shop';
import { withAccountTimeout } from '@/lib/account-timeout';
import { requireSupabase } from '@/lib/supabase';
import type { AppSnapshot, Decision, GrantMinutes } from '@/types/domain';

type SnapshotPayload = {
  profile: AppSnapshot['profile'];
  friends: AppSnapshot['friends'];
  incomingRequests: AppSnapshot['incomingRequests'];
  outgoingRequest: AppSnapshot['outgoingRequest'];
  recentDecision: AppSnapshot['recentDecision'];
  groupPolicy: AppSnapshot['groupPolicy'];
  campfire?: AppSnapshot['campfire'];
  circleShop?: unknown;
};

export const defaultGroupPolicy: AppSnapshot['groupPolicy'] = {
  title: 'Be kind, not automatic.',
  body: 'Ask yourself: does this sound intentional, or is it just the habit talking? There is no punishment either way.',
};

const catalogUpdateRequired = 'Your circle needs a server update for the new accessories. Please try again after the update.';

function backendError(error: { code?: string; message: string } | null, fallback: string) {
  if (error?.code === '23505' || error?.message.toLowerCase().includes('duplicate')) {
    // A uniqueness failure can concern several unrelated records. Only an
    // operation that knows the conflicting field should label it for the user.
    throw new Error(fallback);
  }
  if (error) throw new Error(error.message);
  throw new Error(fallback);
}

function validatedDisplayName(displayName: string) {
  const cleanName = normalizeDisplayName(displayName);
  if (!cleanName) throw new Error('Enter the name your friends should see.');
  if (!isValidDisplayName(cleanName)) {
    throw new Error(`Your name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`);
  }
  return cleanName;
}

// A repeated tap/keyboard submit must not create a second, unrelated identity.
// Share the first request even if the name field changes while it is pending.
let pendingAnonymousSignIn: Promise<Session> | null = null;

export async function signInAnonymously(displayName: string): Promise<Session> {
  if (pendingAnonymousSignIn) return pendingAnonymousSignIn;
  const cleanName = validatedDisplayName(displayName);
  const client = requireSupabase();
  // Install the guard synchronously, before invoking the auth client.
  const request = Promise.resolve().then(async () => {
    // Signup can finish even if the following profile download fails. Retrying
    // must resume that saved identity, not replace its friends and friend code.
    const { data: existing, error: restoreError } = await withAccountTimeout(
      client.auth.getSession(),
      'Reading your saved account took too long. Tap Retry; your account has not been reset.',
    );
    if (restoreError) backendError(restoreError, 'We could not restore your private account.');
    if (existing.session) return existing.session;

    const { data, error } = await client.auth.signInAnonymously({
      options: {
        data: { display_name: cleanName },
      },
    });
    if (error) backendError(error, 'We could not create your private account.');
    if (!data.session) throw new Error('We could not finish creating your private account.');
    return data.session;
  });
  pendingAnonymousSignIn = request;
  try {
    return await request;
  } finally {
    if (pendingAnonymousSignIn === request) pendingAnonymousSignIn = null;
  }
}

export async function signOut() {
  const { withRetiredDevicePush } = await import('@/services/push-device-registration');
  const client = requireSupabase();
  const { data, error: sessionError } = await client.auth.getSession();
  if (sessionError) backendError(sessionError, 'We could not read your account. Try again.');
  await withRetiredDevicePush(data.session?.user.id ?? null, async () => {
    const { error } = await client.auth.signOut();
    if (error) backendError(error, 'We could not sign you out.');
  });
}

/**
 * The device's IANA zone, so the server can decide where one local day ends.
 * A campfire day that rolled over at 4pm would be worse than useless.
 */
function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export async function loadSnapshot(): Promise<AppSnapshot> {
  const client = requireSupabase();
  const tz = deviceTimeZone();

  // Migration 0011 derives today's standing from the full request history,
  // including approved, denied, cancelled, and expired requests. Do not retry
  // without the timezone or guess from pending requests: either could make a
  // burnt marshmallow look clean before the person's local day is over.
  // Catalog v5 includes the new accessories. Legacy snapshots intentionally
  // hide unknown unlocks, so never fall back to one after a server failure.
  const { data, error } = await client.rpc('get_app_snapshot_v5', { tz });
  if (error?.code === 'PGRST202') throw new Error(catalogUpdateRequired);
  if (error) backendError(error, 'We could not load your circle.');

  const payload = data as SnapshotPayload | null;
  if (!payload?.profile) throw new Error('Your profile is still being prepared. Please try again.');

  const campfire = payload.campfire;
  const circleShop = parseCircleShop(payload.circleShop);
  if (payload.circleShop != null && !circleShop) throw new Error('Your circle’s wallet could not be verified. Refresh and try again.');
  if (
    !campfire
    || !campfire.localDate
    || !Array.isArray(campfire.seats)
    || !campfire.seats.some((seat) => seat.id === payload.profile.id && seat.isYou)
    || campfire.seats.some((seat) => typeof seat.askedToday !== 'boolean')
  ) {
    throw new Error('Your campfire status is unavailable. The app’s backend needs an update before we can show today’s marshmallows accurately.');
  }

  return {
    ...payload,
    circleShop,
    profile: { ...payload.profile, character: parseSharedCharacter(payload.profile.character) },
    friends: payload.friends.map(friend => ({ ...friend, character: parseSharedCharacter(friend.character) })),
    incomingRequests: payload.incomingRequests.map(request => ({
      ...request, friend: { ...request.friend, character: parseSharedCharacter(request.friend.character) },
    })),
    groupPolicy: payload.groupPolicy ?? defaultGroupPolicy,
    campfire: { ...campfire, seats: campfire.seats.map(seat => ({ ...seat, character: parseSharedCharacter(seat.character) })) },
  };
}

export async function updateCharacter(profileId: string, appearance: CharacterAppearance, expectedRevision: number): Promise<SharedCharacter> {
  if (!profileId || !isCharacterAppearance(appearance) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('Choose a supported hat and body before saving.');
  }
  const { data, error } = await requireSupabase().rpc('update_my_character', {
    target_profile_id: profileId,
    new_hat: appearance.hat,
    new_body: appearance.body,
    new_color: appearance.color ?? 'cream',
    expected_revision: expectedRevision,
  });
  if (error?.code === 'PGRST202') throw new Error('Shared camper looks are not enabled on the server yet. Your look is still saved on this device.');
  if (error) backendError(error, 'Your camper could not be shared. Please try again.');
  const saved = parseSharedCharacter(data);
  if (!saved?.appearance) throw new Error('The server did not confirm your camper. Please refresh and try again.');
  return saved;
}

/** Reconcile save timeouts/conflicts before retrying; existing profile RLS applies. */
export async function loadSharedCharacter(profileId: string): Promise<SharedCharacter> {
  const { data, error } = await requireSupabase().from('profiles')
    .select('id,character_hat,character_body,character_color,character_revision')
    .eq('id', profileId)
    .single();
  if (error) backendError(error, 'We could not check your shared camper. Please try again.');
  if (!data || data.id !== profileId) throw new Error('We could not verify your camper. Please try again.');
  const character = parseSharedCharacter({
    appearance: data.character_hat === null ? null : { hat: data.character_hat, body: data.character_body, color: data.character_color ?? 'cream' },
    revision: data.character_revision,
  });
  if (!character) throw new Error('Shared looks are not enabled on the server yet.');
  return character;
}

export async function createTimeRequest(minutes: GrantMinutes, reason: string) {
  const { data, error } = await requireSupabase().rpc('create_time_request', {
    requested_minutes: minutes,
    request_reason: reason,
    request_category_label: 'Social apps',
  });
  if (error) backendError(error, 'We could not send your request.');
  return data as string;
}

export async function decideTimeRequest(requestId: string, decision: Decision) {
  const { error } = await requireSupabase().rpc('decide_time_request', {
    target_request_id: requestId,
    requested_decision: decision,
  });
  if (error) backendError(error, 'That request is no longer available.');
}

export async function cancelTimeRequest(requestId: string) {
  const { error } = await requireSupabase().rpc('cancel_time_request', {
    target_request_id: requestId,
  });
  if (error) backendError(error, 'We could not cancel the request.');
}

export async function addFriendByCode(code: string) {
  const { error } = await requireSupabase().rpc('add_friend_by_code', { friend_code_input: code });
  if (error) backendError(error, 'That friend code could not be used.');
}

/** Join only your own account, never silently merge two existing groups. */
export async function joinSharedCircle(code: string) {
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,16}$/.test(clean)) throw new Error('Enter a friend code with 4–16 letters or numbers.');
  const { error } = await requireSupabase().rpc('join_shared_circle_v5', { friend_code_input: clean });
  if (error?.code === 'PGRST202') throw new Error(catalogUpdateRequired);
  if (error) backendError(error, 'We could not join that circle.');
}

export async function purchaseCircleItem(groupId: string, itemId: ShopItemId) {
  const item = SHOP_ITEMS.find(item => item.id === itemId);
  if (!groupId || !item) throw new Error('Choose an item from your circle’s shop.');
  // Bind the confirmation to the displayed price. The server still determines
  // the charge and refuses stale catalogs instead of silently charging more.
  const { data, error } = await requireSupabase().rpc('purchase_circle_item_v5', {
    target_group_id: groupId, item_id: itemId, expected_cost: item.cost,
  });
  if (error?.code === 'PGRST202') throw new Error(catalogUpdateRequired);
  if (error) backendError(error, 'The item could not be unlocked.');
  const shop = parseCircleShop(data);
  if (!shop || shop.id !== groupId || !shop.unlocked.includes(itemId)) {
    throw new Error('The purchase was not confirmed. Refresh before trying again.');
  }
  return shop;
}

export async function changeCircleBackground(groupId: string, background: BackgroundId) {
  if (!groupId || !isBackgroundId(background)) throw new Error('Choose a supported background.');
  const { data, error } = await requireSupabase().rpc('set_circle_background_v5', { target_group_id: groupId, new_background: background });
  if (error?.code === 'PGRST202') throw new Error(catalogUpdateRequired);
  if (error) backendError(error, 'The background could not be changed.');
  const shop = parseCircleShop(data);
  if (!shop || shop.id !== groupId || shop.background !== background) {
    throw new Error('The background was not confirmed. Refresh and try again.');
  }
  return shop;
}

export async function updateGroupPolicy(title: string, body: string) {
  const { error } = await requireSupabase().rpc('update_group_policy', {
    new_title: title,
    new_body: body,
  });
  if (error) backendError(error, 'We could not change your group policy.');
}

export async function updateProfile(displayName: string) {
  const cleanName = validatedDisplayName(displayName);
  const { error } = await requireSupabase().rpc('update_my_profile_name', {
    new_display_name: cleanName,
  });
  if (error) backendError(error, 'We could not update your profile.');
}

export async function upsertPushToken(token: string, platform: 'ios' | 'android', expectedUserId: string, isCurrent = () => true) {
  const { persistDevicePushToken } = await import('@/services/push-device-registration');
  await persistDevicePushToken(token, platform, expectedUserId, isCurrent);
}

export function subscribeToAppChanges(onChange: () => void): RealtimeChannel {
  return requireSupabase()
    .channel('private:app-state')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'time_requests' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'request_recipients' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'circle_members' }, onChange)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, onChange)
    // Purchases, requests and roster changes also touch this published group row.
    .on('postgres_changes', { event: '*', schema: 'public', table: 'camp_groups' }, onChange)
    .subscribe();
}

export function onAuthStateChange(callback: (session: Session | null, event: AuthChangeEvent) => void) {
  return requireSupabase().auth.onAuthStateChange((event, session) => callback(session, event));
}

/** Receipts are immutable: claiming again must never restart an approved timer. */
export async function claimScreenTimeGrant(requestId: string): Promise<ScreenTimeGrant | null> {
  // Unlike signup, this operation is safe to retry after a lost response: the
  // immutable request receipt cannot create another grant or restart its timer.
  const { data, error } = await withAccountTimeout(
    requireSupabase().rpc('claim_screen_time_grant', { target_request_id: requestId }),
    'Confirming your approved time took too long. We’ll restore the original grant when you reconnect.',
  );
  if (error) backendError(error, 'Could not claim your approved Screen Time. Please try again.');
  return data === null ? null : parseScreenTimeGrant(data);
}

/**
 * Press the panic button: fifteen unrestricted minutes, spending one circle
 * s'more if available (never below zero) and burning the circle's day.
 *
 * Deliberately NOT retried on a lost response. Every other grant call here is
 * safe to repeat because an immutable receipt cannot mint a second unlock, but
 * this one spends a s'more and alerts everybody. A silent retry could charge a
 * circle twice for one press.
 */
export async function triggerPanicButton(expectedUserId: string): Promise<{ grant: ScreenTimeGrant; shop: CircleShop }> {
  if (typeof expectedUserId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedUserId)) {
    throw new Error('Sign in again before using panic access.');
  }
  // A stalled write must not hold the native account/reset queue forever.
  // Timeout leaves its outcome uncertain; recover with a read, never retry it.
  // Bind the confirmation to its owner even if auth changes while the SDK
  // resolves the access token. SQL checks this before any wallet mutation.
  const { data, error } = await withAccountTimeout(
    requireSupabase().rpc('use_panic_button', { expected_user_id: expectedUserId }),
    'Confirming panic access took too long. Refresh to restore any granted time before trying again.',
  );
  if (error) backendError(error, 'Could not use the panic button. Please try again.');
  const payload = data as { grant?: unknown; shop?: unknown } | null;
  const shop = parseCircleShop(payload?.shop);
  if (!payload?.grant || !shop) throw new Error('The panic button did not complete. Check with your circle before trying again.');
  const grant = parseScreenTimeGrant(payload.grant);
  if (grant.requesterId !== expectedUserId) throw new Error('The server returned panic access for a different account. No apps were unlocked.');
  return { grant, shop };
}

/** Recover an already-claimed receipt before retrying a lost claim response. */
export async function getActiveScreenTimeGrant(): Promise<ScreenTimeGrant | null> {
  const { data, error } = await withAccountTimeout(
    requireSupabase().rpc('get_active_screen_time_grant'),
    'Restoring your approved time took too long. We’ll retry when you reconnect.',
  );
  if (error) backendError(error, 'Could not restore your approved Screen Time. Please try again.');
  return data === null ? null : parseScreenTimeGrant(data);
}
