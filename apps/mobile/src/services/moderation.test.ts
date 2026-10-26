import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptCommunityRules, getModerationQueue, getModerationStatus, reportCircleContent, reviewModerationReport } from './moderation';
import { COMMUNITY_RULES_VERSION, parseModerationQueue, parseModerationStatus } from '@/domain/moderation';

const owner = '10000000-0000-4000-8000-000000000001';
const target = '10000000-0000-4000-8000-000000000002';
const group = '20000000-0000-4000-8000-000000000001';
const report = '30000000-0000-4000-8000-000000000001';
const clientReportId = '40000000-0000-4000-8000-000000000001';
const stamp = '2026-10-12T12:00:00Z';
const status = { rulesVersion: COMMUNITY_RULES_VERSION, acceptedRulesVersion: null, isModerator: false, restriction: null, notices: [] };
const row = { id: report, targetUserId: target, targetDisplayName: 'Scout', kind: 'person', reason: 'harassment', details: 'Repeated insults',
  snapshot: { displayName: 'Scout', sharedLabels: [{ label: 'Social', minutes: 15 }] }, status: 'open', createdAt: stamp, version: 1, action: null };
const input = { targetUserId: target, reason: 'harassment' as const, details: 'Repeated insults', clientReportId };
const h = vi.hoisted(() => ({ session: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ requireSupabase: () => ({ auth: { getSession: h.session }, rpc: h.rpc }) }));
beforeEach(() => {
  vi.clearAllMocks(); h.session.mockResolvedValue({ data: { session: { user: { id: owner } } }, error: null });
  h.rpc.mockResolvedValue({ data: status, error: null });
});
afterEach(() => vi.useRealTimers());

