import { beforeEach, describe, expect, it, vi } from 'vitest';
import { communityReportEmail, openCommunityReportEmail } from './moderation-email';

const h = vi.hoisted(() => ({ available: vi.fn(), compose: vi.fn(), openURL: vi.fn(), os: 'ios' }));
vi.mock('expo-mail-composer', () => ({
  isAvailableAsync: h.available, composeAsync: h.compose,
  MailComposerStatus: { CANCELLED: 'cancelled', SAVED: 'saved', SENT: 'sent' },
}));
vi.mock('react-native', () => ({ Platform: { get OS() { return h.os; } }, Linking: { openURL: h.openURL } }));
const input = { reportId: '30000000-0000-4000-8000-000000000001', targetDisplayName: 'Scout',
  kind: 'person' as const, reason: 'harassment' as const, details: 'Repeated messages.' };
beforeEach(() => {
  vi.resetAllMocks(); h.os = 'ios'; h.available.mockResolvedValue(true);
  h.compose.mockResolvedValue({ status: 'sent' }); h.openURL.mockResolvedValue(undefined);
});

describe('user-reviewed community report emails', () => {
  it('prepares a plain-text reference with a fixed recipient and no hidden identity metadata', async () => {
    expect(await openCommunityReportEmail(input)).toBe('accepted');
    expect(h.compose).toHaveBeenCalledExactlyOnceWith(communityReportEmail(input));
    const draft = h.compose.mock.calls[0][0];
    expect(draft.recipients).toEqual(['cowcatbird.dev@gmail.com']);
    expect(draft.subject).toBe('[Community report] sumore'); expect(draft.isHtml).toBe(false);
    expect(draft.body).toContain(input.reportId); expect(draft.body).toContain('Scout');
    expect(draft.body).toContain('Please verify that record');
    expect(Object.keys(draft)).toEqual(['recipients', 'subject', 'isHtml', 'body']);
  });
  it.each([['cancelled', 'cancelled'], ['saved', 'saved'], ['unknown', 'opened']])('does not mistake iOS %s for sending', async (status, expected) => {
    h.compose.mockResolvedValue({ status });
    expect(await openCommunityReportEmail(input)).toBe(expected);
  });
  it('never claims Android SENT confirms sending or delivery', async () => {
    h.os = 'android'; expect(await openCommunityReportEmail(input)).toBe('opened');
  });
  it.each(['ios', 'android', 'web'])('uses a safely encoded mailto on %s', async os => {
    h.os = os; h.available.mockResolvedValue(false);
    const draftInput = { ...input, details: 'Abuse & details?\nBcc: nobody@example.invalid' };
    expect(await openCommunityReportEmail(draftInput)).toBe('opened');
    const url = new URL(h.openURL.mock.calls[0][0]);
    expect(url.pathname).toBe('cowcatbird.dev@gmail.com');
    expect([...url.searchParams.keys()]).toEqual(['subject', 'body']);
    expect(url.searchParams.get('body')).toBe(communityReportEmail(draftInput).body);
    expect(h.compose).not.toHaveBeenCalled();
  });
  it('does not open a stale account draft after capability detection', async () => {
    const available = Promise.withResolvers<boolean>(); h.available.mockReturnValue(available.promise);
    let current = true;
    const pending = expect(openCommunityReportEmail(input, () => current)).rejects.toThrow('account or circle changed');
    current = false; available.resolve(true); await pending;
    expect(h.compose).not.toHaveBeenCalled(); expect(h.openURL).not.toHaveBeenCalled();
  });
  it('rejects a stale account before any capability query', async () => {
    await expect(openCommunityReportEmail(input, () => false)).rejects.toThrow('account or circle changed');
    expect(h.available).not.toHaveBeenCalled();
  });
  it.each(['composer', 'mailto'])('does not retry %s failures or falsely claim email sent', async mode => {
    if (mode === 'composer') h.compose.mockRejectedValue(new Error('PRIVATE INTERNAL DETAIL'));
    else { h.available.mockResolvedValue(false); h.openURL.mockRejectedValue(new Error('PRIVATE INTERNAL DETAIL')); }
    await expect(openCommunityReportEmail(input)).rejects.toThrow('Copy the report');
    expect(h.compose).toHaveBeenCalledTimes(mode === 'composer' ? 1 : 0);
    expect(h.openURL).toHaveBeenCalledTimes(mode === 'mailto' ? 1 : 0);
  });
  it.each([{ reportId: 'BAD' }, { targetDisplayName: '' }, { details: 'a'.repeat(501) }, { reason: 'invalid' }, { kind: 'invalid' }])('rejects malformed email inputs %j', async change => {
    await expect(openCommunityReportEmail({ ...input, ...change } as typeof input)).rejects.toThrow('Reopen');
    expect(h.available).not.toHaveBeenCalled(); expect(h.openURL).not.toHaveBeenCalled();
  });
});
