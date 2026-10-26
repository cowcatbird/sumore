import { describe, expect, it } from 'vitest';
import { parseScreenTimeGrant } from './screen-time-grants';

const grant = {
  grantId: '11111111-1111-4111-8111-111111111111', requesterId: '22222222-2222-4222-8222-222222222222', requestId: '33333333-3333-4333-8333-333333333333', source: 'request' as const,
  startedAt: '2026-09-14T12:00:00.123456+00:00', expiresAt: '2026-09-14T12:15:00.123456+00:00', serverNow: '2026-09-14T12:00:01+00:00',
};

describe('fixed-expiry Screen Time grant contract', () => {
  it('accepts Postgres timestamps without replacing the fixed expiry', () => {
    expect(parseScreenTimeGrant(grant)).toEqual(grant);
    const longer = { ...grant, expiresAt: '2026-09-14T12:30:00.123456+00:00' };
    expect(parseScreenTimeGrant(longer)).toEqual(longer);
  });
  it('accepts expired replay metadata for the caller to reject, never resets it', () => {
    const expired = { ...grant, serverNow: '2026-09-15T12:00:00Z' };
    expect(parseScreenTimeGrant(expired).expiresAt).toBe(grant.expiresAt);
  });
  it.each([null, [], {}, 'grant', { ...grant, requesterId: 'stranger' }, { ...grant, expiresAt: 'later' }, { ...grant, serverNow: '2026-09-13T12:00:00Z' }, { ...grant, expiresAt: '2026-09-14T13:00:00Z' }])('rejects malformed identities and time windows (%j)', value => {
    expect(() => parseScreenTimeGrant(value)).toThrow();
  });

  it('accepts a panic grant with no approval behind it, and refuses a laundered one', () => {
    const panic = { ...grant, requestId: null, source: 'panic' };
    expect(parseScreenTimeGrant(panic)).toMatchObject({ source: 'panic', requestId: null });
    // Omitting the id entirely is the same claim as sending null.
    const { requestId, ...withoutRequest } = panic;
    expect(parseScreenTimeGrant({ ...withoutRequest, source: 'panic' }).requestId).toBeNull();
    // A panic grant must not be able to borrow an approval it never had.
    expect(() => parseScreenTimeGrant({ ...grant, source: 'panic' })).toThrow();
    // A request grant still has to name its approval.
    expect(() => parseScreenTimeGrant({ ...grant, requestId: null })).toThrow();
    expect(() => parseScreenTimeGrant({ ...grant, requestId: 'not-a-uuid' })).toThrow();
    // An unknown source is never treated as a request grant by default.
    expect(() => parseScreenTimeGrant({ ...grant, source: 'gift' })).toThrow();
    expect(() => parseScreenTimeGrant({ ...panic, expiresAt: '2026-09-14T12:30:00.123456+00:00' })).toThrow();
    // A server predating this field still returns usable request grants.
    const { source, ...legacy } = panic;
    expect(parseScreenTimeGrant({ ...legacy, requestId: grant.requestId }).source).toBe('request');
  });
});
