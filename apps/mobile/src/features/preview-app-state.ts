import { type CharacterAppearance, defaultAppearance } from '@/domain/character';
import type { CircleShop } from '@/domain/circle-shop';
import type { BlockedPerson } from '@/domain/circle-membership';
import { createDemoLimitState, demoAskBlockReason, demoLimitReducer, type DemoAction, type DemoState } from '@/domain/demo-screen-time';
import { isValidDisplayName, MAX_DISPLAY_NAME_LENGTH, normalizeDisplayName } from '@/domain/profile';
import { allowedGrantMinutes, type AppSnapshot, type Decision, type Friend, type GrantMinutes } from '@/types/domain';

export const DEMO_FRIEND_CODE = 'SCOUT';
export const PREVIEW_PROFILE_ID = 'local-art-preview';
export const INITIAL_PREVIEW_COUNT = 4;
const REQUEST_LIFETIME_MS = 20 * 60_000;
const previewNames = ['Scout', 'Wren', 'Milo', 'Sage', 'Juniper'];

export const sampleLooks: readonly CharacterAppearance[] = [
  { ...defaultAppearance },
  { hat: 'cowboy', body: 'short' },
  { hat: 'cow', body: 'tall' },
  { hat: 'cat', body: 'short' },
  { hat: 'halo', body: 'short' },
  { hat: 'crown', body: 'tall' },
];

export type PreviewAppState = Pick<AppSnapshot,
  'profile' | 'friends' | 'incomingRequests' | 'outgoingRequest' | 'recentDecision' | 'groupPolicy'> & {
  burnt: boolean;
  askedToday: boolean;
  requestSequence: number;
  sentAt: number[];
  screenTime: DemoState;
  circle: 'shared' | 'solo';
  blockedPeople: BlockedPerson[];
};

export function sampleFriends(): Friend[] {
  return previewNames.map((displayName, index) => ({
    id: `local-art-preview-camper-${index + 1}`, displayName, initials: displayName[0],
    friendCode: displayName.toUpperCase(), color: '#FFD2BF', online: true,
    character: { appearance: { ...sampleLooks[index + 1] }, revision: 0 },
  }));
}

/** Session-only fixtures: never load accounts, award currency, or grant device time. */
export function createPreviewAppState(now = new Date()): PreviewAppState {
  // This local-only identity is generated at provider initialization, then saved
  // with membership before the profile is shown. It is not a login credential.
  const friendCode = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)),
    byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
  return freshPreviewAppState(now, 0, { id: PREVIEW_PROFILE_ID, displayName: 'Camper', friendCode, initials: 'C' });
}

/** Keep request identities unique for the lifetime of a mounted demo provider. */
export function resetPreviewAppState(state: PreviewAppState, now = new Date()): PreviewAppState {
  const fresh = freshPreviewAppState(now, state.requestSequence, state.profile);
  return refillPreviewRequests({ ...fresh, requestSequence: state.requestSequence, circle: state.circle,
    blockedPeople: state.blockedPeople, friends: state.circle === 'solo' ? [] : fresh.friends.filter(friend =>
      !state.blockedPeople.some(person => person.id === friend.id)) }, now);
}

function freshPreviewAppState(now: Date, requestSequence: number, profile: PreviewAppState['profile']): PreviewAppState {
  return refillPreviewRequests({
    profile,
    friends: sampleFriends().slice(0, INITIAL_PREVIEW_COUNT - 1), incomingRequests: [],
    outgoingRequest: null, recentDecision: null,
    groupPolicy: { title: 'Be kind, not automatic.', body: 'Ask yourself: does this feel intentional, or is it just the habit talking?' },
    burnt: false, askedToday: false, requestSequence, sentAt: [], screenTime: createDemoLimitState(), circle: 'shared', blockedPeople: [],
  }, now);
}

export function refillPreviewRequests(state: PreviewAppState, now = new Date()): PreviewAppState {
  const requestSequence = state.requestSequence + 1;
  const friends = state.circle === 'solo' ? [] : state.friends.filter(friend => !state.blockedPeople.some(person => person.id === friend.id));
  return { ...state, friends, requestSequence, incomingRequests: friends.slice(0, 2).map((friend, index) => ({
    id: `local-demo-incoming-${requestSequence}-${friend.id}`, friend, minutes: index === 0 ? 15 : 10,
    categoryLabel: 'Social apps', reason: index === 0 ? 'Finishing a conversation.' : 'A few more minutes to catch up.',
    status: 'pending', createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + REQUEST_LIFETIME_MS).toISOString(),
  })) };
}

