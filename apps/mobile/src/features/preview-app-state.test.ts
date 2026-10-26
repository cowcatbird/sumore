/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { Decision, GrantMinutes } from '@/types/domain';
import { demoAskBlockReason, demoLimitBaseTotal, demoLimitRemaining, demoLimitTotal, type DemoAction } from '@/domain/demo-screen-time';
import { initialPreviewShop, purchasePreviewItem, setPreviewBackground } from './preview-circle-shop';
import * as previewState from './preview-app-state';
import { addPreviewFriend, blockPreviewPerson, cancelPreviewRequest, createPreviewAppState, decidePreviewRequest, expirePreviewRequests,
  leavePreviewCircle, unblockPreviewPerson,
  joinPreviewCircle, previewAppSnapshot, refillPreviewRequests, resetPreviewAppState, respondToPreviewOutgoing, sendPreviewRequest,
  setPreviewCamperCount, updatePreviewGroupPolicy, updatePreviewProfile, updatePreviewScreenTime } from './preview-app-state';

const now = new Date('2026-09-22T12:00:00.000Z');
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
function exhaustedPreviewState(state = createPreviewAppState(now)) {
  for (const action of [{ type: 'toggle', app: 'Games' }, { type: 'minutes', minutes: 5 },
    { type: 'enable' }, { type: 'simulate' }] satisfies DemoAction[]) state = updatePreviewScreenTime(state, action);
  return state;
}