describe('moderation RPC boundary', () => {
  it('loads only owner-bound status without client authority fields', async () => {
    expect(await getModerationStatus(owner)).toEqual(status);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('get_my_moderation_status', { expected_user_id: owner });
  });
  it('accepts only the rules actually displayed and verifies acknowledgement', async () => {
    await expect(acceptCommunityRules(owner, 'future')).rejects.toThrow('latest');
    expect(h.rpc).not.toHaveBeenCalled();
    h.rpc.mockResolvedValue({ data: { ...status, acceptedRulesVersion: COMMUNITY_RULES_VERSION }, error: null });
    await acceptCommunityRules(owner, COMMUNITY_RULES_VERSION);
    expect(h.rpc).toHaveBeenLastCalledWith('accept_community_rules', { expected_user_id: owner, rules_version: COMMUNITY_RULES_VERSION });
    h.rpc.mockResolvedValue({ data: status, error: null });
    await expect(acceptCommunityRules(owner, COMMUNITY_RULES_VERSION)).rejects.toThrow('could not be confirmed');
  });
  it('sends target IDs and a stable deduplication key, never a client-created snapshot', async () => {
    h.rpc.mockResolvedValue({ data: { reportId: report, status: 'received' }, error: null });
    expect(await reportCircleContent(owner, group, input)).toEqual({ reportId: report, status: 'received' });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('submit_circle_report', { expected_user_id: owner, expected_group_id: group,
      target_user_id: target, target_request_id: null, reason: 'harassment', details: 'Repeated insults', client_report_id: clientReportId });
  });
  it('rejects self reports, invalid IDs, oversized reports and bad reasons before dispatch', async () => {
    await expect(reportCircleContent(owner, group, { ...input, targetUserId: owner })).rejects.toThrow('yourself');
    await expect(reportCircleContent(owner, 'SCOUT', input)).rejects.toThrow('Refresh');
    await expect(reportCircleContent(owner, group, { ...input, details: 'a'.repeat(501) })).rejects.toThrow('500');
    await expect(reportCircleContent(owner, group, { ...input, reason: 'made_up' as never })).rejects.toThrow('reason');
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it('rejects account changes before dispatch and after a response', async () => {
    h.session.mockResolvedValueOnce({ data: { session: { user: { id: target } } }, error: null });
    await expect(getModerationStatus(owner)).rejects.toThrow('account changed');
    expect(h.rpc).not.toHaveBeenCalled();
    h.session.mockResolvedValueOnce({ data: { session: { user: { id: owner } } }, error: null })
      .mockResolvedValueOnce({ data: { session: { user: { id: target } } }, error: null });
    await expect(getModerationStatus(owner)).rejects.toThrow('account changed');
  });
  it('does not retry timed-out reports or claim success', async () => {
    vi.useFakeTimers(); h.rpc.mockReturnValue(new Promise(() => undefined));
    const promise = expect(reportCircleContent(owner, group, input)).rejects.toThrow('could not be confirmed');
    await vi.advanceTimersByTimeAsync(20_001); await promise;
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it('honestly handles undeployed RPCs', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    await expect(getModerationStatus(owner)).rejects.toThrow('server update');
  });
  it('does not use a client moderator flag to authorize the queue', async () => {
    h.rpc.mockResolvedValue({ data: [row], error: null });
    expect(await getModerationQueue(owner, 'open')).toEqual([row]);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('get_moderation_queue', { expected_user_id: owner, status_filter: 'open' });
    h.rpc.mockResolvedValue({ data: null, error: { message: 'Moderator access required' } });
    await expect(getModerationQueue(owner)).rejects.toThrow('Moderator access required');
  });
  it('pages closed reports by their exact server timestamp and ID', async () => {
    h.rpc.mockResolvedValue({ data: [], error: null });
    await getModerationQueue(owner, 'resolved', { createdAt: stamp, id: report });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('get_moderation_queue', { expected_user_id: owner,
      status_filter: 'resolved', after_created_at: stamp, after_id: report });
    await expect(getModerationQueue(owner, 'resolved', { createdAt: 'bad', id: report })).rejects.toThrow('Refresh');
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it('permits multiline report explanations without invisible control characters', async () => {
    h.rpc.mockResolvedValue({ data: { reportId: report, status: 'received' }, error: null });
    await reportCircleContent(owner, group, { ...input, details: 'First line\nSecond line' });
    expect(h.rpc.mock.calls[0][1].details).toBe('First line\nSecond line');
    await expect(reportCircleContent(owner, group, { ...input, details: 'Bad\u0007text' })).rejects.toThrow('control characters');
  });
  it('binds review to current report version and requires explanatory notes', async () => {
    const review = { reportId: report, expectedVersion: 1, action: 'restrict' as const, moderatorNote: 'Please stop repeated insults.', restrictionDays: 7 };
    h.rpc.mockResolvedValue({ data: { reportId: report, status: 'resolved', version: 2 }, error: null });
    expect(await reviewModerationReport(owner, review)).toEqual({ reportId: report, status: 'resolved', version: 2 });
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith('review_moderation_report', { expected_user_id: owner, report_id: report,
      expected_version: 1, action: 'restrict', moderator_note: review.moderatorNote, restriction_days: 7 });
    await expect(reviewModerationReport(owner, { ...review, moderatorNote: '' })).rejects.toThrow('Explain');
    await expect(reviewModerationReport(owner, { ...review, restrictionDays: 0 })).rejects.toThrow('duration');
    await expect(reviewModerationReport(owner, { ...review, action: 'restore', restrictionDays: null, moderatorNote: '' })).rejects.toThrow('Explain');
    h.rpc.mockResolvedValue({ data: { reportId: report, status: 'resolved', version: 4 }, error: null });
    await expect(reviewModerationReport(owner, review)).rejects.toThrow('could not be confirmed');
  });
});

describe('moderation response parsing', () => {
  it('discards incidental private metadata', () => {
    expect(parseModerationStatus({ ...status, reporterId: owner })).toEqual(status);
    expect(parseModerationQueue([{ ...row, reporterId: owner, snapshot: { ...row.snapshot, loginKey: 'NEVER-RENDER' } }])).toEqual([row]);
  });
  it.each([null, {}, { ...status, isModerator: 'true' }, { ...status, notices: [{ id: report, message: 'Hi', createdAt: 'bad' }] },
    { ...status, restriction: { reason: 'Pause', createdAt: stamp, until: 'bad' } }])('fails closed on malformed status %j', value => {
    expect(() => parseModerationStatus(value)).toThrow('verified');
  });
  it.each([null, {}, [row, row], [{ ...row, version: 0 }], [{ ...row, reason: 'other_reason' }],
    [{ ...row, snapshot: { displayName: 'Scout', sharedLabels: [{ label: 'Social', minutes: -1 }] } }]])('rejects malformed queues %j', value => {
    expect(() => parseModerationQueue(value)).toThrow('verified');
  });
});
