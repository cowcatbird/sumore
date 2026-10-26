import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSnapshot } from '@/types/domain';
import { ACCOUNT_LOAD_TIMEOUT_MS } from '@/lib/account-timeout';
import { SHOP_ITEMS, type CircleShop } from '@/domain/circle-shop';
import { BODY_COLORS } from '@/domain/character';

import * as backend from './supabase-backend';
import { changeCircleBackground, defaultGroupPolicy, joinSharedCircle, loadSharedCharacter, loadSnapshot, purchaseCircleItem, signInAnonymously, updateCharacter, updateProfile } from './supabase-backend';

const { rpc, anonymousSignIn, getSession, profileRead, saveToken, retirePush, authSignOut } = vi.hoisted(() => ({ rpc: vi.fn(), anonymousSignIn: vi.fn(), getSession: vi.fn(), profileRead: vi.fn(), saveToken: vi.fn(), retirePush: vi.fn(), authSignOut: vi.fn() }));
vi.mock('@/services/push-device-registration', () => ({ persistDevicePushToken: saveToken, withRetiredDevicePush: retirePush }));

// Unit fixtures only: no session, sign-in, or network client is created.
vi.mock('@/lib/supabase', () => ({ requireSupabase: () => ({
  rpc, auth: { signInAnonymously: anonymousSignIn, getSession, signOut: authSignOut },
  from: (table: string) => ({ select: (fields: string) => ({ eq: (field: string, id: string) => ({ single: () => profileRead(table, fields, field, id) }) }) }),
}) }));

function snapshot(): AppSnapshot {
  return {
    profile: { id: 'self', displayName: 'Self', friendCode: 'SELF', initials: 'S' },
    friends: [{ id: 'friend', displayName: 'Friend', friendCode: 'FRIEND', initials: 'F', color: '#fff', online: false }],
    incomingRequests: [],
    outgoingRequest: null,
    recentDecision: null,
    groupPolicy: defaultGroupPolicy,
    campfire: {
      localDate: '2026-09-12',
      groupGolden: 6,
      seats: [
        { id: 'self', displayName: 'Self', initials: 'S', isYou: true, askedToday: true, streak: 0, golden: 2 },
        { id: 'friend', displayName: 'Friend', initials: 'F', isYou: false, askedToday: true, streak: 0, golden: 4 },
      ],
    },
  };
}

function circleShop(overrides: Partial<CircleShop> = {}): CircleShop {
  return {
    id: 'our-circle', name: 'Our circle', balance: 99, unlocked: [], background: 'forest',
    localDate: '2026-09-17', timeZone: 'America/Los_Angeles', askedToday: false, eligibleToday: true,
    dayStartedAt: '2026-09-17T07:00:00Z', nextAwardAt: '2026-09-18T07:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  rpc.mockReset();
  profileRead.mockReset();
  saveToken.mockReset().mockResolvedValue(undefined);
  retirePush.mockReset().mockImplementation(async (_owner: string | null, action: () => Promise<void>) => action());
  authSignOut.mockReset().mockResolvedValue({ error: null });
  anonymousSignIn.mockReset();
  getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
  const options = Intl.DateTimeFormat().resolvedOptions();
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, timeZone: 'America/Los_Angeles' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('device push ownership integration', () => {
  it('delegates token persistence with the captured account and lifecycle guard', async () => {
    await backend.upsertPushToken('ExpoPushToken[fixture]', 'android', 'self');
    expect(saveToken).toHaveBeenCalledExactlyOnceWith('ExpoPushToken[fixture]', 'android', 'self', expect.any(Function));
  });
  it('waits for device retirement before signing out', async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: 'self' } } }, error: null });
    const gate = Promise.withResolvers<void>();
    retirePush.mockImplementation(async (_owner, action) => { await gate.promise; return action(); });
    const pending = backend.signOut();
    await vi.waitFor(() => expect(retirePush).toHaveBeenCalledWith('self', expect.any(Function)));
    expect(authSignOut).not.toHaveBeenCalled();
    gate.resolve(); await pending;
    expect(authSignOut).toHaveBeenCalledOnce();
  });
  it('keeps the session if known-device retirement fails', async () => {
    retirePush.mockRejectedValue(new Error('Could not safely disconnect'));
    await expect(backend.signOut()).rejects.toThrow('Could not safely disconnect');
    expect(authSignOut).not.toHaveBeenCalled();
  });
});