describe('session-only preview app state', () => {
  it('starts with a stable isolated profile, matching roster and sample requests', () => {
    const state = createPreviewAppState(now);
    const snapshot = previewAppSnapshot(state, initialPreviewShop(now), now);
    expect(snapshot.profile).toEqual({ id: 'local-art-preview', displayName: 'Camper', friendCode: expect.stringMatching(/^[A-F0-9]{8}$/), initials: 'C' });
    expect(snapshot.friends.map(friend => friend.displayName)).toEqual(['Scout', 'Wren', 'Milo']);
    expect(snapshot.campfire.seats.map(seat => seat.id)).toEqual([snapshot.profile.id, ...snapshot.friends.map(friend => friend.id)]);
    expect(snapshot.campfire.seats.every(seat => !seat.askedToday)).toBe(true);
    expect(snapshot.incomingRequests).toHaveLength(2);
    snapshot.incomingRequests.forEach(request => {
      expect(snapshot.friends).toContain(request.friend);
      expect(request.status).toBe('pending');
      expect(request.expiresAt).toBe(later(20).toISOString());
    });
    expect(snapshot.outgoingRequest).toBeNull();
    expect(snapshot.recentDecision).toBeNull();
    expect(snapshot.circleShop?.balance).toBe(0);
    expect(state.screenTime).toMatchObject({ apps: [], enabled: false, used: 0, approvedMinutes: 0 });
  });

  it.each([1, 4, 6])('keeps %s campers, friend cards and incoming authors consistent', count => {
    const state = setPreviewCamperCount(createPreviewAppState(now), count);
    const snapshot = previewAppSnapshot(state, undefined, now);
    expect(snapshot.campfire.seats).toHaveLength(count);
    expect(snapshot.friends).toHaveLength(count - 1);
    expect(snapshot.campfire.seats.slice(1).map(seat => seat.id)).toEqual(snapshot.friends.map(friend => friend.id));
    expect(snapshot.incomingRequests.every(request => snapshot.friends.some(friend => friend.id === request.friend.id))).toBe(true);
    if (count === 1) expect(refillPreviewRequests(state, now).incomingRequests).toEqual([]);
  });

  it('retains count clamping and ignores invalid counts', () => {
    const state = createPreviewAppState(now);
    expect(setPreviewCamperCount(state, Number.NaN)).toBe(state);
    expect(setPreviewCamperCount(state, Infinity)).toBe(state);
    expect(setPreviewCamperCount(state, -5).friends).toHaveLength(0);
    expect(setPreviewCamperCount(state, 100).friends).toHaveLength(5);
  });

  it('updates the name and own seat without changing identity or other sample campers', () => {
    const initial = createPreviewAppState(now);
    const state = updatePreviewProfile(initial, '  Robin Maple  ');
    const snapshot = previewAppSnapshot(state, undefined, now);
    expect(snapshot.profile).toEqual({ ...initial.profile, displayName: 'Robin Maple', initials: 'RM' });
    expect(snapshot.campfire.seats[0]).toMatchObject({ displayName: 'Robin Maple', initials: 'RM', isYou: true });
    expect(snapshot.friends).toEqual(initial.friends);
    expect(initial.profile.displayName).toBe('Camper');
    expect(updatePreviewProfile(initial, '🌲 Camper').profile.initials).toBe('🌲C');
  });

  it.each(['', '   ', 'x'.repeat(61)])('rejects invalid names without changing state', name => {
    const state = createPreviewAppState(now);
    expect(() => updatePreviewProfile(state, name)).toThrow('Enter a name');
    expect(state.profile.displayName).toBe('Camper');
  });

  it.each(['approved', 'denied'] as const)('handles an incoming %s decision locally without a self grant', decision => {
    const state = createPreviewAppState(now);
    const [request, other] = state.incomingRequests;
    const next = decidePreviewRequest(state, request.id, decision, now);
    expect(next.incomingRequests).toEqual([other]);
    expect(next.recentDecision).toBeNull();
    expect(next.profile).toBe(state.profile);
    expect(next.askedToday).toBe(false);
    expect(next.screenTime).toBe(state.screenTime);
    expect(state.incomingRequests).toHaveLength(2);
    expect(() => decidePreviewRequest(next, request.id, decision, now)).toThrow('no longer available');
  });

  it('refills only active sample authors with fresh IDs and expiration', () => {
    const state = createPreviewAppState(now);
    const next = refillPreviewRequests(state, later(5));
    expect(next.incomingRequests).toHaveLength(2);
    expect(next.incomingRequests[0].id).not.toBe(state.incomingRequests[0].id);
    expect(next.incomingRequests[0].expiresAt).toBe(later(25).toISOString());
    expect(() => decidePreviewRequest(next, state.incomingRequests[0].id, 'approved', later(5))).toThrow('no longer available');
    expect(() => decidePreviewRequest(next, next.incomingRequests[0].id, 'expired' as Decision, later(5))).toThrow('Choose Approve or Deny');
  });

  it.each([5, 10, 15, 30] as const)('sends a local %s-minute ask and prevents another pending request', minutes => {
    const state = sendPreviewRequest(exhaustedPreviewState(), minutes, 'Finishing a chat', now);
    expect(state.outgoingRequest).toMatchObject({ minutes, status: 'pending', createdAt: now.toISOString(), expiresAt: later(20).toISOString() });
    expect(state.askedToday).toBe(true);
    expect(() => sendPreviewRequest(state, 15, '', now)).toThrow('pending request');
  });

  it('rejects invalid requests and requires a sample circle member', () => {
    const state = createPreviewAppState(now);
    expect(() => sendPreviewRequest(state, 7 as GrantMinutes, '', now)).toThrow('Choose 5, 10, 15 or 30');
    expect(() => sendPreviewRequest(state, 15, 'x'.repeat(241), now)).toThrow('240 characters');
    expect(() => sendPreviewRequest(setPreviewCamperCount(state, 1), 15, '', now)).toThrow('SCOUT');
    expect(state.outgoingRequest).toBeNull();
  });

  it('clears requests at the exact expiration boundary without undoing the asked day', () => {
    const state = sendPreviewRequest(exhaustedPreviewState(), 15, '', now);
    expect(expirePreviewRequests(state, new Date(later(20).getTime() - 1))).toBe(state);
    const expired = expirePreviewRequests(state, later(20));
    expect(expired.incomingRequests).toEqual([]);
    expect(expired.outgoingRequest).toBeNull();
    expect(expired.recentDecision).toBeNull();
    expect(expired.askedToday).toBe(true);
    expect(() => decidePreviewRequest(state, state.incomingRequests[0].id, 'approved', later(20))).toThrow('no longer available');
    expect(() => respondToPreviewOutgoing(state, 'approved', later(20))).toThrow('Send a request first');
    expect(sendPreviewRequest(state, 10, '', later(20)).outgoingRequest?.minutes).toBe(10);
  });

  it('cancels locally, keeps only your day burnt, and never mutates wallet or purchases', () => {
    const shop = Object.freeze(purchasePreviewItem({ ...initialPreviewShop(now), balance: 200 }, 'color:red'));
    const state = cancelPreviewRequest(sendPreviewRequest(exhaustedPreviewState(), 15, '', now));
    const snapshot = previewAppSnapshot(state, shop, now);
    expect(snapshot.outgoingRequest).toBeNull();
    expect(snapshot.recentDecision).toBeNull();
    expect(snapshot.campfire.seats.map(seat => seat.askedToday)).toEqual([true, false, false, false]);
    expect(snapshot.circleShop).toEqual({ ...shop, askedToday: true, eligibleToday: false });
    expect(shop.askedToday).toBe(false);
    expect(shop.balance).toBe(195);
    expect(shop.unlocked).toEqual(['color:red']);
    expect(cancelPreviewRequest(state).askedToday).toBe(true);
  });

  it.each(['approved', 'denied'] as const)('can simulate an outgoing %s decision without a native grant', decision => {
    const state = sendPreviewRequest(exhaustedPreviewState(), 15, '', now);
    const next = respondToPreviewOutgoing(state, decision, later(1));
    expect(next.outgoingRequest).toBeNull();
    expect(next.recentDecision).toEqual({ id: state.outgoingRequest!.id, minutes: 15, status: decision, decidedAt: later(1).toISOString() });
    expect(next.askedToday).toBe(true);
    expect(next.screenTime.approvedMinutes).toBe(decision === 'approved' ? 15 : 0);
    expect(next.screenTime.used).toBe(5);
  });

  it('keeps the visible five-per-hour demo limit and permits later requests', () => {
    let state = exhaustedPreviewState();
    for (let index = 0; index < 5; index += 1) state = cancelPreviewRequest(sendPreviewRequest(state, 5, '', now));
    expect(() => sendPreviewRequest(state, 5, '', later(59))).toThrow('five requests per hour');
    expect(sendPreviewRequest(state, 5, '', later(60)).outgoingRequest).not.toBeNull();
  });

  it('rejects demo asks before setup, while time remains, and after stopping', () => {
    const fresh = createPreviewAppState(now);
    expect(() => sendPreviewRequest(fresh, 15, '', now)).toThrow('Set up a daily allowance');
    const selected = updatePreviewScreenTime(fresh, { type: 'toggle', app: 'Games' });
    expect(() => sendPreviewRequest(selected, 15, '', now)).toThrow('Set up a daily allowance');
    const enabled = updatePreviewScreenTime(selected, { type: 'enable' });
    expect(() => sendPreviewRequest(enabled, 15, '', now)).toThrow('remaining time');
    const stopped = updatePreviewScreenTime(exhaustedPreviewState(), { type: 'stop' });
    expect(() => sendPreviewRequest(stopped, 15, '', now)).toThrow('Set up a daily allowance');
    for (const state of [fresh, selected, enabled, stopped]) {
      expect(state.outgoingRequest).toBeNull(); expect(state.askedToday).toBe(false); expect(state.sentAt).toEqual([]);
    }
  });

  it.each([5, 10, 15, 30] as const)('atomically credits exactly %s minutes only once for this user’s approval', minutes => {
    const requested = sendPreviewRequest(exhaustedPreviewState(), minutes, '', now);
    expect(requested.screenTime.approvedMinutes).toBe(0);
    const approved = respondToPreviewOutgoing(requested, 'approved', later(1), requested.outgoingRequest!.id);
    expect(approved.outgoingRequest).toBeNull();
    expect(approved.screenTime.used).toBe(5);
    expect(demoLimitBaseTotal(approved.screenTime)).toBe(5);
    expect(demoLimitTotal(approved.screenTime)).toBe(5 + minutes);
    expect(demoLimitRemaining(approved.screenTime)).toBe(minutes);
    expect(() => respondToPreviewOutgoing(approved, 'approved', later(1), requested.outgoingRequest!.id)).toThrow('Send a request first');
    expect(() => sendPreviewRequest(approved, 5, '', later(1))).toThrow('remaining time');
    expect(approved.screenTime.approvedMinutes).toBe(minutes);
  });

  it('rejects a stale response ID after a later request replaces an earlier pending request', () => {
    const first = sendPreviewRequest(exhaustedPreviewState(), 5, '', now);
    const second = sendPreviewRequest(cancelPreviewRequest(first), 30, '', later(1));
    expect(second.outgoingRequest!.id).not.toBe(first.outgoingRequest!.id);
    expect(() => respondToPreviewOutgoing(second, 'approved', later(2), first.outgoingRequest!.id)).toThrow('no longer pending');
    expect(() => respondToPreviewOutgoing(second, 'approved', later(2), null)).toThrow('no longer pending');
    expect(second.screenTime.approvedMinutes).toBe(0);
    expect(respondToPreviewOutgoing(second, 'approved', later(2), second.outgoingRequest!.id).screenTime.approvedMinutes).toBe(30);
  });

  it('keeps request IDs monotonic across full resets so old 5-minute callbacks cannot approve new 30-minute requests', () => {
    const old = sendPreviewRequest(exhaustedPreviewState(), 5, '', now);
    const oldId = old.outgoingRequest!.id;
    const reset = resetPreviewAppState(old, later(1));
    expect(reset.requestSequence).toBeGreaterThan(old.requestSequence);
    expect(reset).toMatchObject({ askedToday: false, burnt: false, outgoingRequest: null, recentDecision: null, sentAt: [] });
    expect(reset.screenTime).toMatchObject({ apps: [], enabled: false, used: 0, approvedMinutes: 0 });
    expect(reset.incomingRequests.every(request => !old.incomingRequests.some(previous => previous.id === request.id))).toBe(true);
    expect(() => decidePreviewRequest(reset, old.incomingRequests[0].id, 'approved', later(1))).toThrow('no longer available');
    const newer = sendPreviewRequest(exhaustedPreviewState(reset), 30, '', later(1));
    expect(newer.outgoingRequest!.id).not.toBe(oldId);
    expect(newer.requestSequence).toBeGreaterThan(reset.requestSequence);
    expect(() => respondToPreviewOutgoing(newer, 'approved', later(2), oldId)).toThrow('no longer pending');
    expect(newer.screenTime.approvedMinutes).toBe(0);
    const approved = respondToPreviewOutgoing(newer, 'approved', later(2), newer.outgoingRequest!.id);
    expect(approved.screenTime.approvedMinutes).toBe(30);
    expect(resetPreviewAppState(resetPreviewAppState(approved, later(3)), later(3)).requestSequence).toBe(approved.requestSequence + 2);
    const provider = readFileSync(new URL('./local-art-preview.tsx', import.meta.url), 'utf8');
    expect(provider).toContain('mutateMembership(current => resetPreviewAppState(current))');
    expect(provider).not.toContain('commitDemo(createPreviewAppState())');
  });

  it('does not credit denied, cancelled, expired or another camper’s requests', () => {
    const pending = sendPreviewRequest(exhaustedPreviewState(), 15, '', now);
    const denied = respondToPreviewOutgoing(pending, 'denied', later(1));
    expect(denied.screenTime).toBe(pending.screenTime);
    const cancelled = cancelPreviewRequest(pending);
    expect(() => respondToPreviewOutgoing(cancelled, 'approved', later(1))).toThrow('Send a request first');
    const expired = expirePreviewRequests(pending, later(20));
    expect(() => respondToPreviewOutgoing(expired, 'approved', later(20))).toThrow('Send a request first');
    const friendApproved = decidePreviewRequest(pending, pending.incomingRequests[0].id, 'approved', later(1));
    expect(friendApproved.outgoingRequest).toBe(pending.outgoingRequest);
    for (const state of [denied, cancelled, expired, friendApproved]) expect(state.screenTime.approvedMinutes).toBe(0);
  });

  it('adds approved time to per-app totals without changing selected allocations', () => {
    let state = createPreviewAppState(now);
    for (const action of [{ type: 'toggle', app: 'Games' }, { type: 'toggle', app: 'Social feed' },
      { type: 'perApp', allocations: { Games: 6, 'Social feed': 7 } },
      { type: 'simulate' }, { type: 'simulate' }, { type: 'simulate' }] satisfies DemoAction[]) state = updatePreviewScreenTime(state, action);
    const allocations = state.screenTime.allocations;
    state = respondToPreviewOutgoing(sendPreviewRequest(state, 15, '', now), 'approved', later(1));
    expect(state.screenTime.allocations).toBe(allocations); expect(state.screenTime.used).toBe(13);
    expect(demoLimitTotal(state.screenTime)).toBe(28); expect(demoLimitRemaining(state.screenTime)).toBe(15);
    state = updatePreviewScreenTime(state, { type: 'simulate' });
    expect(demoLimitRemaining(state.screenTime)).toBe(10);
    expect(demoLimitRemaining(state.screenTime) / demoLimitTotal(state.screenTime)).toBe(10 / 28);
  });

  it('cancels pending approval before policy changes so it cannot grant into a new configuration', () => {
    const pending = sendPreviewRequest(exhaustedPreviewState(), 15, '', now);
    for (const action of [{ type: 'stop' }, { type: 'reset' }] satisfies DemoAction[]) {
      const next = updatePreviewScreenTime(pending, action);
      expect(next.outgoingRequest).toBeNull(); expect(next.recentDecision).toBeNull();
      expect(next.askedToday).toBe(true); expect(next.screenTime.approvedMinutes).toBe(0);
      expect(() => respondToPreviewOutgoing(next, 'approved', later(1), pending.outgoingRequest!.id)).toThrow('Send a request first');
    }
    const stopped = updatePreviewScreenTime(pending, { type: 'stop' });
    const changed = updatePreviewScreenTime(stopped, { type: 'minutes', minutes: 17 });
    const enabled = updatePreviewScreenTime(changed, { type: 'enable' });
    expect(enabled.screenTime).toMatchObject({ used: 0, approvedMinutes: 0, minutes: 17 });
    expect(enabled.outgoingRequest).toBeNull();
  });

  it('keeps pending requests through presentation/usage actions or rejected configuration edits', () => {
    const pending = sendPreviewRequest(exhaustedPreviewState(), 15, '', now);
    for (const action of [{ type: 'choose' }, { type: 'done' }, { type: 'simulate' },
      { type: 'enable' }, { type: 'minutes', minutes: 19 }, { type: 'toggle', app: 'Games' },
      { type: 'perApp', allocations: { Games: 19 } }] satisfies DemoAction[]) {
      expect(updatePreviewScreenTime(pending, action).outgoingRequest).toBe(pending.outgoingRequest);
    }
    // UI dispatch cannot invent a successful approval without a request.
    expect(updatePreviewScreenTime(pending, { type: 'grant', minutes: 30 })).toBe(pending);
  });

  it('clears old approval presentation when the demo stops, restarts or resets', () => {
    const approved = respondToPreviewOutgoing(sendPreviewRequest(exhaustedPreviewState(), 15, '', now), 'approved', later(1));
    const stopped = updatePreviewScreenTime(approved, { type: 'stop' });
    expect(stopped.recentDecision).toBeNull(); expect(demoAskBlockReason(stopped.screenTime)).toContain('Set up');
    const restarted = updatePreviewScreenTime(stopped, { type: 'enable' });
    expect(restarted.recentDecision).toBeNull(); expect(restarted.screenTime.approvedMinutes).toBe(0);
    const reset = updatePreviewScreenTime(approved, { type: 'reset' });
    expect(reset.recentDecision).toBeNull(); expect(reset.screenTime.apps).toEqual([]);
    expect(reset.screenTime).toMatchObject({ used: 0, approvedMinutes: 0, enabled: false });
  });

  it('keeps screen-time state at the session provider while independent screen snapshots are recreated', () => {
    const approved = respondToPreviewOutgoing(sendPreviewRequest(exhaustedPreviewState(), 15, '', now), 'approved', later(1));
    const state = updatePreviewScreenTime(approved, { type: 'simulate' });
    const firstScreen = previewAppSnapshot(state, undefined, later(2));
    const nextScreen = previewAppSnapshot(state, undefined, later(3));
    expect(firstScreen).not.toBe(nextScreen);
    expect(state.screenTime).toMatchObject({ enabled: true, used: 10, approvedMinutes: 15 });
    expect(demoLimitRemaining(state.screenTime)).toBe(10);
    // No simulated allocations or app choices become backend snapshot fields.
    expect(firstScreen).not.toHaveProperty('screenTime');
    expect(nextScreen).not.toHaveProperty('screenTime');
    const provider = readFileSync(new URL('./local-art-preview.tsx', import.meta.url), 'utf8');
    expect(provider).toContain('const [demo, setDemo] = useState(() => createPreviewAppState())');
    expect(provider).toContain('screenTime: demo.screenTime, updateScreenTime');
  });

  it('only accepts the explicit SCOUT demo code and never duplicates a friend', () => {
    const solo = setPreviewCamperCount(createPreviewAppState(now), 1);
    const joined = addPreviewFriend(solo, ' scout ');
    expect(joined.friends.map(friend => friend.friendCode)).toEqual(['SCOUT']);
    expect(addPreviewFriend(joined, 'SCOUT')).toBe(joined);
    for (const code of ['RANDOM123', 'ARTPREVIEW', 'WREN', '', 'SCOUT!']) {
      expect(() => addPreviewFriend(solo, code)).toThrow('only accepts SCOUT');
      expect(() => joinPreviewCircle(solo, code)).toThrow('only accepts SCOUT');
    }
  });

  it('joining the sample roster preserves the mock profile, asks, and saved wallet', () => {
    const shop = purchasePreviewItem({ ...initialPreviewShop(now), balance: 200 }, 'background:snow');
    const state = setPreviewCamperCount(sendPreviewRequest(updatePreviewProfile(exhaustedPreviewState(), 'Robin'), 15, '', now), 1);
    const joined = joinPreviewCircle(state, 'SCOUT');
    expect(joined.friends).toHaveLength(3);
    expect(joined.profile).toBe(state.profile);
    expect(joined.outgoingRequest).toBe(state.outgoingRequest);
    expect(previewAppSnapshot(joined, shop, now).circleShop).toEqual(previewAppSnapshot(state, shop, now).circleShop);
  });

  it('generates a random code once for each new local account, not during ordinary activity', () => {
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementationOnce(array => { (array as Uint8Array).set([0, 1, 254, 255]); return array; })
      .mockImplementationOnce(array => { (array as Uint8Array).set([16, 32, 48, 64]); return array; });
    try {
      const first = createPreviewAppState(now);
      const second = createPreviewAppState(now);
      expect(first.profile.friendCode).toBe('0001FEFF');
      expect(second.profile.friendCode).toBe('10203040');
      const renamed = updatePreviewProfile(first, 'Robin');
      for (const next of [renamed, setPreviewCamperCount(renamed, 6), resetPreviewAppState(renamed, later(1)),
        leavePreviewCircle(renamed), refillPreviewRequests(renamed, later(1))]) {
        expect(next.profile).toBe(renamed.profile);
      }
      previewAppSnapshot(first, undefined, now);
      previewAppSnapshot(first, undefined, later(1));
      expect(random).toHaveBeenCalledTimes(2);
    } finally { random.mockRestore(); }
  });

  it('exposes no friend-code editing action in either app provider', () => {
    expect(previewState).not.toHaveProperty('updatePreviewFriendCode');
    for (const file of ['./local-art-preview.tsx', './app-store.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source).not.toMatch(/updateFriendCode|updateRemoteFriendCode|updatePreviewFriendCode|editPreviewFriendCode/);
    }
  });

  it('can edit a session-only policy with the same content bounds', () => {
    const state = createPreviewAppState(now);
    expect(updatePreviewGroupPolicy(state, ' Demo ', ' Finish homework first. ').groupPolicy).toEqual({ title: 'Demo', body: 'Finish homework first.' });
    expect(() => updatePreviewGroupPolicy(state, '', 'Example')).toThrow('1–60');
    expect(() => updatePreviewGroupPolicy(state, 'Example', 'x'.repeat(281))).toThrow('1–280');
  });

  it('reset recreates only sample activity and preserves purchased art in the snapshot', () => {
    const shop = setPreviewBackground(purchasePreviewItem({ ...initialPreviewShop(now), balance: 200 }, 'background:snow'), 'snow');
    const snapshot = previewAppSnapshot(createPreviewAppState(later(5)), shop, later(5));
    expect(snapshot.profile.displayName).toBe('Camper');
    expect(snapshot.outgoingRequest).toBeNull();
    expect(snapshot.incomingRequests).toHaveLength(2);
    expect(snapshot.campfire.seats).toHaveLength(4);
    expect(snapshot.campfire.seats.every(seat => !seat.askedToday)).toBe(true);
    expect(snapshot.circleShop).toEqual(shop);
    expect(snapshot.circleShop?.background).toBe('snow');
  });

  it('keeps the explicit development guard and all new actions free of remote/native/storage operations', () => {
    const provider = readFileSync(new URL('./local-art-preview.tsx', import.meta.url), 'utf8');
    const model = readFileSync(new URL('./preview-app-state.ts', import.meta.url), 'utf8');
    expect(provider).toContain("isLocalArtPreview = __DEV__ && process.env.EXPO_PUBLIC_LOCAL_ART_PREVIEW === '1'");
    expect(provider).toContain('if (!isLocalArtPreview)');
    expect(provider).toContain('session: null');
    expect(provider).toContain('continueWithoutEmail: updateProfile');
    expect(provider).toContain('No account is signed in in this browser.');
    expect(provider).toContain('const current = expirePreviewRequests(demoRef.current)');
    expect(provider).toContain('commitDemo(updatePreviewScreenTime(expirePreviewRequests(demoRef.current), action))');
    expect(provider).toContain('screenTime: demo.screenTime, updateScreenTime');
    expect(provider).toContain('new Date(), outgoingRequestId');
    expect(provider).toContain('setTimeout(() => commitDemo(expirePreviewRequests(demoRef.current))');
    expect(model).not.toMatch(/AsyncStorage|supabase|fetch\(|\/native\/|localStorage|sessionStorage/);
    expect(provider).not.toMatch(/requireSupabase|\/services\/|\/native\/|fetch\(|\.auth\.|AsyncStorage\.(?:clear|removeItem|multiRemove)/);
    expect(provider.match(/AsyncStorage\.setItem\(/g)).toHaveLength(4);
    expect(provider.match(/AsyncStorage\.setItem\(PREVIEW_MEMBERSHIP_KEY/g)).toHaveLength(4);
    expect(provider).not.toContain('AsyncStorage.setItem(PREVIEW_SHOP_KEY');
  });

  it('leaves without changing the profile or simulated device allowance and cancels circle activity', () => {
    const pending = sendPreviewRequest(exhaustedPreviewState(), 15, '', now);
    const solo = leavePreviewCircle(pending);
    expect(solo).toMatchObject({ circle: 'solo', friends: [], incomingRequests: [], outgoingRequest: null, recentDecision: null });
    expect(solo.profile).toBe(pending.profile);
    expect(solo.screenTime).toBe(pending.screenTime);
    expect(solo.requestSequence).toBe(pending.requestSequence);
    expect(leavePreviewCircle(solo)).toBe(solo);
    expect(() => respondToPreviewOutgoing(solo, 'approved', now, pending.outgoingRequest!.id)).toThrow('Send a request first');
  });

  it.each([0, 1, 2])('blocking camper %s leaves and survives every roster/activity helper', index => {
    const initial = exhaustedPreviewState();
    const friend = initial.friends[index];
    const blocked = blockPreviewPerson(initial, friend.id, now);
    expect(blocked.blockedPeople).toEqual([{ id: friend.id, displayName: friend.displayName, blockedAt: now.toISOString() }]);
    expect(blocked.profile).toBe(initial.profile);
    expect(blocked.screenTime).toBe(initial.screenTime);
    expect(blockPreviewPerson(blocked, friend.id, later(2))).toBe(blocked);
    for (const state of [blocked, setPreviewCamperCount(blocked, 6), resetPreviewAppState(blocked, now), refillPreviewRequests(blocked, now)]) {
      expect(state.circle).toBe('solo'); expect(state.friends).toEqual([]); expect(state.incomingRequests).toEqual([]);
      expect(state.blockedPeople).toEqual(blocked.blockedPeople);
      expect(() => joinPreviewCircle(state, 'SCOUT')).toThrow('Unblock');
      expect(() => addPreviewFriend(state, 'SCOUT')).toThrow('Unblock');
      expect(() => sendPreviewRequest(state, 15, '', now)).toThrow('SCOUT');
    }
  });

  it('unblocking does not rejoin; explicit join restores only the known sample circle', () => {
    const initial = createPreviewAppState(now);
    const id = initial.friends[0].id;
    const unblocked = unblockPreviewPerson(blockPreviewPerson(initial, id, now), id);
    expect(unblocked).toMatchObject({ circle: 'solo', friends: [], blockedPeople: [], incomingRequests: [] });
    expect(setPreviewCamperCount(unblocked, 6).friends).toEqual([]);
    expect(resetPreviewAppState(unblocked, now).friends).toEqual([]);
    expect(refillPreviewRequests(unblocked, now).incomingRequests).toEqual([]);
    expect(joinPreviewCircle(unblocked, ' scout ')).toMatchObject({ circle: 'shared', friends: initial.friends });
    expect(addPreviewFriend(unblocked, 'SCOUT').circle).toBe('shared');
  });

  it('rejects self/arbitrary blocking and preserves immutable input on errors', () => {
    const initial = createPreviewAppState(now);
    for (const id of [initial.profile.id, 'remote-user', '']) expect(() => blockPreviewPerson(initial, id, now)).toThrow('Choose a camper');
    expect(initial.blockedPeople).toEqual([]); expect(initial.circle).toBe('shared');
  });
});
