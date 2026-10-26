import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DemoAction } from '@/domain/demo-screen-time';
import { blockPreviewPerson, createPreviewAppState, joinPreviewCircle, leavePreviewCircle,
  previewAppSnapshot, resetPreviewAppState, unblockPreviewPerson, updatePreviewScreenTime } from './preview-app-state';
import { initialPreviewShop, pressPreviewPanicButton, purchasePreviewItem, setPreviewBackground } from './preview-circle-shop';
import { currentPreviewShop, PREVIEW_MEMBERSHIP_KEY, restorePreviewMembership, restorePreviewRoster,
  updatePreviewMembershipRecord } from './preview-circle-membership';

const now = new Date('2026-09-29T12:00:00Z');
const later = new Date('2026-10-01T12:00:00Z');
const shared = () => setPreviewBackground(purchasePreviewItem(purchasePreviewItem({ ...initialPreviewShop(now), balance: 200 }, 'background:beach'), 'hat:wizard'), 'beach');
const initial = () => restorePreviewMembership(null, createPreviewAppState(now), shared(), now);

describe('atomic local demo circle membership and wallets', () => {
  it('starts a new local circle at zero without funding its shared or solo wallet', () => {
    const saved = restorePreviewMembership(null, createPreviewAppState(now), initialPreviewShop(now), now);
    expect(saved.sharedShop.balance).toBe(0);
    expect(saved.soloShop.balance).toBe(0);
    expect(currentPreviewShop(saved).balance).toBe(0);
  });

  it.each(['shared', 'solo'] as const)('keeps a %s panic burn on same-day reload and clears it at the next local day', circle => {
    let state = createPreviewAppState(now);
    let saved = restorePreviewMembership(null, state, initialPreviewShop(now), now);
    if (circle === 'solo') {
      state = leavePreviewCircle(state);
      saved = updatePreviewMembershipRecord(saved, state, undefined, now);
    }
    for (const action of [{ type: 'toggle', app: 'Games' }, { type: 'minutes', minutes: 5 },
      { type: 'enable' }, { type: 'simulate' }] satisfies DemoAction[]) state = updatePreviewScreenTime(state, action);
    const panic = pressPreviewPanicButton(state, currentPreviewShop(saved));
    saved = updatePreviewMembershipRecord(saved, panic.state, panic.shop, now);
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    for (const [reloadAt, burnt] of [[new Date(now.getTime() + 60_000), true], [tomorrow, false]] as const) {
      const freshSession = createPreviewAppState(reloadAt);
      const loaded = restorePreviewMembership(JSON.stringify(saved), freshSession, initialPreviewShop(reloadAt), reloadAt);
      const restored = restorePreviewRoster(freshSession, loaded);
      const shop = currentPreviewShop(loaded);
      const snapshot = previewAppSnapshot(restored, shop, reloadAt);
      expect(restored).toMatchObject({ circle, burnt, askedToday: burnt });
      expect(shop).toMatchObject({ balance: 0, askedToday: burnt, localDate: initialPreviewShop(reloadAt).localDate });
      expect(snapshot.campfire.seats.every(seat => seat.askedToday === burnt)).toBe(true);
      expect(snapshot.circleShop).toMatchObject({ balance: 0, askedToday: burnt,
        eligibleToday: !burnt && circle === 'shared' });
      expect(restored.screenTime).toBe(freshSession.screenTime);
      expect(restored.profile.friendCode).toBe(saved.ownFriendCode);
    }
  });

  it('persists the new random account code across reload without changing its wallet or roster', () => {
    const state = createPreviewAppState(now);
    const saved = restorePreviewMembership(null, state, shared(), now);
    expect(saved.ownFriendCode).toBe(state.profile.friendCode);
    expect(saved.ownFriendCode).toMatch(/^[A-F0-9]{8}$/);
    const freshSession = createPreviewAppState(later);
    const loaded = restorePreviewMembership(JSON.stringify(saved), freshSession, initialPreviewShop(later), later);
    const restored = restorePreviewRoster(freshSession, loaded);
    expect(restored.profile.friendCode).toBe(saved.ownFriendCode);
    expect(restored.profile.id).toBe(state.profile.id);
    expect(restored.friends.map(friend => friend.id)).toEqual(saved.friendIds);
    expect(restored.screenTime).toBe(freshSession.screenTime);
    expect(loaded.sharedShop.balance).toBe(saved.sharedShop.balance);
    expect(loaded.sharedShop.unlocked).toEqual(saved.sharedShop.unlocked);
  });

  it('keeps the legacy saved account code when upgrading either membership or an older wallet', () => {
    const saved = initial();
    const { ownFriendCode: _oldCode, ...legacy } = saved;
    const state = createPreviewAppState(later);
    for (const loaded of [
      restorePreviewMembership(JSON.stringify(legacy), state, initialPreviewShop(later), later),
      restorePreviewMembership(null, state, shared(), now, true),
    ]) {
      expect(loaded.ownFriendCode).toBe('CAMPFIRE');
      expect(restorePreviewRoster(state, loaded).profile.friendCode).toBe('CAMPFIRE');
      expect(loaded.sharedShop.balance).toBe(saved.sharedShop.balance);
      expect(loaded.sharedShop.unlocked).toEqual(saved.sharedShop.unlocked);
    }
  });

  it('never reassigns an existing durable code during name, circle or wallet changes', () => {
    const saved = { ...initial(), ownFriendCode: 'OLD12345' };
    const freshSession = createPreviewAppState(later);
    const loaded = restorePreviewMembership(JSON.stringify(saved), freshSession, initialPreviewShop(later), later);
    const restored = restorePreviewRoster(freshSession, loaded);
    const solo = leavePreviewCircle(restored);
    const blocked = blockPreviewPerson(restored, restored.friends[0].id, now);
    const purchased = purchasePreviewItem(loaded.sharedShop, 'color:red');
    for (const next of [restored, solo, blocked, resetPreviewAppState(restored, later)]) {
      expect(updatePreviewMembershipRecord(loaded, next, purchased, later).ownFriendCode).toBe('OLD12345');
    }
    expect(restored.profile.friendCode).toBe('OLD12345');
  });

  it('migrates the existing shared wallet without granting, refunding or losing purchases', () => {
    const saved = initial();
    expect(saved.sharedShop).toEqual(shared());
    expect(currentPreviewShop(saved)).toBe(saved.sharedShop);
    expect(saved.soloShop).toMatchObject({ balance: 0, background: 'forest', unlocked: [] });
    const restored = restorePreviewMembership(JSON.stringify(saved), createPreviewAppState(later), initialPreviewShop(later), later);
    expect(restored.sharedShop.balance).toBe(shared().balance);
    expect(restored.sharedShop.unlocked).toEqual(shared().unlocked);
    expect(restored.sharedShop.background).toBe('beach');
    expect(restored.sharedShop.initializedAt).toBe(saved.sharedShop.initializedAt);
  });

  it.each(['Your demo circle', 'My quiet campsite'])(
    'normalizes only the old solo circle label without replacing the saved membership (%s)', name => {
      const original = initial();
      const left = updatePreviewMembershipRecord(original, leavePreviewCircle(createPreviewAppState(now)), undefined, now);
      const saved = { ...left, sharedShop: { ...left.sharedShop, name: 'Preview circle' },
        soloShop: { ...left.soloShop, name } };
      const loaded = restorePreviewMembership(JSON.stringify(saved), createPreviewAppState(now), initialPreviewShop(now), now);
      expect(loaded).toEqual({ ...saved, sharedShop: { ...saved.sharedShop, name: 'Your circle' },
        soloShop: { ...saved.soloShop, name: name === 'Your demo circle' ? 'Your circle' : name } });
    });

  it('leaving creates an empty independent wallet, and repeated leave/reset cannot refill it', () => {
    const original = initial();
    const state = leavePreviewCircle(createPreviewAppState(now));
    const left = updatePreviewMembershipRecord(original, state, undefined, now);
    expect(currentPreviewShop(left)).toMatchObject({ balance: 0, background: 'forest', unlocked: [] });
    expect(left.sharedShop).toBe(original.sharedShop);
    expect(currentPreviewShop(left).id).not.toBe(original.sharedShop.id);
    const reset = updatePreviewMembershipRecord(left, resetPreviewAppState(state, later), undefined, later);
    expect(reset.sharedShop).toBe(original.sharedShop);
    expect(currentPreviewShop(reset)).toBe(left.soloShop);
    expect(() => purchasePreviewItem(currentPreviewShop(left), 'hat:wizard')).toThrow('more s’mores');
  });

  it('explicit rejoin restores the original shared wallet with no duplicate test grant', () => {
    const original = initial();
    const solo = leavePreviewCircle(createPreviewAppState(now));
    const left = updatePreviewMembershipRecord(original, solo);
    const joined = updatePreviewMembershipRecord(left, joinPreviewCircle(solo, 'SCOUT'));
    expect(currentPreviewShop(joined)).toBe(original.sharedShop);
    expect(joined.sharedShop.balance).toBe(shared().balance);
    expect(joined.sharedShop.unlocked).toEqual(['background:beach', 'hat:wizard']);
  });

  it('persists blocked membership over reload instead of restoring the default friend roster', () => {
    const state = createPreviewAppState(now);
    const blocked = blockPreviewPerson(state, state.friends[1].id, now);
    const saved = updatePreviewMembershipRecord(initial(), blocked, undefined, now);
    const loaded = restorePreviewMembership(JSON.stringify(saved), createPreviewAppState(later), initialPreviewShop(later), later);
    const restored = restorePreviewRoster(createPreviewAppState(later), loaded);
    expect(restored).toMatchObject({ circle: 'solo', friends: [], incomingRequests: [], blockedPeople: blocked.blockedPeople });
    expect(currentPreviewShop(loaded)).toMatchObject({ balance: 0, unlocked: [], background: 'forest' });
    expect(() => joinPreviewCircle(restored, 'SCOUT')).toThrow('Unblock');
    const unblocked = unblockPreviewPerson(restored, state.friends[1].id);
    const unblockedRecord = updatePreviewMembershipRecord(loaded, unblocked);
    expect(unblockedRecord.circle).toBe('solo'); expect(unblockedRecord.friendIds).toEqual([]);
    expect(unblockedRecord.sharedShop.balance).toBe(shared().balance);
    const joined = updatePreviewMembershipRecord(unblockedRecord, joinPreviewCircle(unblocked, 'SCOUT'));
    expect(joined.sharedShop.balance).toBe(shared().balance);
  });

  it('purchases update only the active shared wallet within the same durable record', () => {
    const saved = initial();
    const purchased = purchasePreviewItem(saved.sharedShop, 'color:red');
    const next = updatePreviewMembershipRecord(saved, createPreviewAppState(now), purchased);
    expect(next.sharedShop.balance).toBe(saved.sharedShop.balance - 5);
    expect(next.soloShop).toBe(saved.soloShop);
    expect(next.blockedPeople).toEqual(saved.blockedPeople);
    expect(saved.sharedShop.unlocked).not.toContain('color:red');
  });

  it.each(['{', 'null', '{}', JSON.stringify({ ...initial(), version: 2 }),
    JSON.stringify({ ...initial(), ownFriendCode: '' }),
    JSON.stringify({ ...initial(), ownFriendCode: null }),
    JSON.stringify({ ...initial(), ownFriendCode: 'with spaces' }),
    JSON.stringify({ ...initial(), friendIds: ['real-user'] }),
    JSON.stringify({ ...initial(), circle: 'solo' }),
    JSON.stringify({ ...initial(), sharedShop: { ...shared(), balance: -1 } }),
    JSON.stringify({ ...initial(), soloShop: { ...initial().soloShop, balance: 200 } }),
    JSON.stringify({ ...initial(), blockedPeople: [{ id: 'real-user', displayName: 'Other', blockedAt: now.toISOString() }] }),
  ])('fails closed on invalid durable membership without a fresh wallet grant (%s)', raw => {
    expect(() => restorePreviewMembership(raw, createPreviewAppState(now), initialPreviewShop(now), now)).toThrow();
  });

  it('uses one pending lock for purchases and membership, and only publishes after durable storage succeeds', () => {
    const provider = readFileSync(new URL('./local-art-preview.tsx', import.meta.url), 'utf8');
    expect(PREVIEW_MEMBERSHIP_KEY).toMatch(/^sumore:local-art-preview:/);
    const shop = provider.slice(provider.indexOf('const mutateShop'), provider.indexOf('const mutateMembership'));
    const membership = provider.slice(provider.indexOf('const mutateMembership'), provider.indexOf('const purchaseItem'));
    for (const section of [shop, membership]) {
      expect(section).toContain('if (mutationPending.current) throw');
      expect(section).toContain('mutationPending.current = true');
      expect(section).toContain('await AsyncStorage.setItem(PREVIEW_MEMBERSHIP_KEY');
      expect(section.indexOf('await AsyncStorage.setItem')).toBeLessThan(section.indexOf('membershipRef.current = saved'));
      expect(section.indexOf('await AsyncStorage.setItem')).toBeLessThan(section.indexOf('shopRef.current ='));
      expect(section).toContain('throw caught');
      expect(section).toContain('mutationPending.current = false');
    }
    expect(membership.indexOf('await AsyncStorage.setItem')).toBeLessThan(membership.indexOf('commitDemo('));
    expect(provider).toContain('getBlockedPeople = useCallback(async (): Promise<BlockedPerson[]>');
    expect(provider).toContain('blockedPeople.map(person => ({ ...person }))');
    expect(provider).not.toMatch(/\.rpc\(|\.auth\.|fetch\(|\/services\//);
    const restore = provider.slice(provider.indexOf('const membership = await AsyncStorage'), provider.indexOf('const mutateShop'));
    expect(restore).toContain('current !== null || legacy !== null');
    expect(restore.indexOf('await AsyncStorage.setItem')).toBeLessThan(restore.indexOf('commitDemo(restorePreviewRoster'));
    expect(restore.indexOf('await AsyncStorage.setItem')).toBeLessThan(restore.indexOf('setCircleShop('));
  });
});