describe('name-only private accounts', () => {
  it('allows signed-out devices to sign up with the same name without an availability RPC', async () => {
    const first = { access_token: 'first-session', user: { id: 'first-person' } };
    const second = { access_token: 'second-session', user: { id: 'second-person' } };
    anonymousSignIn.mockResolvedValueOnce({ data: { session: first }, error: null });
    anonymousSignIn.mockResolvedValueOnce({ data: { session: second }, error: null });

    expect(await signInAnonymously('  Alex  ')).toEqual(first);
    expect(await signInAnonymously('Alex')).toEqual(second);
    expect(rpc).not.toHaveBeenCalled();
    expect(anonymousSignIn).toHaveBeenCalledTimes(2);
    expect(anonymousSignIn).toHaveBeenNthCalledWith(1, { options: { data: { display_name: 'Alex' } } });
    expect(anonymousSignIn).toHaveBeenNthCalledWith(2, { options: { data: { display_name: 'Alex' } } });
  });

  it.each(['Alex', 'Sam'])('coalesces concurrent submissions even when the second name is %s', async secondName => {
    const session = { access_token: 'one-session', user: { id: 'one-person' } };
    const deferred = Promise.withResolvers<{ data: { session: typeof session }; error: null }>();
    anonymousSignIn.mockReturnValueOnce(deferred.promise);

    const first = signInAnonymously('Alex');
    const second = signInAnonymously(secondName);
    await vi.waitFor(() => {
      expect(anonymousSignIn).toHaveBeenCalledExactlyOnceWith({ options: { data: { display_name: 'Alex' } } });
    });
    deferred.resolve({ data: { session }, error: null });
    expect(await Promise.all([first, second])).toEqual([session, session]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('resumes an existing account after a failed profile download without creating another identity', async () => {
    const existing = { access_token: 'existing-session', user: { id: 'existing-person' } };
    getSession.mockResolvedValue({ data: { session: existing }, error: null });

    expect(await signInAnonymously('A different name')).toEqual(existing);
    expect(anonymousSignIn).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not replace an account when restoring its session fails', async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: { message: 'Could not read saved account' } });
    await expect(signInAnonymously('Alex')).rejects.toThrow('Could not read saved account');
    expect(anonymousSignIn).not.toHaveBeenCalled();
  });

  it('times out a readonly saved-session lookup and resumes the saved account on Retry', async () => {
    vi.useFakeTimers();
    const stalledRead = Promise.withResolvers<{ data: { session: null }; error: null }>();
    getSession.mockReturnValueOnce(stalledRead.promise);
    const first = signInAnonymously('Alex');
    const rejected = expect(first).rejects.toThrow('Reading your saved account took too long');
    await vi.advanceTimersByTimeAsync(ACCOUNT_LOAD_TIMEOUT_MS);
    await rejected;
    expect(anonymousSignIn).not.toHaveBeenCalled();

    const existing = { access_token: 'saved', user: { id: 'original-user' } };
    getSession.mockResolvedValueOnce({ data: { session: existing }, error: null });
    expect(await signInAnonymously('Alex')).toEqual(existing);
    stalledRead.resolve({ data: { session: null }, error: null });
    await Promise.resolve();
    expect(anonymousSignIn).not.toHaveBeenCalled();
  });

  it('releases the single-flight guard after an auth error so a retry can succeed', async () => {
    const deferred = Promise.withResolvers<{ data: { session: null }; error: { message: string } }>();
    anonymousSignIn.mockReturnValueOnce(deferred.promise);
    const first = signInAnonymously('Alex');
    const second = signInAnonymously('Sam');
    const settled = Promise.allSettled([first, second]);
    deferred.resolve({ data: { session: null }, error: { message: 'Temporary network failure' } });
    const outcomes = await settled;
    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(anonymousSignIn).toHaveBeenCalledTimes(1);

    const session = { access_token: 'retry-session', user: { id: 'retry-person' } };
    anonymousSignIn.mockResolvedValueOnce({ data: { session }, error: null });
    expect(await signInAnonymously('Sam')).toEqual(session);
    expect(anonymousSignIn).toHaveBeenNthCalledWith(2, { options: { data: { display_name: 'Sam' } } });
  });

  it('also releases the guard when the auth client throws instead of returning an error', async () => {
    anonymousSignIn.mockRejectedValueOnce(new Error('Connection closed'));
    await expect(signInAnonymously('Alex')).rejects.toThrow('Connection closed');
    const session = { access_token: 'reconnected-session' };
    anonymousSignIn.mockResolvedValueOnce({ data: { session }, error: null });
    expect(await signInAnonymously('Alex')).toEqual(session);
    expect(anonymousSignIn).toHaveBeenCalledTimes(2);
  });

  it.each(['', '\t\n ', '🌙'.repeat(61)])('rejects an invalid name before creating an account', async name => {
    await expect(signInAnonymously(name)).rejects.toThrow(/name/i);
    expect(anonymousSignIn).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('accepts 60 astral Unicode characters without inventing a handle', async () => {
    const name = '🌙'.repeat(60);
    anonymousSignIn.mockResolvedValue({ data: { session: { access_token: 'session' } }, error: null });
    await signInAnonymously(name);
    expect(anonymousSignIn).toHaveBeenCalledExactlyOnceWith({ options: { data: { display_name: name } } });
  });

  it('requires an actual returned session', async () => {
    anonymousSignIn.mockResolvedValue({ data: { session: null }, error: null });
    await expect(signInAnonymously('Alex')).rejects.toThrow('finish creating your private account');
  });

  it('does not describe unrelated unique violations as a taken name or handle', async () => {
    anonymousSignIn.mockResolvedValue({ data: { session: null }, error: { code: '23505', message: 'duplicate key value' } });
    await expect(signInAnonymously('Alex')).rejects.toThrow('We could not create your private account.');
  });

  it('preserves useful authentication failures', async () => {
    anonymousSignIn.mockResolvedValue({ data: { session: null }, error: { code: 'over_request_rate_limit', message: 'Please wait before trying again.' } });
    await expect(signInAnonymously('Alex')).rejects.toThrow('Please wait before trying again.');
  });
});

describe('name-only profile updates', () => {
  it('sends only the trimmed name to the new RPC', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await updateProfile('  Zoë  O’Connor  ');
    expect(rpc).toHaveBeenCalledExactlyOnceWith('update_my_profile_name', { new_display_name: 'Zoë  O’Connor' });
  });

  it('does not perform availability checks when a name is reused', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await updateProfile('Alex');
    await updateProfile('Alex');
    expect(rpc.mock.calls).toEqual([
      ['update_my_profile_name', { new_display_name: 'Alex' }],
      ['update_my_profile_name', { new_display_name: 'Alex' }],
    ]);
  });

  it.each(['', '  ', 'A'.repeat(61)])('rejects an invalid name without an RPC', async name => {
    await expect(updateProfile(name)).rejects.toThrow(/name/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('surfaces the server authentication guard instead of reporting success', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'Authentication required' } });
    await expect(updateProfile('Alex')).rejects.toThrow('Authentication required');
  });

  it('does not expose an action for changing the server-assigned friend code', () => {
    expect(backend).not.toHaveProperty('updateFriendCode');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('authoritative campfire snapshots', () => {
  it.each(['beach', 'snow'] as const)('accepts the exact shared %s wallet independently of legacy personal counters', async background => {
    const wallet = circleShop({ balance: 68, unlocked: ['color:blue', `background:${background}`], background });
    rpc.mockResolvedValue({ data: { ...snapshot(), circleShop: wallet }, error: null });
    const result = await loadSnapshot();
    expect(result.circleShop).toEqual(wallet);
    expect(result.circleShop?.balance).not.toBe(result.campfire.groupGolden);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('get_app_snapshot_v5', { tz: 'America/Los_Angeles' });
  });

  it('keeps a spent-down shared balance at zero instead of adding a local starter gift', async () => {
    rpc.mockResolvedValue({ data: { ...snapshot(), circleShop: circleShop({ balance: 0 }) }, error: null });
    expect((await loadSnapshot()).circleShop?.balance).toBe(0);
  });

  it('retains every new accessory unlock alongside the existing shared catalog', async () => {
    const wallet = circleShop({ balance: 59, unlocked: [
      'hat:cat-ears', 'hat:bubble-gum', 'hat:googly-eyes', 'hat:disguise-glasses',
      'hat:crown', 'color:blue', 'background:snow',
    ], background: 'snow' });
    rpc.mockResolvedValue({ data: { ...snapshot(), circleShop: wallet }, error: null });
    expect((await loadSnapshot()).circleShop).toEqual(wallet);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('get_app_snapshot_v5', { tz: 'America/Los_Angeles' });
  });

  it.each([undefined, null])('leaves missing old-server wallet data (%s) unavailable', async value => {
    rpc.mockResolvedValue({ data: { ...snapshot(), circleShop: value }, error: null });
    const result = await loadSnapshot();
    expect(result.circleShop).toBeUndefined();
    expect(result.campfire.groupGolden).toBe(6);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['negative balance', circleShop({ balance: -1 })],
    ['unknown unlock', { ...circleShop(), unlocked: ['hat:admin'] }],
    ['missing day bounds', { ...circleShop(), dayStartedAt: undefined }],
    ['unowned background', circleShop({ background: 'beach' })],
    ['unowned snow', circleShop({ background: 'snow', unlocked: ['background:beach'] })],
    ['wrong shape', false],
  ])('rejects a present but invalid shared wallet: %s', async (_name, value) => {
    rpc.mockResolvedValue({ data: { ...snapshot(), circleShop: value }, error: null });
    await expect(loadSnapshot()).rejects.toThrow('wallet could not be verified');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('passes saved cosmetics through self, friends, request senders, and campsite seats', async () => {
    const payload = snapshot();
    const character = { appearance: { hat: 'cat', body: 'tall' } as const, revision: 3 };
    payload.profile.character = character;
    payload.friends[0].character = character;
    payload.campfire.seats[1].character = character;
    rpc.mockResolvedValue({ data: payload, error: null });
    const result = await loadSnapshot();
    expect(result.profile.character).toEqual(character);
    expect(result.friends[0].character).toEqual(character);
    expect(result.campfire.seats[1].character).toEqual(character);
  });
  it.each(['cat-ears', 'sunflower', 'lollipop', 'bubble-gum', 'googly-eyes', 'disguise-glasses'] as const)(
    'does not discard %s on any snapshot character surface', async hat => {
      const payload = snapshot();
      const character = { appearance: { hat, body: 'short' } as const, revision: 7 };
      payload.profile.character = character;
      payload.friends[0].character = character;
      payload.campfire.seats[0].character = character;
      payload.campfire.seats[1].character = character;
      payload.incomingRequests = [{ id: 'request', friend: payload.friends[0], minutes: 15,
        categoryLabel: 'Selected apps', reason: '', status: 'pending',
        createdAt: '2026-09-12T17:00:00Z', expiresAt: '2026-09-12T17:20:00Z' }];
      rpc.mockResolvedValue({ data: payload, error: null });
      const result = await loadSnapshot();
      expect(result.profile.character).toEqual(character);
      expect(result.friends[0].character).toEqual(character);
      expect(result.incomingRequests[0].friend.character).toEqual(character);
      expect(result.campfire.seats.every(seat => seat.character?.appearance?.hat === hat)).toBe(true);
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['approved', 'denied', 'cancelled', 'expired'] as const)(
    'keeps the server burn after a request is %s and no longer pending',
    async (status) => {
      const payload = snapshot();
      if (status === 'approved' || status === 'denied') {
        payload.recentDecision = { id: 'request', minutes: 5, status, decidedAt: '2026-09-12T17:00:00Z' };
      }
      rpc.mockResolvedValue({ data: payload, error: null });

      const result = await loadSnapshot();

      expect(result.outgoingRequest).toBeNull();
      expect(result.campfire).toEqual(payload.campfire);
      expect(result.campfire.seats.every((seat) => seat.askedToday)).toBe(true);
      expect(rpc).toHaveBeenCalledExactlyOnceWith('get_app_snapshot_v5', { tz: 'America/Los_Angeles' });
    },
  );

  it('preserves an authoritative fresh marshmallow without inventing a burn', async () => {
    const payload = snapshot();
    payload.campfire.seats[0].askedToday = false;
    payload.campfire.seats[0].streak = 3;
    rpc.mockResolvedValue({ data: payload, error: null });

    expect((await loadSnapshot()).campfire).toEqual(payload.campfire);
  });

  it('rejects a legacy snapshot without campfire data instead of making friends look clean', async () => {
    rpc.mockResolvedValue({ data: { ...snapshot(), campfire: undefined }, error: null });

    await expect(loadSnapshot()).rejects.toThrow('backend needs an update');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects missing peer standing rather than treating unknown as false', async () => {
    const payload = snapshot();
    const seats = payload.campfire.seats.map((seat) => seat.isYou ? seat : { ...seat, askedToday: undefined });
    rpc.mockResolvedValue({ data: { ...payload, campfire: { ...payload.campfire, seats } }, error: null });

    await expect(loadSnapshot()).rejects.toThrow('backend needs an update');
  });

  it('rejects a snapshot with no standing for the signed-in person', async () => {
    const payload = snapshot();
    payload.campfire.seats = payload.campfire.seats.filter((seat) => !seat.isYou);
    rpc.mockResolvedValue({ data: payload, error: null });

    await expect(loadSnapshot()).rejects.toThrow('backend needs an update');
  });

  it.each(['PGRST202', 'NETWORK_ERROR'])('does not retry an RPC failure (%s) through the legacy snapshot or without the timezone', async (code) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: 'Snapshot unavailable' } });

    await expect(loadSnapshot()).rejects.toThrow(code === 'PGRST202'
      ? 'Your circle needs a server update for the new accessories.'
      : 'Snapshot unavailable');
    expect(rpc).toHaveBeenCalledExactlyOnceWith('get_app_snapshot_v5', { tz: 'America/Los_Angeles' });
  });
});

describe('server-authoritative circle purchases', () => {
  it('binds the purchase to the displayed price without sending a balance or requested unlocks', async () => {
    const confirmed = circleShop({ balance: 69, unlocked: ['background:beach'] });
    rpc.mockResolvedValue({ data: confirmed, error: null });
    expect(await purchaseCircleItem('our-circle', 'background:beach')).toEqual(confirmed);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('purchase_circle_item_v5', {
      target_group_id: 'our-circle', item_id: 'background:beach', expected_cost: 30,
    });
    expect(Object.keys(rpc.mock.calls[0][1]).sort()).toEqual(['expected_cost', 'item_id', 'target_group_id']);
  });

  it.each(SHOP_ITEMS)('sends the exact displayed $cost s’more confirmation for $id', async ({ id, cost }) => {
    const confirmed = circleShop({ balance: 99 - cost, unlocked: [id] });
    rpc.mockResolvedValue({ data: confirmed, error: null });

    expect(await purchaseCircleItem('our-circle', id)).toEqual(confirmed);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('purchase_circle_item_v5', {
      target_group_id: 'our-circle', item_id: id, expected_cost: cost,
    });
  });

  it.each([
    { code: 'P0001', message: 'The price changed. Refresh the shop before buying.' },
    { code: 'PGRST202', message: 'The price-confirmed purchase function is unavailable.' },
  ])('does not fall back to an unpriced purchase after $code', async error => {
    rpc.mockResolvedValue({ data: circleShop({ unlocked: ['hat:crown'] }), error });

    await expect(purchaseCircleItem('our-circle', 'hat:crown')).rejects.toThrow(error.code === 'PGRST202'
      ? 'Your circle needs a server update for the new accessories.' : error.message);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('purchase_circle_item_v5', {
      target_group_id: 'our-circle', item_id: 'hat:crown', expected_cost: 10,
    });
  });

  it.each([
    ['other circle', circleShop({ id: 'different-circle', unlocked: ['hat:crown'] })],
    ['missing purchased unlock', circleShop({ unlocked: ['color:blue'] })],
    ['malformed wallet', circleShop({ balance: -1, unlocked: ['hat:crown'] })],
    ['missing response', null],
  ])('does not confirm a purchase from %s', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    await expect(purchaseCircleItem('our-circle', 'hat:crown')).rejects.toThrow('purchase was not confirmed');
    // Do not automatically retry a purchase after an ambiguous response.
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('propagates server refusal even when a response includes wallet-shaped data', async () => {
    rpc.mockResolvedValue({
      data: circleShop({ unlocked: ['hat:crown'] }),
      error: { code: 'P0001', message: 'Your circle does not have enough s’mores.' },
    });
    await expect(purchaseCircleItem('our-circle', 'hat:crown')).rejects.toThrow('does not have enough s’mores');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects missing groups and unsupported items before an RPC', async () => {
    await expect(purchaseCircleItem('', 'hat:crown')).rejects.toThrow('Choose an item');
    await expect(purchaseCircleItem('our-circle', 'hat:admin' as never)).rejects.toThrow('Choose an item');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('confirmed shared campsite changes', () => {
  it('preserves new accessory ownership when changing an existing campsite', async () => {
    const confirmed = circleShop({ unlocked: ['hat:cat-ears', 'hat:bubble-gum', 'hat:googly-eyes', 'hat:disguise-glasses', 'background:beach'], background: 'beach' });
    rpc.mockResolvedValue({ data: confirmed, error: null });
    expect(await changeCircleBackground('our-circle', 'beach')).toEqual(confirmed);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('set_circle_background_v5', {
      target_group_id: 'our-circle', new_background: 'beach',
    });
  });
  it.each(['beach', 'snow'] as const)('requires selected %s in the same group’s returned wallet', async background => {
    const confirmed = circleShop({ balance: 69, unlocked: [`background:${background}`], background });
    rpc.mockResolvedValue({ data: confirmed, error: null });
    expect(await changeCircleBackground('our-circle', background)).toEqual(confirmed);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('set_circle_background_v5', {
      target_group_id: 'our-circle', new_background: background,
    });
  });

  it.each([
    ['other circle', circleShop({ id: 'other-circle', unlocked: ['background:beach'], background: 'beach' })],
    ['unchanged background', circleShop({ unlocked: ['background:beach'] })],
    ['missing unlock', circleShop({ background: 'beach' })],
    ['malformed wallet', circleShop({ balance: -2, unlocked: ['background:beach'], background: 'beach' })],
    ['missing response', null],
  ])('rejects an unconfirmed background response: %s', async (_name, data) => {
    rpc.mockResolvedValue({ data, error: null });
    await expect(changeCircleBackground('our-circle', 'beach')).rejects.toThrow('background was not confirmed');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('propagates a server membership denial', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'You are no longer in this circle.' } });
    await expect(changeCircleBackground('our-circle', 'forest')).rejects.toThrow('no longer in this circle');
  });

  it('rejects a legacy forest fallback or an unrelated beach unlock when selecting snow', async () => {
    for (const confirmed of [
      circleShop({ unlocked: ['background:snow'], background: 'forest' }),
      circleShop({ unlocked: ['background:beach'], background: 'snow' }),
    ]) {
      rpc.mockResolvedValueOnce({ data: confirmed, error: null });
      await expect(changeCircleBackground('our-circle', 'snow')).rejects.toThrow('background was not confirmed');
    }
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('rejects unsupported backgrounds and missing groups before an RPC', async () => {
    await expect(changeCircleBackground('', 'forest')).rejects.toThrow('supported background');
    await expect(changeCircleBackground('our-circle', 'space' as never)).rejects.toThrow('supported background');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('joining a shared circle', () => {
  it('trims and uppercases the code without sending caller identity, funds or unlocks', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await joinSharedCircle('  caLeb12 \n');
    expect(rpc).toHaveBeenCalledExactlyOnceWith('join_shared_circle_v5', { friend_code_input: 'CALEB12' });
  });

  it.each(['', '   ', 'ABC', 'A'.repeat(17), 'AB CD', 'AB-CD', 'C🍫DE', 'ÄBCD'])('rejects invalid friend code %s before an RPC', async code => {
    await expect(joinSharedCircle(code)).rejects.toThrow('4–16 letters or numbers');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not report joining when the server refuses it', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'That circle is full.' } });
    await expect(joinSharedCircle('TEST1234')).rejects.toThrow('That circle is full.');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe('shared character writes', () => {
  it.each(['cat-ears', 'sunflower', 'lollipop', 'bubble-gum', 'googly-eyes', 'disguise-glasses'] as const)(
    'saves and reconciles %s without changing the character RPC contract', async hat => {
      const saved = { appearance: { hat, body: 'tall' } as const, revision: 9 };
      rpc.mockResolvedValue({ data: saved, error: null });
      expect(await updateCharacter('self', saved.appearance, 8)).toEqual(saved);
      expect(rpc).toHaveBeenCalledExactlyOnceWith('update_my_character', {
        target_profile_id: 'self', new_hat: hat, new_body: 'tall', new_color: 'cream', expected_revision: 8,
      });
      profileRead.mockResolvedValue({ data: { id: 'self', character_hat: hat, character_body: 'tall', character_color: 'cream', character_revision: 9 }, error: null });
      expect(await loadSharedCharacter('self')).toEqual(saved);
    },
  );
  it.each(BODY_COLORS.filter(({ id }) => id !== 'cream'))('preserves $label in writes and reconciliation', async ({ id: color }) => {
    const saved = { appearance: { hat: 'crown', body: 'short', color } as const, revision: 9 };
    rpc.mockResolvedValue({ data: saved, error: null });
    expect(await updateCharacter('self', saved.appearance, 8)).toEqual(saved);
    expect(rpc).toHaveBeenCalledWith('update_my_character', {
      target_profile_id: 'self', new_hat: 'crown', new_body: 'short', new_color: color, expected_revision: 8,
    });
    profileRead.mockResolvedValue({ data: { id: 'self', character_hat: 'crown', character_body: 'short', character_color: color, character_revision: 9 }, error: null });
    expect(await loadSharedCharacter('self')).toEqual(saved);
  });
  it('reconciles the exact profile through RLS before retrying an ambiguous save', async () => {
    profileRead.mockResolvedValue({ data: { id: 'self', character_hat: 'cow', character_body: 'tall', character_revision: 7 }, error: null });
    expect(await loadSharedCharacter('self')).toEqual({ appearance: { hat: 'cow', body: 'tall' }, revision: 7 });
    expect(profileRead).toHaveBeenCalledExactlyOnceWith('profiles', 'id,character_hat,character_body,character_color,character_revision', 'id', 'self');
  });

  it('does not reconcile a denied read or wrong profile as a successful saved look', async () => {
    profileRead.mockResolvedValue({ data: null, error: { message: 'Profile is not visible' } });
    await expect(loadSharedCharacter('self')).rejects.toThrow('not visible');
    profileRead.mockResolvedValue({ data: { id: 'other' }, error: null });
    await expect(loadSharedCharacter('self')).rejects.toThrow('verify your camper');
  });
  it('sends the exact profile identity and expected revision with supported cosmetics only', async () => {
    const saved = { appearance: { hat: 'cow', body: 'tall' } as const, revision: 5 };
    rpc.mockResolvedValue({ data: saved, error: null });
    expect(await updateCharacter('own-profile', saved.appearance, 4)).toEqual(saved);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('update_my_character', {
      target_profile_id: 'own-profile', new_hat: 'cow', new_body: 'tall', new_color: 'cream', expected_revision: 4,
    });
  });

  it('does not mark a look shared if the server rejected a stale revision or changed identity', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '40001', message: 'Your camper changed on another device.' } });
    await expect(updateCharacter('old-profile', { hat: 'cat', body: 'short' }, 0)).rejects.toThrow('another device');
    rpc.mockResolvedValue({ data: null, error: { message: 'This camper belongs to a different account' } });
    await expect(updateCharacter('old-profile', { hat: 'cat', body: 'short' }, 0)).rejects.toThrow('different account');
  });

  it('distinguishes a server awaiting migration from a completed shared save', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'RPC missing' } });
    await expect(updateCharacter('self', { hat: 'cat', body: 'short' }, 0)).rejects.toThrow('not enabled on the server');
    rpc.mockResolvedValue({ data: { appearance: null, revision: 1 }, error: null });
    await expect(updateCharacter('self', { hat: 'cat', body: 'short' }, 0)).rejects.toThrow('did not confirm');
  });
});

describe('accessory catalog migration boundary', () => {
  it.each([
    ['snapshot', 'get_app_snapshot_v5', () => loadSnapshot()],
    ['purchase', 'purchase_circle_item_v5', () => purchaseCircleItem('our-circle', 'hat:cat-ears')],
    ['background', 'set_circle_background_v5', () => changeCircleBackground('our-circle', 'forest')],
    ['join', 'join_shared_circle_v5', () => joinSharedCircle('TEST1234')],
  ] as const)('fails clearly for missing %s migration without a legacy fallback', async (_operation, rpcName, run) => {
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Function not in schema cache' } });
    await expect(run()).rejects.toThrow('Your circle needs a server update for the new accessories.');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][0]).toBe(rpcName);
  });
});