export function expirePreviewRequests(state: PreviewAppState, now = new Date()): PreviewAppState {
  const incomingRequests = state.incomingRequests.filter(request => Date.parse(request.expiresAt) > now.getTime());
  const outgoingRequest = state.outgoingRequest && Date.parse(state.outgoingRequest.expiresAt) <= now.getTime() ? null : state.outgoingRequest;
  if (incomingRequests.length === state.incomingRequests.length && outgoingRequest === state.outgoingRequest) return state;
  return { ...state, incomingRequests, outgoingRequest };
}

export function setPreviewCamperCount(state: PreviewAppState, count: number): PreviewAppState {
  if (!Number.isFinite(count) || state.circle === 'solo') return state;
  const friends = sampleFriends().filter(friend => !state.blockedPeople.some(person => person.id === friend.id))
    .slice(0, Math.max(1, Math.min(6, Math.round(count))) - 1);
  return { ...state, friends, incomingRequests: state.incomingRequests.filter(request => friends.some(friend => friend.id === request.friend.id)) };
}

export function updatePreviewProfile(state: PreviewAppState, displayName: string): PreviewAppState {
  if (!isValidDisplayName(displayName)) throw new Error(`Enter a name with 1 to ${MAX_DISPLAY_NAME_LENGTH} characters.`);
  const name = normalizeDisplayName(displayName);
  const initials = name.split(/\s+/).slice(0, 2).map(part => [...part][0]).join('').toUpperCase();
  return { ...state, profile: { ...state.profile, displayName: name, initials } };
}

function requireDemoCode(code: string) {
  if (code.trim().toUpperCase() !== DEMO_FRIEND_CODE) {
    throw new Error(`This browser only accepts ${DEMO_FRIEND_CODE}. Use the installed app for other friend codes.`);
  }
}

export function addPreviewFriend(state: PreviewAppState, code: string): PreviewAppState {
  requireDemoCode(code);
  if (state.circle === 'solo') return joinPreviewCircle(state, code);
  const scout = sampleFriends()[0];
  if (state.blockedPeople.some(person => person.id === scout.id)) throw new Error('Unblock this camper before joining their circle.');
  return state.friends.some(friend => friend.id === scout.id) ? state : { ...state, friends: [...state.friends, scout] };
}

export function joinPreviewCircle(state: PreviewAppState, code: string): PreviewAppState {
  requireDemoCode(code);
  // All sample campers belong to one known circle. Do not rejoin a blocked peer
  // indirectly through a different friend's code or a test roster control.
  if (state.blockedPeople.length) throw new Error('Unblock the campers before rejoining this circle.');
  return setPreviewCamperCount({ ...state, circle: 'shared' }, INITIAL_PREVIEW_COUNT);
}

export function leavePreviewCircle(state: PreviewAppState): PreviewAppState {
  if (state.circle === 'solo') return state;
  return { ...state, circle: 'solo', friends: [], incomingRequests: [], outgoingRequest: null, recentDecision: null };
}

export function blockPreviewPerson(state: PreviewAppState, id: string, now = new Date()): PreviewAppState {
  if (state.blockedPeople.some(person => person.id === id)) return state;
  const friend = state.friends.find(person => person.id === id);
  if (!friend) throw new Error('Choose a camper in your circle.');
  return { ...leavePreviewCircle(state), blockedPeople: [...state.blockedPeople,
    { id: friend.id, displayName: friend.displayName, blockedAt: now.toISOString() }] };
}

export function unblockPreviewPerson(state: PreviewAppState, id: string): PreviewAppState {
  return { ...state, blockedPeople: state.blockedPeople.filter(person => person.id !== id) };
}

export function updatePreviewGroupPolicy(state: PreviewAppState, title: string, body: string): PreviewAppState {
  const groupPolicy = { title: title.trim(), body: body.trim() };
  if ([...groupPolicy.title].length < 1 || [...groupPolicy.title].length > 60 || [...groupPolicy.body].length < 1 || [...groupPolicy.body].length > 280) {
    throw new Error('Use a title of 1–60 characters and a reminder of 1–280 characters.');
  }
  return { ...state, groupPolicy };
}

