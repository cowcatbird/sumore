import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openProblemReportEmail, problemReportEmail } from './feedback';

const h = vi.hoisted(() => ({ available: vi.fn(), compose: vi.fn(), openURL: vi.fn(), os: 'ios' }));
vi.mock('expo-mail-composer', () => ({
  isAvailableAsync: h.available, composeAsync: h.compose,
  MailComposerStatus: { CANCELLED: 'cancelled', SAVED: 'saved', SENT: 'sent' },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.2.0' } } }));
vi.mock('react-native', () => ({ Platform: { get OS() { return h.os; } }, Linking: { openURL: h.openURL } }));
beforeEach(() => {
  vi.resetAllMocks(); h.os = 'ios';
  h.available.mockResolvedValue(true); h.compose.mockResolvedValue({ status: 'sent' }); h.openURL.mockResolvedValue(undefined);
});

describe('user-sent feedback email', () => {
  it.each(['', 'short', 'x'.repeat(4001)])('rejects invalid length before opening anything', async message => {
    await expect(openProblemReportEmail(message)).rejects.toThrow('10 and 4,000');
    expect(h.available).not.toHaveBeenCalled(); expect(h.openURL).not.toHaveBeenCalled();
  });
  it('includes only intentional message and app metadata in a plain-text user-reviewed draft', async () => {
    await expect(openProblemReportEmail('  A synthetic issue with the app.  ')).resolves.toBe('accepted');
    expect(h.compose).toHaveBeenCalledExactlyOnceWith({
      recipients: ['cowcatbird.dev@gmail.com'], subject: '[Report a problem] sumore',
      body: 'A synthetic issue with the app.\n\n---\nsumore 1.2.0 · ios', isHtml: false,
    });
    expect(h.openURL).not.toHaveBeenCalled();
  });
  it.each([['cancelled', 'cancelled'], ['saved', 'saved'], ['undetermined', 'opened']])('handles iOS composer status %s without claiming delivery', async (status, result) => {
    h.compose.mockResolvedValue({ status });
    await expect(openProblemReportEmail('A synthetic issue.')).resolves.toBe(result);
  });
  it('never interprets Android SENT as actual sending', async () => {
    h.os = 'android';
    await expect(openProblemReportEmail('A synthetic issue.')).resolves.toBe('opened');
  });
  it.each(['ios', 'android', 'web'])('uses an encoded mailto fallback on %s without requiring an account/server', async os => {
    h.os = os; h.available.mockResolvedValue(false);
    const message = 'Issue & details? café\nBcc: not-a-recipient@example.com';
    await expect(openProblemReportEmail(message)).resolves.toBe('opened');
    const url = new URL(h.openURL.mock.calls[0][0]);
    expect(url.pathname).toBe('cowcatbird.dev@gmail.com');
    expect([...url.searchParams.keys()]).toEqual(['subject', 'body']);
    expect(url.searchParams.get('subject')).toBe('[Report a problem] sumore');
    expect(url.searchParams.get('body')).toBe(problemReportEmail(message).body);
    expect(h.compose).not.toHaveBeenCalled();
    if (os === 'web') expect(h.available).not.toHaveBeenCalled();
  });
  it('still tries the default mail app if availability detection fails', async () => {
    h.available.mockRejectedValue(new Error('unavailable'));
    await expect(openProblemReportEmail('A synthetic issue.')).resolves.toBe('opened');
    expect(h.openURL).toHaveBeenCalledTimes(1);
  });
  it.each(['composer', 'mailto'])('offers copy fallback on %s failure without leaking details or retrying', async mode => {
    if (mode === 'composer') h.compose.mockRejectedValue(new Error('PRIVATE-DETAIL'));
    else { h.available.mockResolvedValue(false); h.openURL.mockRejectedValue(new Error('PRIVATE-DETAIL')); }
    await expect(openProblemReportEmail('A synthetic issue.')).rejects.toThrow('Copy your report');
    expect(h.compose).toHaveBeenCalledTimes(mode === 'composer' ? 1 : 0);
    expect(h.openURL).toHaveBeenCalledTimes(mode === 'mailto' ? 1 : 0);
  });
  it('keeps maximum-length messages intact in the native composer', async () => {
    await openProblemReportEmail('x'.repeat(4000));
    expect(h.compose.mock.calls[0][0].body).toMatch(/^x{4000}\n/);
  });
});
