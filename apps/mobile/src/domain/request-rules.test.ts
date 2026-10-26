import { describe, expect, it } from 'vitest';

import {
  applyDecision,
  canDecideRequest,
  createExpiry,
  effectiveRequestStatus,
  isGrantMinutes,
  requestLifetimeMs,
} from './request-rules';

describe('request rules', () => {
  it('accepts only the four supported grant lengths', () => {
    expect([5, 10, 15, 30].every(isGrantMinutes)).toBe(true);
    expect(isGrantMinutes(20)).toBe(false);
  });

  it('expires requests after twenty minutes', () => {
    const createdAt = new Date('2026-09-04T12:00:00.000Z');
    expect(requestLifetimeMs).toBe(20 * 60 * 1000);
    expect(createExpiry(createdAt).getTime() - createdAt.getTime()).toBe(requestLifetimeMs);
  });

  it('does not allow decisions after expiration', () => {
    const expiresAt = '2026-09-04T12:05:00.000Z';
    const now = new Date('2026-09-04T12:06:00.000Z');
    expect(effectiveRequestStatus('pending', expiresAt, now)).toBe('expired');
    expect(canDecideRequest('pending', expiresAt, now)).toBe(false);
    expect(() => applyDecision('pending', expiresAt, 'approved', now)).toThrow();
  });

  it('accepts the first valid approval or denial', () => {
    const expiresAt = '2026-09-04T12:05:00.000Z';
    const now = new Date('2026-09-04T12:01:00.000Z');
    expect(applyDecision('pending', expiresAt, 'approved', now)).toBe('approved');
    expect(applyDecision('pending', expiresAt, 'denied', now)).toBe('denied');
  });
});
