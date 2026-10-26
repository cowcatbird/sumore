import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRecoveryNotice, createLoginKey, deleteAccount, getCircleAppLimits, getLoginKey, getRecoveryNotice, normalizeLoginKey, restoreAccount, revokeLoginKey, setSharedAppLimits, setSharedDailyTotal, subscribeRecoveryNotice, validateSharedAppLabels } from './account-access';
import { appTourStorageKey } from '@/domain/app-tour-state';

const m = vi.hoisted(() => ({
  invoke: vi.fn(), rpc: vi.fn(), getSession: vi.fn(), setSession: vi.fn(), signOut: vi.fn(),
  mainAnonymous: vi.fn(), isolatedAnonymous: vi.fn(), createClient: vi.fn(), retirePush: vi.fn(),
  read: vi.fn(), save: vi.fn(), remove: vi.fn(), removePreference: vi.fn(), os: { OS: 'ios' },
}));
vi.mock('@/lib/supabase', () => ({ requireSupabase: () => ({
  functions: { invoke: m.invoke }, rpc: m.rpc,
  auth: { getSession: m.getSession, setSession: m.setSession, signOut: m.signOut, signInAnonymously: m.mainAnonymous },
}) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: m.createClient }));
vi.mock('@/lib/network-fetch', () => ({ networkFetch: vi.fn(() => { throw new Error('Network forbidden in account test'); }) }));
vi.mock('@/lib/storage', () => ({ appStorage: { removeItem: m.removePreference } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: m.read, setItemAsync: m.save, deleteItemAsync: m.remove, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' }));
vi.mock('react-native', () => ({ Platform: m.os }));
vi.mock('@/services/push-device-registration', () => ({ withRetiredDevicePush: m.retirePush }));

const key = `SUMORE-${Array(8).fill('ABCDEF').join('-')}`;
const ticket = `SUMORE-${Array(8).fill('012345').join('-')}`;
const makeSession = (id: string) => ({ user: { id }, access_token: `${id}-access`, refresh_token: `${id}-refresh` });
let current: ReturnType<typeof makeSession> | null;
beforeEach(() => {
  vi.resetAllMocks();
  clearRecoveryNotice();
  current = makeSession('old');
  m.os.OS = 'ios';
  m.getSession.mockImplementation(async () => ({ data: { session: current }, error: null }));
  m.setSession.mockImplementation(async ({ access_token }) => {
    current = makeSession(access_token.split('-')[0]);
    return { data: { session: current }, error: null };
  });
  m.signOut.mockImplementation(async () => { current = null; return { error: null }; });
  m.retirePush.mockImplementation(async (_owner: string | null, action: () => Promise<unknown>) => action());
  m.read.mockResolvedValue(null);
  m.save.mockResolvedValue(undefined);
  m.remove.mockResolvedValue(undefined);
  m.removePreference.mockResolvedValue(undefined);
  m.createClient.mockReturnValue({ auth: { signInAnonymously: m.isolatedAnonymous } });
  m.isolatedAnonymous.mockResolvedValue({ data: { session: makeSession('bootstrap') }, error: null });
  m.invoke.mockImplementation(async (_name, { body }) => ({ error: null, data: body.action === 'recover'
    ? { userId: 'target', accessToken: 'target-access', refreshToken: 'target-refresh', cleanupTicket: ticket }
    : body.action === 'finish' ? { previousKeyRevoked: true }
      : body.action === 'create' ? { key } : body.action === 'delete' ? { deleted: true }
        : body.action === 'revoke' ? { revoked: true } : { hasKey: true, matches: true } }));
  vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co');
  vi.stubEnv('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'fixture-public-key-no-credentials');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('account key device storage', () => {
  it('rejects friend codes and normalizes private login keys', () => {
    expect(normalizeLoginKey('1234ABCD')).toBeNull();
    expect(normalizeLoginKey(key.toLowerCase())).toBe(key);
  });
  it('reads only a server-confirmed cached key for the active owner', async () => {
    m.read.mockResolvedValue(key);
    expect(await getLoginKey()).toEqual({ key, hasKey: true });
    expect(m.read).toHaveBeenCalledExactlyOnceWith('sumore_login_key_v1.old');
    expect(m.invoke).toHaveBeenCalledWith('account-access', { body: { action: 'status', key }, headers: { Authorization: 'Bearer old-access' } });
  });
  it('removes a stale rotated key without automatically generating a new one', async () => {
    m.read.mockResolvedValue(key);
    m.invoke.mockResolvedValue({ data: { hasKey: true, matches: false }, error: null });
    expect(await getLoginKey()).toEqual({ key: null, hasKey: true });
    expect(m.remove).toHaveBeenCalledExactlyOnceWith('sumore_login_key_v1.old');
    expect(m.save).not.toHaveBeenCalled();
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });
  it('stores created keys with device-only unlocked Keychain accessibility', async () => {
    expect(await createLoginKey()).toBe(key);
    expect(m.save).toHaveBeenCalledExactlyOnceWith('sumore_login_key_v1.old', key, { keychainAccessible: 'device-only' });
  });
  it('does not report a generated key as saved when SecureStore failed', async () => {
    m.save.mockRejectedValue(new Error('Storage unavailable'));
    await expect(createLoginKey()).rejects.toThrow('Storage unavailable');
  });
  it('revokes the server key before removing its owner-scoped device cache', async () => {
    await revokeLoginKey();
    expect(m.invoke).toHaveBeenCalledExactlyOnceWith('account-access', { body: { action: 'revoke' }, headers: { Authorization: 'Bearer old-access' } });
    expect(m.remove).toHaveBeenCalledExactlyOnceWith('sumore_login_key_v1.old');
  });
  it('does not write private keys to browser persistent storage', async () => {
    m.os.OS = 'web';
    await createLoginKey();
    expect(await getLoginKey()).toEqual({ key, hasKey: true });
    expect(m.save).not.toHaveBeenCalled();
    expect(m.read).not.toHaveBeenCalled();
    await revokeLoginKey();
  });
});

describe('restoring without destroying the previous account', () => {
  it('retires the old device token after recovery validation and before installing the new session', async () => {
    const gate = Promise.withResolvers<void>();
    m.retirePush.mockImplementation(async (owner, action) => {
      expect(owner).toBe('old'); expect(m.invoke).toHaveBeenCalledOnce();
      await gate.promise; return action();
    });
    const pending = restoreAccount(key);
    await vi.waitFor(() => expect(m.retirePush).toHaveBeenCalledOnce());
    expect(current?.user.id).toBe('old'); expect(m.setSession).not.toHaveBeenCalled();
    gate.resolve(); await pending;
    expect(current?.user.id).toBe('target');
  });
  it('does not install a recovered session or finish credential cleanup when retirement fails', async () => {
    m.retirePush.mockRejectedValue(new Error('Could not safely disconnect'));
    await expect(restoreAccount(key)).rejects.toThrow('Could not safely disconnect');
    expect(current?.user.id).toBe('old'); expect(m.setSession).not.toHaveBeenCalled();
    expect(m.invoke).toHaveBeenCalledOnce(); expect(m.remove).not.toHaveBeenCalled();
  });
  it('does not retire device notifications when recovering the already-active account', async () => {
    m.invoke.mockResolvedValueOnce({ data: { userId: 'old', accessToken: 'old-access', refreshToken: 'old-refresh', cleanupTicket: null }, error: null });
    await restoreAccount(key);
    expect(m.retirePush).not.toHaveBeenCalled();
    expect(current?.user.id).toBe('old');
  });
  it('rejects a friend code before session lookup or anonymous signup', async () => {
    await expect(restoreAccount('FRIEND12')).rejects.toThrow('not a friend code');
    expect(m.getSession).not.toHaveBeenCalled();
    expect(m.createClient).not.toHaveBeenCalled();
    expect(m.invoke).not.toHaveBeenCalled();
  });
  it('keeps main auth signed out until a verified recovery is installed', async () => {
    current = null;
    m.invoke.mockImplementation(async (_name, { body, headers }) => {
      if (body.action === 'recover') {
        expect(current).toBeNull();
        expect(headers.Authorization).toBe('Bearer bootstrap-access');
        expect(m.mainAnonymous).not.toHaveBeenCalled();
        return { data: { userId: 'target', accessToken: 'target-access', refreshToken: 'target-refresh', cleanupTicket: null }, error: null };
      }
      throw new Error('Unexpected edge action');
    });
    expect(await restoreAccount(key)).toEqual({ userId: 'target', previousKeyRevoked: true, keySaved: true });
    expect((current as ReturnType<typeof makeSession> | null)?.user.id).toBe('target');
    expect(m.createClient).toHaveBeenCalledWith('https://fixture.supabase.co', expect.any(String), {
      global: { fetch: expect.any(Function) }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    expect(m.setSession).toHaveBeenCalledTimes(1);
  });
  it('leaves the old account untouched on invalid-key responses', async () => {
    m.invoke.mockResolvedValue({ data: null, error: { context: new Response(null, { status: 400 }) } });
    await expect(restoreAccount(key)).rejects.toThrow('That login key could not be used');
    expect(current?.user.id).toBe('old');
    expect(m.setSession).not.toHaveBeenCalled();
    expect(m.signOut).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.retirePush).not.toHaveBeenCalled();
  });
  it('reuses a memory-only bootstrap across failed signed-out attempts and clears it after success', async () => {
    current = null;
    m.invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(null, { status: 400 }) } });
    m.invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(null, { status: 400 }) } });
    await expect(restoreAccount(key)).rejects.toThrow('could not be used');
    await expect(restoreAccount(key)).rejects.toThrow('could not be used');
    expect(m.createClient).toHaveBeenCalledTimes(1);
    expect(m.isolatedAnonymous).toHaveBeenCalledTimes(1);
    expect(m.mainAnonymous).not.toHaveBeenCalled();
    expect(current).toBeNull();
    await restoreAccount(key);
    expect(m.createClient).toHaveBeenCalledTimes(1);
    current = null;
    await restoreAccount(key);
    expect(m.createClient).toHaveBeenCalledTimes(2);
  });
  it('replaces an expired bootstrap before trying recovery', async () => {
    current = null;
    m.invoke.mockResolvedValueOnce({ data: null, error: { context: new Response(null, { status: 400 }) } });
    await expect(restoreAccount(key)).rejects.toThrow('could not be used');
    const later = Date.now() + 31 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try { await restoreAccount(key); } finally { clock.mockRestore(); }
    expect(m.createClient).toHaveBeenCalledTimes(2);
  });
  it('redacts thrown transport details instead of showing bearer/key payloads', async () => {
    m.invoke.mockRejectedValue(new Error(`Request body ${key} Authorization old-access`));
    await expect(restoreAccount(key)).rejects.toThrow('Account access is unavailable. Please try again.');
    expect(m.setSession).not.toHaveBeenCalled();
  });
  it('installs the recovered session before source-key cleanup and never deletes the old account', async () => {
    m.invoke.mockImplementation(async (_name, { body, headers }) => {
      if (body.action === 'recover') return { data: { userId: 'target', accessToken: 'target-access', refreshToken: 'target-refresh', cleanupTicket: ticket }, error: null };
      expect(body).toEqual({ action: 'finish', ticket });
      expect(current?.user.id).toBe('target');
      expect(headers.Authorization).toBe('Bearer target-access');
      return { data: { previousKeyRevoked: true }, error: null };
    });
    expect(await restoreAccount(key)).toEqual({ userId: 'target', previousKeyRevoked: true, keySaved: true });
    expect(m.remove).toHaveBeenCalledExactlyOnceWith('sumore_login_key_v1.old');
    expect(m.signOut).not.toHaveBeenCalled();
  });
  it('keeps successful recovery when optional source-key cleanup fails', async () => {
    m.invoke.mockResolvedValueOnce({ data: { userId: 'target', accessToken: 'target-access', refreshToken: 'target-refresh', cleanupTicket: ticket }, error: null });
    m.invoke.mockRejectedValueOnce(new Error('Offline cleanup'));
    expect(await restoreAccount(key)).toEqual({ userId: 'target', previousKeyRevoked: false, keySaved: true });
    expect(current?.user.id).toBe('target');
    expect(m.remove).not.toHaveBeenCalled();
  });
  it('warns when successful recovery cannot retain the entered key', async () => {
    m.save.mockRejectedValue(new Error('Keychain locked'));
    expect(await restoreAccount(key)).toEqual({ userId: 'target', previousKeyRevoked: true, keySaved: false });
    expect(current?.user.id).toBe('target');
  });
  it('publishes a nonsecret recovery notice after auth-driven component unmount', async () => {
    const listener = vi.fn();
    const stop = subscribeRecoveryNotice(listener);
    await restoreAccount(key);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getRecoveryNotice()).toEqual({ userId: 'target', warning: false, message: 'Account restored.' });
    stop();
    clearRecoveryNotice();
    expect(getRecoveryNotice()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('keeps separate storage/old-key warnings without exposing credentials', async () => {
    m.save.mockRejectedValue(new Error('Unavailable'));
    m.invoke.mockResolvedValueOnce({ data: { userId: 'target', accessToken: 'target-access', refreshToken: 'target-refresh', cleanupTicket: ticket }, error: null });
    m.invoke.mockResolvedValueOnce({ data: { previousKeyRevoked: false }, error: null });
    await restoreAccount(key);
    const notice = getRecoveryNotice();
    expect(notice?.warning).toBe(true);
    expect(notice?.message).toContain('could not keep a copy');
    expect(notice?.message).toContain('previous account’s login key may still work');
    expect(JSON.stringify(notice)).not.toContain(key);
    expect(JSON.stringify(notice)).not.toContain(ticket);
    expect(JSON.stringify(notice)).not.toContain('target-access');
  });
  it('does not overwrite an unrelated account selected during the edge request', async () => {
    m.invoke.mockImplementation(async () => {
      current = makeSession('unrelated');
      return { data: { userId: 'target', accessToken: 'target-access', refreshToken: 'target-refresh', cleanupTicket: ticket }, error: null };
    });
    await expect(restoreAccount(key)).rejects.toThrow('active account changed');
    expect(current?.user.id).toBe('unrelated');
    expect(m.setSession).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
  });
  it('restores the previous session after a failed session install, without cleanup', async () => {
    m.setSession.mockResolvedValueOnce({ data: { session: null }, error: { message: 'failed' } });
    await expect(restoreAccount(key)).rejects.toThrow('previous account was not deleted');
    expect(m.setSession).toHaveBeenLastCalledWith({ access_token: 'old-access', refresh_token: 'old-refresh' });
    expect(current?.user.id).toBe('old');
    expect(m.invoke).toHaveBeenCalledTimes(1);
    expect(m.remove).not.toHaveBeenCalled();
  });
  it('also protects the old session when Auth throws during installation', async () => {
    m.setSession.mockRejectedValueOnce(new Error('SDK detail with tokens'));
    await expect(restoreAccount(key)).rejects.toThrow('previous account was not deleted');
    expect(m.setSession).toHaveBeenLastCalledWith({ access_token: 'old-access', refresh_token: 'old-refresh' });
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([deleteAccount, createLoginKey, revokeLoginKey])('rejects an old account operation queued behind recovery', async operation => {
    const gate = Promise.withResolvers<{ data: unknown; error: null }>();
    m.invoke.mockImplementationOnce(() => gate.promise);
    const recovered = restoreAccount(key);
    await vi.waitFor(() => { expect(m.invoke).toHaveBeenCalledTimes(1); });
    const queued = operation();
    const rejected = expect(queued).rejects.toThrow('active account changed');
    await Promise.resolve();
    gate.resolve({ data: { userId: 'target', accessToken: 'target-access', refreshToken: 'target-refresh', cleanupTicket: null }, error: null });
    await recovered;
    await rejected;
    expect(current?.user.id).toBe('target');
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });
});

describe('confirmed owner-only deletion', () => {
  it('waits for actual server deletion then clears only the deleted owner locally', async () => {
    await deleteAccount();
    expect(m.invoke).toHaveBeenCalledExactlyOnceWith('account-access', { body: { action: 'delete' }, headers: { Authorization: 'Bearer old-access' } });
    expect(m.remove).toHaveBeenCalledExactlyOnceWith('sumore_login_key_v1.old');
    expect(m.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    expect(m.removePreference.mock.calls).toEqual([
      ['sumore:character:v1:old'], ['sumore:character:v2:old'], [appTourStorageKey('old')],
    ]);
  });
  it('keeps local login and private key when deletion was not confirmed', async () => {
    m.invoke.mockResolvedValue({ data: { deleted: false }, error: null });
    await expect(deleteAccount()).rejects.toThrow('unavailable');
    expect(m.signOut).not.toHaveBeenCalled();
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.removePreference).not.toHaveBeenCalled();
  });
  it('does not sign out a different user who became active during deletion', async () => {
    m.invoke.mockImplementation(async () => { current = makeSession('unrelated'); return { data: { deleted: true }, error: null }; });
    await deleteAccount();
    expect(m.signOut).not.toHaveBeenCalled();
    expect(m.remove).toHaveBeenCalledExactlyOnceWith('sumore_login_key_v1.old');
  });
});

describe('optional labels and daily total privacy', () => {
  it('canonicalizes labels, strips extra runtime fields, and leaves total-only labels null', () => {
    expect(validateSharedAppLabels([{ label: '  Game  ', minutes: 20, packageId: 'private' } as never], 30)).toEqual([{ label: 'Game', minutes: 20 }]);
    expect(validateSharedAppLabels(null, 0)).toBeNull();
    expect(validateSharedAppLabels([{ label: '🌙'.repeat(32), minutes: 1440 }], 1440)).toHaveLength(1);
  });
  it.each([
    [{ label: '', minutes: 1 }], [{ label: 'Game', minutes: 0 }], [{ label: 'Game', minutes: 1441 }],
    [{ label: 'Game', minutes: 1.2 }], [{ label: 'Game\nprivate', minutes: 5 }], [{ label: 'x'.repeat(33), minutes: 5 }],
    Array(51).fill({ label: 'Game', minutes: 5 }),
  ])('rejects invalid labels and allocations', (...entries) => {
    expect(() => validateSharedAppLabels(entries as { label: string; minutes: number }[])).toThrow();
  });
  it('rejects totals smaller than disclosed labels or noninteger limits', () => {
    expect(() => validateSharedAppLabels([{ label: 'Game', minutes: 20 }], 10)).toThrow();
    for (const total of [-1, 1.5, 72001, NaN, Infinity]) expect(() => validateSharedAppLabels(null, total)).toThrow();
  });
  it('pins expected owner in SQL as well as checking locally', async () => {
    m.rpc.mockResolvedValue({ data: { userId: 'old', apps: null, totalDailyMinutes: 30, updatedAt: '2026-09-22T00:00:00Z' }, error: null });
    expect((await setSharedAppLimits(null, 30))?.totalDailyMinutes).toBe(30);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith('set_shared_app_limits', { entries: null, allocation_minutes: 30, expected_user_id: 'old' });
  });
  it('rejects a stale native owner before any mutation', async () => {
    await expect(setSharedAppLimits(null, 30, 'previous')).rejects.toThrow('active account changed');
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('updates a native total without sending stale app labels', async () => {
    m.rpc.mockResolvedValue({ data: { userId: 'old', apps: [{ label: 'Latest', minutes: 10 }], totalDailyMinutes: 30, updatedAt: '2026-09-22T00:00:00Z' }, error: null });
    expect((await setSharedDailyTotal(30, 'old')).apps).toEqual([{ label: 'Latest', minutes: 10 }]);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith('set_shared_daily_total', { allocation_minutes: 30, expected_user_id: 'old' });
    await expect(setSharedDailyTotal(40, 'previous')).rejects.toThrow('active account changed');
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects a response that arrived after account replacement', async () => {
    m.rpc.mockImplementation(async () => { current = makeSession('unrelated'); return { data: null, error: null }; });
    await expect(setSharedAppLimits(null, 30, 'old')).rejects.toThrow('active account changed');
  });
  it('gets only server-authorized circle allocation records and validates response content', async () => {
    const row = { userId: 'peer', apps: [{ label: 'Game', minutes: 15 }], totalDailyMinutes: 30, updatedAt: '2026-09-22T00:00:00Z' };
    m.rpc.mockResolvedValue({ data: [row], error: null });
    expect(await getCircleAppLimits()).toEqual([row]);
    expect(m.rpc).toHaveBeenCalledExactlyOnceWith('get_circle_app_limits');
    m.rpc.mockResolvedValue({ data: [{ ...row, apps: [{ label: 'Game', minutes: 99 }] }], error: null });
    await expect(getCircleAppLimits()).rejects.toThrow();
  });
});
