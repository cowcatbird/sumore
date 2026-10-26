import type { SharedCharacter } from '@/domain/character';
import type { CircleShop } from '@/domain/circle-shop';

export const allowedGrantMinutes = [5, 10, 15, 30] as const;

export type GrantMinutes = (typeof allowedGrantMinutes)[number];
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
export type Decision = 'approved' | 'denied';

export type Profile = {
  id: string;
  displayName: string;
  friendCode: string;
  initials: string;
  character?: SharedCharacter;
};

export type Friend = Profile & {
  color: string;
  online: boolean;
  membershipId?: string;
};

export type TimeRequest = {
  id: string;
  friend: Friend;
  minutes: GrantMinutes;
  categoryLabel: string;
  reason: string;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
};

export type OutgoingRequest = {
  id: string;
  minutes: GrantMinutes;
  categoryLabel: string;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
} | null;

export type RecentDecision = {
  id: string;
  minutes: GrantMinutes;
  status: 'approved' | 'denied';
  decidedAt: string;
} | null;

/** The reminder shown at the bottom of Requests. Owned by the circle, editable in Setup. */
export type GroupPolicy = {
  title: string;
  body: string;
};

/**
 * One person's place at the fire for the current local day.
 *
 * `askedToday` is the whole mechanic: asking for more time takes you off the
 * fire until tomorrow, so no marshmallow is cooked and the streak restarts.
 * `golden` is the legacy API name for earned s’mores. It counts completed
 * clean days only — today is still cooking.
 */
export type CampfireSeat = {
  id: string;
  displayName: string;
  initials: string;
  isYou: boolean;
  askedToday: boolean;
  streak: number;
  golden: number;
  character?: SharedCharacter;
};

export type Campfire = {
  /** The local day the seats were computed for, so the UI can detect rollover. */
  localDate: string;
  seats: CampfireSeat[];
  /** Total s’mores earned by the circle; keep the legacy API field name. */
  groupGolden: number;
};

export type AppSnapshot = {
  profile: Profile;
  friends: Friend[];
  incomingRequests: TimeRequest[];
  outgoingRequest: OutgoingRequest;
  recentDecision: RecentDecision;
  groupPolicy: GroupPolicy;
  campfire: Campfire;
  /** Server-authoritative shared wallet; absent on older backends. */
  circleShop?: CircleShop;
};

export type NotificationReadiness =
  | 'unknown'
  | 'available'
  | 'permission-granted'
  | 'registered'
  | 'denied'
  | 'needs-update'
  | 'needs-development-build';

export type ScreenTimeStatus = {
  /** Explicit native capability; absent in older installed builds. */
  supportsPanicGrants?: boolean;
  requiresReset?: boolean;
  dailyLimitsAvailable?: boolean;
  perAppLimitsAvailable?: boolean;
  customLimitAvailable?: boolean;
  selectionDisplayAvailable?: boolean;
  reportAvailable?: boolean;
  limitMode?: 'shared' | 'perApp';
  allocatedMinutes?: number | null;
  appliedRequestId?: string | null;
  mode?: 'manual' | 'daily';
  dailyLimitMinutes?: number | null;
  dailyLimitReached?: boolean;
  dailyUsageNote?: string | null;
  usageMinutesToday?: number | null;
  usageAccessGranted?: boolean;
  accessibilityEnabled?: boolean;
  /** Android service connection, distinct from the enabled switch in Settings. */
  accessibilityServiceConnected?: boolean;
  consentGranted?: boolean;
  settingsChangeAllowedAt?: string | null;
  available: boolean;
  authorized: boolean;
  shielded: boolean;
  blockingEnabled: boolean;
  selection: { applications: number; categories: number; webDomains: number };
  temporaryAccessExpiresAt: string | null;
  appliedGrantId: string | null;
  authorizationStatus: 'approved' | 'denied' | 'notDetermined' | 'unavailable';
  message: string;
};