export function sendPreviewRequest(state: PreviewAppState, minutes: GrantMinutes, reason = '', now = new Date()): PreviewAppState {
  const current = expirePreviewRequests(state, now);
  if (!allowedGrantMinutes.includes(minutes)) throw new Error('Choose 5, 10, 15 or 30 minutes.');
  if (!current.friends.length) throw new Error('Join a circle with code SCOUT before asking.');
  if (current.outgoingRequest) throw new Error('Cancel your pending request before asking again.');
  if ([...reason.trim()].length > 240) throw new Error('Keep your reason within 240 characters.');
  const blockReason = demoAskBlockReason(current.screenTime);
  if (blockReason) throw new Error(blockReason);
  const sentAt = current.sentAt.filter(timestamp => timestamp > now.getTime() - 60 * 60_000);
  if (sentAt.length >= 5) throw new Error('You can send five requests per hour. Wait before asking again.');
  const requestSequence = current.requestSequence + 1;
  return { ...current, askedToday: true, requestSequence, sentAt: [...sentAt, now.getTime()], recentDecision: null,
    outgoingRequest: { id: `local-demo-outgoing-${requestSequence}`, minutes, categoryLabel: 'Social apps', status: 'pending',
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + REQUEST_LIFETIME_MS).toISOString() } };
}

export function cancelPreviewRequest(state: PreviewAppState): PreviewAppState {
  // Cancelling is not a clean day, and never refunds or charges demo currency.
  return { ...state, outgoingRequest: null };
}

export function decidePreviewRequest(state: PreviewAppState, id: string, decision: Decision, now = new Date()): PreviewAppState {
  const current = expirePreviewRequests(state, now);
  if (decision !== 'approved' && decision !== 'denied') throw new Error('Choose Approve or Deny.');
  if (!current.incomingRequests.some(request => request.id === id)) throw new Error('That request is no longer available. Reload requests to try again.');
  // Another camper's decision is not this user's grant or recentDecision.
  return { ...current, incomingRequests: current.incomingRequests.filter(request => request.id !== id) };
}

export function updatePreviewScreenTime(state: PreviewAppState, action: DemoAction): PreviewAppState {
  // Credit comes only from resolving this user's pending request below.
  if (action.type === 'grant') return state;
  const screenTime = demoLimitReducer(state.screenTime, action);
  if (screenTime === state.screenTime) return state;
  const changedPolicy = ['toggle', 'minutes', 'perApp', 'enable', 'stop', 'reset'].includes(action.type);
  return { ...state, screenTime, outgoingRequest: changedPolicy ? null : state.outgoingRequest,
    recentDecision: changedPolicy ? null : state.recentDecision };
}

export function respondToPreviewOutgoing(state: PreviewAppState, decision: Decision, now = new Date(),
  expectedRequestId: string | null = state.outgoingRequest?.id ?? null): PreviewAppState {
  const current = expirePreviewRequests(state, now);
  if (decision !== 'approved' && decision !== 'denied') throw new Error('Choose Approve or Deny.');
  if (!current.outgoingRequest) throw new Error('Send a request first.');
  if (current.outgoingRequest.id !== expectedRequestId || current.outgoingRequest.status !== 'pending') throw new Error('That request is no longer pending.');
  const { id, minutes } = current.outgoingRequest;
  if (decision === 'approved') {
    const blockReason = demoAskBlockReason(current.screenTime);
    if (blockReason) throw new Error(blockReason);
  }
  return { ...current, outgoingRequest: null,
    screenTime: decision === 'approved' ? demoLimitReducer(current.screenTime, { type: 'grant', minutes }) : current.screenTime,
    recentDecision: { id, minutes, status: decision, decidedAt: now.toISOString() } };
}

export function previewAppSnapshot(state: PreviewAppState, shop: CircleShop | undefined, now = new Date()): AppSnapshot {
  const { profile, friends, incomingRequests, outgoingRequest, recentDecision, groupPolicy } = state;
  const askedToday = state.burnt || state.askedToday;
  return { profile, friends, incomingRequests, outgoingRequest, recentDecision, groupPolicy,
    campfire: { localDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      groupGolden: shop?.balance ?? 0,
      seats: [profile, ...friends].map(person => ({ id: person.id, displayName: person.displayName, initials: person.initials,
        isYou: person.id === profile.id, askedToday: person.id === profile.id ? askedToday : state.burnt,
        streak: 0, golden: 0, character: person.character })),
    },
    circleShop: shop ? { ...shop, askedToday, eligibleToday: !askedToday && shop.eligibleToday } : undefined,
  };
}
