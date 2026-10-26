import { describe, expect, it, vi } from 'vitest';
import { createPushHandler } from '../../../../supabase/functions/push-notifications/core';

const requestId = '30000000-0000-4000-8000-000000000001';
const payload = (status = 'pending') => ({ table: 'time_requests', type: status === 'pending' ? 'INSERT' : 'UPDATE', old_record: { status: 'pending' },
  record: { id: requestId, status, requester_id: 'UNTRUSTED', minutes: 999, tokens: ['NEVER-SEND'] } });
const request = (data: unknown, secret = 'fixture-secret') => new Request('https://fixture.invalid', {
  method: 'POST', headers: { 'x-webhook-secret': secret }, body: JSON.stringify(data),
});
const current = (patch: Record<string, unknown> = {}) => ({ requestId, status: 'pending', requesterName: 'Scout', deciderName: null, minutes: 15, tokens: ['ExpoPushToken[fixture]'], ...patch });
const fixture = () => {
  const deps = { secret: 'fixture-secret', context: vi.fn().mockResolvedValue(current()), send: vi.fn().mockResolvedValue(undefined) };
  return { ...deps, handler: createPushHandler(deps) };
};
describe('circle-aware push delivery', () => {
  it('authenticates before reading any privileged recipients', async () => {
    const f = fixture(); expect((await f.handler(request(payload(), 'wrong'))).status).toBe(401);
    expect(f.context).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('suppresses queued stale/blocked/left/expired requests when SQL returns null', async () => {
    const f = fixture(); f.context.mockResolvedValue(null);
    expect(await (await f.handler(request(payload()))).json()).toEqual({ sent: 0 }); expect(f.send).not.toHaveBeenCalled();
  });
  it('only trusts revalidated database context, not webhook names, recipients, or minutes', async () => {
    const f = fixture(); expect(await (await f.handler(request(payload()))).json()).toEqual({ sent: 1 });
    expect(f.context).toHaveBeenCalledWith(requestId, 'pending');
    expect(f.send).toHaveBeenCalledExactlyOnceWith([{ to: 'ExpoPushToken[fixture]', sound: 'default', title: 'Scout is asking', body: 'Approve or deny 15 more minutes.', data: { url: '/requests', requestId } }]);
  });
  it('rechecks membership after each batch instead of reusing captured recipients', async () => {
    const f = fixture();
    f.context.mockResolvedValueOnce(current({ tokens: Array.from({ length: 150 }, (_, i) => `ExpoPushToken[fixture-${i}]`) })).mockResolvedValue(null);
    expect(await (await f.handler(request(payload()))).json()).toEqual({ sent: 100 });
    expect(f.context).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('deduplicates tokens and never sends a notification announcing a block/cancellation', async () => {
    const f = fixture(); f.context.mockResolvedValue(current({ tokens: ['ExpoPushToken[fixture]', 'ExpoPushToken[fixture]', 'invalid'] }));
    expect(await (await f.handler(request(payload()))).json()).toEqual({ sent: 1 });
    f.context.mockClear(); f.send.mockClear();
    expect(await (await f.handler(request(payload('cancelled')))).json()).toEqual({ sent: 0 });
    expect(f.context).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(['approved', 'denied'])('sends the current %s decision only to authorized returned tokens', async status => {
    const f = fixture(); f.context.mockResolvedValue(current({ status, deciderName: 'Friend' }));
    expect(await (await f.handler(request(payload(status)))).json()).toEqual({ sent: 1 });
    expect(f.send.mock.calls[0][0][0].data).toEqual({ url: '/', requestId, decision: status });
  });
  it('fails closed if the new RPC is missing or returns a mismatched request', async () => {
    const f = fixture(); f.context.mockRejectedValueOnce(new Error('private SDK detail'));
    expect(await (await f.handler(request(payload()))).json()).toEqual({ error: 'Notification delivery could not be confirmed.' });
    f.context.mockResolvedValue(current({ requestId: 'different' }));
    expect((await f.handler(request(payload()))).status).toBe(500); expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects invalid/oversized input without querying or logging', async () => {
    const f = fixture();
    expect((await f.handler(request({ ...payload(), record: { id: 'invalid' } }))).status).toBe(400);
    expect((await f.handler(request({ ...payload(), extra: 'x'.repeat(70_000) }))).status).toBe(400);
    expect(f.context).not.toHaveBeenCalled();
  });
});
