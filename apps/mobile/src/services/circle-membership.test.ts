import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockCirclePerson, getBlockedPeople, leaveSharedCircle, unblockCirclePerson } from './circle-membership';

const owner = '10000000-0000-4000-8000-000000000001';
const person = '10000000-0000-4000-8000-000000000002';
const group = '20000000-0000-4000-8000-000000000001';
const nextGroup = '20000000-0000-4000-8000-000000000002';
const h = vi.hoisted(() => ({ session: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ requireSupabase: () => ({ auth: { getSession: h.session }, rpc: h.rpc }) }));
const shop = (id = nextGroup) => ({ id, name: 'Your circle', balance: 0, unlocked: [], background: 'forest', localDate: '2026-09-29', timeZone: 'UTC',
  askedToday: false, eligibleToday: false, dayStartedAt: '2026-09-29T00:00:00Z', nextAwardAt: '2026-09-30T00:00:00Z' });
beforeEach(() => {
  vi.clearAllMocks(); h.session.mockResolvedValue({ data: { session: { user: { id: owner } } }, error: null });
  h.rpc.mockResolvedValue({ data: { leftCircle: true, circleShop: shop(), blockedUserId: person, unblockedUserId: person }, error: null });
});
afterEach(() => vi.useRealTimers());

describe('circle membership RPC boundary', () => {
  it('binds leave to the confirmed owner and circle, with no balances sent', async () => {
    expect((await leaveSharedCircle(owner, group)).circleShop.balance).toBe(0);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('leave_shared_circle', { expected_group_id: group, expected_user_id: owner });
  });
  it('accepts solo no-op only with the same circle', async () => {
    h.rpc.mockResolvedValue({ data: { leftCircle: false, circleShop: shop(group) }, error: null });
    expect((await leaveSharedCircle(owner, group)).leftCircle).toBe(false);
    h.rpc.mockResolvedValue({ data: { leftCircle: true, circleShop: shop(group) }, error: null });
    await expect(leaveSharedCircle(owner, group)).rejects.toThrow('could not be confirmed');
  });
  it('validates block acknowledgement and group transition', async () => {
    await blockCirclePerson(owner, group, person);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('block_circle_person', { expected_user_id: owner, expected_group_id: group, target_user_id: person });
    h.rpc.mockResolvedValue({ data: { blockedUserId: owner, leftCircle: true, circleShop: shop() }, error: null });
    await expect(blockCirclePerson(owner, group, person)).rejects.toThrow('could not be confirmed');
  });
  it('unblocks only the explicit owner-target pair and never calls join', async () => {
    await unblockCirclePerson(owner, person);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('unblock_circle_person', { expected_user_id: owner, target_user_id: person });
    h.rpc.mockResolvedValue({ data: { unblockedUserId: owner }, error: null });
    await expect(unblockCirclePerson(owner, person)).rejects.toThrow('could not be confirmed');
  });
  it('rejects invalid identifiers and self-block before calling the backend', async () => {
    await expect(blockCirclePerson(owner, group, owner)).rejects.toThrow('yourself');
    await expect(leaveSharedCircle('', group)).rejects.toThrow('Refresh');
    await expect(blockCirclePerson(owner, group, 'SCOUT')).rejects.toThrow('Refresh');
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('rejects stale account before dispatch and after response', async () => {
    h.session.mockResolvedValueOnce({ data: { session: { user: { id: person } } }, error: null });
    await expect(leaveSharedCircle(owner, group)).rejects.toThrow('account changed');
    expect(h.rpc).not.toHaveBeenCalled();
    const result = Promise.withResolvers<{ data: unknown; error: null }>(); h.rpc.mockReturnValue(result.promise);
    const pending = blockCirclePerson(owner, group, person);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    h.session.mockResolvedValue({ data: { session: { user: { id: person } } }, error: null });
    result.resolve({ data: { blockedUserId: person, leftCircle: true, circleShop: shop() }, error: null });
    await expect(pending).rejects.toThrow('account changed');
  });
  it('does not falsely succeed or automatically retry a timed-out mutation', async () => {
    vi.useFakeTimers(); h.rpc.mockReturnValue(new Promise(() => undefined));
    const attempt = expect(leaveSharedCircle(owner, group)).rejects.toThrow('Refresh your circle');
    await vi.advanceTimersByTimeAsync(20_001); await attempt;
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it('requires a backend update instead of pretending a local-only block worked', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'missing' } });
    await expect(leaveSharedCircle(owner, group)).rejects.toThrow('server update');
  });
  it('validates the private list and discards unneeded response fields', async () => {
    h.rpc.mockResolvedValue({ data: [{ id: person, displayName: 'Scout', blockedAt: '2026-09-29T05:00:00Z', friendCode: 'NEVER-SHOW' }], error: null });
    expect(await getBlockedPeople(owner)).toEqual([{ id: person, displayName: 'Scout', blockedAt: '2026-09-29T05:00:00Z' }]);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('get_blocked_people', { expected_user_id: owner });
  });
  it.each([null, {}, [{ id: owner, displayName: 'Self', blockedAt: '2026-09-29T05:00:00Z' }], [{ id: person, displayName: 'Scout', blockedAt: 'bad' }]])('rejects malformed/private-list responses %j', async data => {
    h.rpc.mockResolvedValue({ data, error: null });
    await expect(getBlockedPeople(owner)).rejects.toThrow('blocked list');
  });
});
