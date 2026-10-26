import { allowedGrantMinutes, type Decision, type GrantMinutes, type RequestStatus } from '@/types/domain';

// Keep this in sync with the expires_at default on public.time_requests.
export const requestLifetimeMs = 20 * 60 * 1000;

export function isGrantMinutes(value: number): value is GrantMinutes {
  return allowedGrantMinutes.includes(value as GrantMinutes);
}

export function createExpiry(createdAt: Date = new Date()) {
  return new Date(createdAt.getTime() + requestLifetimeMs);
}

export function effectiveRequestStatus(
  status: RequestStatus,
  expiresAt: string,
  now: Date = new Date(),
): RequestStatus {
  if (status === 'pending' && new Date(expiresAt).getTime() <= now.getTime()) return 'expired';
  return status;
}

export function canDecideRequest(status: RequestStatus, expiresAt: string, now: Date = new Date()) {
  return effectiveRequestStatus(status, expiresAt, now) === 'pending';
}

export function applyDecision(
  status: RequestStatus,
  expiresAt: string,
  decision: Decision,
  now: Date = new Date(),
): RequestStatus {
  if (!canDecideRequest(status, expiresAt, now)) {
    throw new Error('This request is no longer waiting for a decision.');
  }
  return decision;
}
