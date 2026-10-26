import { parseCircleShop, type CircleShop } from '@/domain/circle-shop';
import type { BlockedPerson } from '@/domain/circle-membership';
import { initialPreviewShop, restoredCircleName, restorePreviewShop } from './preview-circle-shop';
import { sampleFriends, type PreviewAppState } from './preview-app-state';

export const PREVIEW_MEMBERSHIP_KEY = 'sumore:local-art-preview:membership:v1';
const SOLO_ID = 'local-art-preview-solo-circle';

/** One atomic storage value: membership can never commit separately from its wallet. */
export type PreviewMembershipRecord = {
  version: 1;
  readonly ownFriendCode: string;
  circle: 'shared' | 'solo';
  blockedPeople: BlockedPerson[];
  friendIds: string[];
  sharedShop: CircleShop;
  soloShop: CircleShop;
};

export function emptyPreviewSoloShop(now = new Date()): CircleShop {
  return { ...initialPreviewShop(now), id: SOLO_ID, name: 'Your circle', balance: 0,
    unlocked: [], background: 'forest', eligibleToday: false };
}

export function currentPreviewShop(record: PreviewMembershipRecord): CircleShop {
  return record.circle === 'shared' ? record.sharedShop : record.soloShop;
}

export function restorePreviewMembership(raw: string | null, state: PreviewAppState, sharedShop: CircleShop,
  now = new Date(), legacyAccount = false): PreviewMembershipRecord {
  if (raw === null) return { version: 1, ownFriendCode: legacyAccount ? 'CAMPFIRE' : state.profile.friendCode, circle: 'shared', blockedPeople: [],
    friendIds: state.friends.map(friend => friend.id), sharedShop, soloShop: emptyPreviewSoloShop(now) };
  const saved = JSON.parse(raw) as Partial<PreviewMembershipRecord> | null;
  const fail = () => { throw new Error('The circle could not be loaded. Reload to retry.'); };
  if (!saved || saved.version !== 1 || !['shared', 'solo'].includes(saved.circle ?? '')
    || !Array.isArray(saved.blockedPeople) || !Array.isArray(saved.friendIds)) return fail();
  // Existing local accounts predate this field and always displayed CAMPFIRE.
  // Preserve their identity rather than replacing their code during an upgrade.
  const ownFriendCode = saved.ownFriendCode === undefined ? 'CAMPFIRE' : saved.ownFriendCode;
  if (typeof ownFriendCode !== 'string' || !/^[A-Z0-9]{4,16}$/.test(ownFriendCode)) return fail();
  const known = new Map(sampleFriends().map(friend => [friend.id, friend]));
  if (saved.blockedPeople.some(person => !person || typeof person.id !== 'string' || !known.has(person.id)
    || person.displayName !== known.get(person.id)?.displayName || typeof person.blockedAt !== 'string'
    || !Number.isFinite(Date.parse(person.blockedAt)))
    || new Set(saved.blockedPeople.map(person => person.id)).size !== saved.blockedPeople.length
    || saved.friendIds.some(id => !known.has(id)) || new Set(saved.friendIds).size !== saved.friendIds.length
    || (saved.circle === 'solo' && saved.friendIds.length > 0)
    || (saved.circle === 'shared' && saved.blockedPeople.length > 0)) return fail();
  const shared = parseCircleShop(saved.sharedShop);
  const solo = parseCircleShop(saved.soloShop);
  if (!shared || shared.id !== sharedShop.id || !solo || solo.id !== SOLO_ID
    || solo.balance !== 0 || solo.unlocked.length !== 0 || solo.background !== 'forest') return fail();
  const freshSolo = emptyPreviewSoloShop(now);
  return { version: 1, ownFriendCode, circle: saved.circle as 'shared' | 'solo', blockedPeople: saved.blockedPeople,
    friendIds: saved.friendIds, sharedShop: restorePreviewShop(JSON.stringify(shared), now),
    soloShop: { ...freshSolo, name: restoredCircleName(solo.name), initializedAt: solo.initializedAt,
      askedToday: solo.askedToday && solo.localDate === freshSolo.localDate } };
}

export function restorePreviewRoster(state: PreviewAppState, record: PreviewMembershipRecord): PreviewAppState {
  const friends = record.circle === 'shared' ? sampleFriends().filter(friend => record.friendIds.includes(friend.id)) : [];
  const profile = state.profile.friendCode === record.ownFriendCode ? state.profile : { ...state.profile, friendCode: record.ownFriendCode };
  // Membership restoration already normalizes each wallet to today's date.
  // Keep its circle-wide burn visible when rebuilding the session-only scene.
  const burnt = currentPreviewShop(record).askedToday;
  return { ...state, profile, circle: record.circle, blockedPeople: record.blockedPeople, friends, burnt, askedToday: burnt,
    incomingRequests: state.incomingRequests.filter(request => friends.some(friend => friend.id === request.friend.id)),
    outgoingRequest: null, recentDecision: null };
}

export function updatePreviewMembershipRecord(record: PreviewMembershipRecord, state: PreviewAppState,
  shop = currentPreviewShop(record), now = new Date()): PreviewMembershipRecord {
  const changedCircle = state.circle !== record.circle;
  return { ...record, circle: state.circle, blockedPeople: state.blockedPeople, friendIds: state.friends.map(friend => friend.id),
    sharedShop: record.circle === 'shared' ? shop : record.sharedShop,
    soloShop: changedCircle && state.circle === 'solo' ? emptyPreviewSoloShop(now)
      : record.circle === 'solo' ? shop : record.soloShop };
}
