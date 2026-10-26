import { describe, expect, it, vi } from 'vitest';
import { createFeedbackHandler, type FeedbackDependencies } from './core';

const actor = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const lease = '33333333-3333-4333-8333-333333333333';
const provider = '44444444-4444-4444-8444-444444444444';
const message = 'My selected apps did not stay selected.';
const body = { id, message, platform: 'android', appVersion: '1.2.0' };
const request = (value: unknown = body) => new Request('https://example.invalid/report-problem', {
  method: 'POST', headers: { Authorization: 'Bearer real-token', 'Content-Type': 'application/json' }, body: JSON.stringify(value),
});
function fixture(overrides: Partial<FeedbackDependencies> = {}) {
  const deps: FeedbackDependencies = {
    configured: true, sender: 'sumore <reports@example.invalid>',
    authenticate: vi.fn(async () => ({ id: actor })),
    rpc: vi.fn(async (name: string) => name === 'feedback_reserve' ? { state: 'ready', leaseId: lease, sender: 'sumore <reports@example.invalid>' } : true),
    send: vi.fn(async () => ({ id: provider })),
    ...overrides,
  };
  return { deps, handler: createFeedbackHandler(deps) };
}

describe('report-problem authenticated email delivery', () => {
  it('reports success only after provider acceptance and durable sent marker', async () => {
    const { deps, handler } = fixture();
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true, reportId: id });
    expect(deps.authenticate).toHaveBeenCalledWith('real-token');
    expect(deps.rpc).toHaveBeenNthCalledWith(1, 'feedback_reserve', {
      actor_id: actor, report_id: id, report_message: message, report_platform: 'android', report_version: '1.2.0', sender: 'sumore <reports@example.invalid>',
    });
    expect(deps.send).toHaveBeenCalledWith({ from: 'sumore <reports@example.invalid>', to: 'cowcatbird.dev@gmail.com', subject: '[Report a problem] sumore',
      text: `Report: ${id}\nAccount: ${actor}\nPlatform: android\nVersion: 1.2.0\n\n${message}`,
      idempotencyKey: `sumore-feedback/${actor}/${id}` });
    expect(deps.rpc).toHaveBeenNthCalledWith(2, 'feedback_finish', { actor_id: actor, report_id: id, lease_id: lease, provider_id: provider });
  });
  it('missing email setup returns503 before authentication, quota or persistence', async () => {
    const { deps, handler } = fixture({ configured: false });
    expect((await handler(request())).status).toBe(503);
    expect(deps.authenticate).not.toHaveBeenCalled(); expect(deps.rpc).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
  });
  it('rejects unverified authentication before reservation', async () => {
    const { deps, handler } = fixture({ authenticate: vi.fn(async () => null) });
    expect((await handler(request())).status).toBe(401);
    expect(deps.rpc).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
  });
  it('does not permit a client to choose recipient, sender, subject or another account', async () => {
    const { deps, handler } = fixture();
    for (const field of ['to', 'from', 'subject', 'actor_id']) {
      expect((await handler(request({ ...body, [field]: 'attacker@example.invalid' }))).status).toBe(400);
    }
    expect(deps.rpc).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
  });
  it.each(['', 'short', 'x'.repeat(4001), 'valid length\u0000report'])('rejects invalid message %j', async invalid => {
    const { deps, handler } = fixture();
    expect((await handler(request({ ...body, message: invalid }))).status).toBe(400);
    expect(deps.rpc).not.toHaveBeenCalled();
  });
  it('accepts boundary lengths and sends text rather than interpreting HTML', async () => {
    for (const valid of ['0123456789', 'x'.repeat(4000), '<script>alert(1)</script>']) {
      const { deps, handler } = fixture();
      expect((await handler(request({ ...body, message: valid }))).status).toBe(200);
      expect(vi.mocked(deps.send).mock.calls[0][0]).toHaveProperty('text', expect.stringContaining(valid));
      expect(vi.mocked(deps.send).mock.calls[0][0]).not.toHaveProperty('html');
    }
  });
  it('bounds UTF8 body bytes rather than trusting Content-Length', async () => {
    const { deps, handler } = fixture();
    expect((await handler(request({ ...body, message: '😀'.repeat(4000) }))).status).toBe(400);
    expect(deps.rpc).not.toHaveBeenCalled();
  });
  it.each([{ id: 'bad' }, { platform: 'other' }, { appVersion: '1.2\nBcc: bad' }, { message: 123 }])('validates all metadata: %j', async changed => {
    const { deps, handler } = fixture();
    expect((await handler(request({ ...body, ...changed }))).status).toBe(400);
    expect(deps.rpc).not.toHaveBeenCalled();
  });
  it.each([['rateLimited', 429], ['busy', 503], ['conflict', 409], ['expired', 409]] as const)('does not send %s reservation', async (state, status) => {
    const { deps, handler } = fixture({ rpc: vi.fn(async () => ({ state })) });
    expect((await handler(request())).status).toBe(status);
    expect(deps.send).not.toHaveBeenCalled();
  });
  it('sent retries return prior success without contacting provider', async () => {
    const { deps, handler } = fixture({ rpc: vi.fn(async () => ({ state: 'sent' })) });
    expect(await (await handler(request())).json()).toEqual({ sent: true, reportId: id });
    expect(deps.send).not.toHaveBeenCalled();
  });
  it('uses original persisted sender for byte-identical idempotent retries', async () => {
    const { deps, handler } = fixture({ sender: 'new <new@example.invalid>' });
    await handler(request());
    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({ from: 'sumore <reports@example.invalid>' }));
  });
  it('provider failure never marks sent, releases only own lease and never echoes provider secrets', async () => {
    const { deps, handler } = fixture({ send: vi.fn(async () => { throw new Error('secret-provider-key private body'); }) });
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret-provider-key');
    expect(deps.rpc).not.toHaveBeenCalledWith('feedback_finish', expect.anything());
    expect(deps.rpc).toHaveBeenLastCalledWith('feedback_release', { actor_id: actor, report_id: id, lease_id: lease });
  });
  it('database mark failure does not tell the user sent, next retry keeps same provider key', async () => {
    const rpc = vi.fn(async (name: string) => name === 'feedback_reserve' ? { state: 'ready', leaseId: lease, sender: 'reports@example.invalid' } : false);
    const { deps, handler } = fixture({ rpc });
    expect((await handler(request())).status).toBe(503);
    expect((await handler(request())).status).toBe(503);
    expect(vi.mocked(deps.send).mock.calls.map(call => call[0].idempotencyKey)).toEqual([`sumore-feedback/${actor}/${id}`, `sumore-feedback/${actor}/${id}`]);
  });
  it('malformed provider acceptance is not reported as sent', async () => {
    const { deps, handler } = fixture({ send: vi.fn(async () => ({ id: '' })) });
    expect((await handler(request())).status).toBe(503);
    expect(deps.rpc).not.toHaveBeenCalledWith('feedback_finish', expect.anything());
  });
  it('handles CORS without auth and rejects unsupported methods', async () => {
    const { handler } = fixture({ configured: false });
    expect((await handler(new Request('https://example.invalid', { method: 'OPTIONS' }))).status).toBe(204);
    expect((await handler(new Request('https://example.invalid'))).status).toBe(405);
  });
});
