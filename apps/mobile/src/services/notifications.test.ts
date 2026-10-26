import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  os: 'android', device: true, project: 'fixture-project', build: 20, expoGo: false,
  owner: 'owner', stored: null as string | null,
  permission: vi.fn(), request: vi.fn(), channel: vi.fn(), token: vi.fn(), schedule: vi.fn(), handler: vi.fn(),
  get: vi.fn(), set: vi.fn(), remove: vi.fn(), session: vi.fn(), row: vi.fn(), eq: vi.fn(), save: vi.fn(),
}));
vi.mock('react-native', () => ({ Platform: { get OS() { return h.os; } } }));
vi.mock('expo-constants', () => ({ default: {
  get appOwnership() { return h.expoGo ? 'expo' : null; },
  get expoConfig() { return { extra: { eas: { projectId: h.project } } }; },
  // SDK 57 expo-constants does not supply Android versionCode.
  platform: { android: {} },
} }));
vi.mock('expo-device', () => ({ get isDevice() { return h.device; } }));
vi.mock('expo-application', () => ({ get nativeBuildVersion() { return String(h.build); } }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('expo-notifications', () => ({
  setNotificationHandler: h.handler, getPermissionsAsync: h.permission, requestPermissionsAsync: h.request,
  setNotificationChannelAsync: h.channel, getExpoPushTokenAsync: h.token, scheduleNotificationAsync: h.schedule,
  AndroidImportance: { HIGH: 4 }, SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: h.get, setItemAsync: h.set, deleteItemAsync: h.remove, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' }));
vi.mock('@/services/supabase-backend', () => ({ upsertPushToken: h.save }));
vi.mock('@/lib/supabase', () => ({ requireSupabase: () => ({
  auth: { getSession: h.session }, from: () => ({ select: () => {
    const query = { eq: (...args: unknown[]) => { h.eq(...args); return query; }, maybeSingle: h.row };
    return query;
  } }),
}) }));

let service: typeof import('./notifications');
const receipt = (extra = {}) => JSON.stringify({ ownerId: 'owner', projectId: 'fixture-project', buildId: 'android:20', token: 'ExpoPushToken[fixture]', ...extra });
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  h.os = 'android'; h.device = true; h.project = 'fixture-project'; h.build = 20; h.expoGo = false; h.owner = 'owner'; h.stored = null;
  h.permission.mockReset().mockResolvedValue({ status: 'granted' });
  h.request.mockReset().mockResolvedValue({ status: 'granted' });
  h.channel.mockReset().mockResolvedValue(undefined);
  h.token.mockReset().mockResolvedValue({ data: 'ExpoPushToken[fixture]' });
  h.schedule.mockReset().mockResolvedValue('scheduled');
  h.get.mockReset().mockImplementation(async () => h.stored);
  h.set.mockReset().mockImplementation(async (_: string, value: string) => { h.stored = value; });
  h.remove.mockReset().mockImplementation(async () => { h.stored = null; });
  h.session.mockReset().mockImplementation(async () => ({ data: { session: { user: { id: h.owner } } }, error: null }));
  h.row.mockReset().mockResolvedValue({ data: { user_id: 'owner', disabled_at: null }, error: null });
  h.save.mockReset().mockResolvedValue(undefined);
  service = await import('./notifications');
});
afterEach(() => { vi.useRealTimers(); });

describe('notification registration, not permission-only readiness', () => {
  it('does not register tokens, create channels, query the backend or prompt just to render Settings', async () => {
    expect(await service.getNotificationReadiness('owner')).toBe('permission-granted');
    for (const api of [h.token, h.channel, h.request, h.row, h.save]) expect(api).not.toHaveBeenCalled();
    expect(service.notificationStatusLabel('permission-granted')).toContain('Not connected');
  });
  it.each(['denied', 'undetermined'])('reports %s permission without using a previous saved receipt', async permission => {
    h.stored = receipt(); h.permission.mockResolvedValue({ status: permission });
    expect(await service.getNotificationReadiness('owner')).toBe(permission === 'denied' ? 'denied' : 'available');
    expect(h.row).not.toHaveBeenCalled();
  });
  it('requires the configured project, a physical phone and an installed native app', async () => {
    h.project = ''; expect(await service.getNotificationReadiness('owner')).toBe('needs-update');
    h.device = false; expect(await service.getNotificationReadiness('owner')).toBe('needs-development-build');
    h.device = true; h.os = 'web'; expect(await service.getNotificationReadiness('owner')).toBe('needs-development-build');
    expect(h.token).not.toHaveBeenCalled();
  });
  it('verifies the saved receipt against the exact enabled backend row without native registration', async () => {
    h.stored = receipt();
    expect(await service.getNotificationReadiness('owner')).toBe('registered');
    expect(h.eq.mock.calls).toEqual([['user_id', 'owner'], ['token', 'ExpoPushToken[fixture]']]);
    expect(h.token).not.toHaveBeenCalled();
  });
  it('does not reuse a prior installed binary receipt after an Android update', async () => {
    h.stored = receipt(); h.build = 21;
    expect(await service.getNotificationReadiness('owner')).toBe('permission-granted'); expect(h.row).not.toHaveBeenCalled();
  });
  it.each([{ ownerId: 'other' }, { projectId: 'other' }, { buildId: 'android:19' }, { token: 'invalid' }])('rejects a mismatched receipt %o', async extra => {
    h.stored = receipt(extra);
    expect(await service.getNotificationReadiness('owner')).toBe('permission-granted');
    expect(h.row).not.toHaveBeenCalled();
  });
  it.each([null, { user_id: 'owner', disabled_at: '2026-10-01' }, { user_id: 'other', disabled_at: null }])('does not claim registration for unavailable backend row %o', async data => {
    h.stored = receipt(); h.row.mockResolvedValue({ data, error: null });
    expect(await service.getNotificationReadiness('owner')).toBe('permission-granted');
  });
  it('does not call an offline/failed row verification registered', async () => {
    h.stored = receipt(); h.row.mockResolvedValue({ data: null, error: { message: 'secret details' } });
    expect(await service.getNotificationReadiness('owner')).toBe('unknown');
  });
  it.each(['android', 'ios'])('registers and persists only after successful backend save on %s', async platform => {
    h.os = platform;
    const save = Promise.withResolvers<void>(); h.save.mockReturnValue(save.promise);
    const pending = service.registerForPushNotifications('owner');
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(h.stored).toBeNull();
    expect(h.save).toHaveBeenCalledWith('ExpoPushToken[fixture]', platform, 'owner', expect.any(Function));
    save.resolve(); await pending;
    expect(JSON.parse(h.stored!)).toMatchObject({ ownerId: 'owner', buildId: `${platform}:20` });
    expect(h.set.mock.calls[0][2]).toEqual({ keychainAccessible: 'device-only' });
    expect(h.channel).toHaveBeenCalledTimes(platform === 'android' ? 1 : 0);
  });
  it('retains token ownership for retirement when re-enabling fails, and allows retry', async () => {
    h.stored = receipt(); h.save.mockRejectedValueOnce(new Error('database secret'));
    await expect(service.registerForPushNotifications('owner')).rejects.toThrow();
    expect(h.stored).toBe(receipt());
    h.row.mockResolvedValueOnce({ data: { user_id: 'owner', disabled_at: '2026-10-01' }, error: null });
    expect(await service.getNotificationReadiness('owner')).toBe('permission-granted');
    await service.registerForPushNotifications('owner');
    expect(await service.getNotificationReadiness('owner')).toBe('registered');
  });
  it('coalesces duplicate Enable taps and refuses another account while one is in flight', async () => {
    const native = Promise.withResolvers<{ data: string }>(); h.token.mockReturnValue(native.promise);
    const first = service.registerForPushNotifications('owner');
    expect(service.registerForPushNotifications('owner')).toBe(first);
    await expect(service.registerForPushNotifications('other')).rejects.toThrow('Another registration');
    native.resolve({ data: 'ExpoPushToken[fixture]' }); await first;
    expect(h.token).toHaveBeenCalledOnce(); expect(h.save).toHaveBeenCalledOnce();
  });
  it.each(['account', 'lifecycle'])('cannot save a token after %s changes while native registration is pending', async change => {
    let current = true;
    const native = Promise.withResolvers<{ data: string }>(); h.token.mockReturnValue(native.promise);
    const pending = service.registerForPushNotifications('owner', () => current);
    await vi.waitFor(() => expect(h.token).toHaveBeenCalledOnce());
    if (change === 'account') h.owner = 'other'; else current = false;
    native.resolve({ data: 'ExpoPushToken[fixture]' });
    await expect(pending).rejects.toThrow();
    expect(h.save).not.toHaveBeenCalled(); expect(h.set).not.toHaveBeenCalled();
  });
  it('times out without late backend writes and releases the retry guard', async () => {
    vi.useFakeTimers(); const native = Promise.withResolvers<{ data: string }>(); h.token.mockReturnValueOnce(native.promise);
    const pending = service.registerForPushNotifications('owner');
    const result = expect(pending).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(25_000); await result;
    native.resolve({ data: 'ExpoPushToken[late]' }); await vi.advanceTimersByTimeAsync(0);
    expect(h.save).not.toHaveBeenCalled();
    await service.registerForPushNotifications('owner'); expect(h.save).toHaveBeenCalledOnce();
  });
  it.each(['Default FirebaseApp is not initialized. PRIVATE/path?secret=123', 'FCM invalid sender SECRET', 'No aps-environment entitlement SECRET'])('replaces configuration failures without leaking their payload: %s', async raw => {
    h.token.mockRejectedValue(new Error(raw));
    const error = await service.registerForPushNotifications('owner').catch(value => value);
    expect(service.notificationErrorMessage(error)).toContain('app update');
    expect(service.notificationErrorMessage(error)).not.toMatch(/PRIVATE|SECRET|123/);
    expect(service.notificationErrorReadiness(error)).toBe('needs-update');
    expect(h.save).not.toHaveBeenCalled(); expect(h.set).not.toHaveBeenCalled();
  });
  it('keeps permission denial distinct from configuration errors', async () => {
    h.permission.mockResolvedValue({ status: 'denied' }); h.request.mockResolvedValue({ status: 'denied' });
    const error = await service.registerForPushNotifications('owner').catch(value => value);
    expect(service.notificationErrorReadiness(error)).toBe('denied');
    expect(h.token).not.toHaveBeenCalled();
  });
  it('schedules a clearly local device test without registering or changing the push receipt', async () => {
    await service.scheduleNotificationPreview();
    expect(h.schedule.mock.calls[0][0].content).toMatchObject({ title: 'sumore device test', body: expect.stringContaining('not friend notification delivery') });
    expect(h.token).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled(); expect(h.set).not.toHaveBeenCalled();
    expect(await service.getNotificationReadiness('owner')).toBe('permission-granted');
  });
  it('does not schedule a local test after leaving the screen during a permission request', async () => {
    let current = true; h.permission.mockResolvedValue({ status: 'undetermined' });
    const permission = Promise.withResolvers<{ status: string }>(); h.request.mockReturnValue(permission.promise);
    const pending = service.scheduleNotificationPreview(() => current);
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
    current = false; permission.resolve({ status: 'granted' }); await pending;
    expect(h.schedule).not.toHaveBeenCalled();
  });
  it.each(['registration', 'local'])('does not prompt after cancellation during the %s permission read', async kind => {
    let current = true;
    const permission = Promise.withResolvers<{ status: string }>(); h.permission.mockReturnValue(permission.promise);
    const pending = kind === 'registration' ? service.registerForPushNotifications('owner', () => current) : service.scheduleNotificationPreview(() => current);
    const settled = pending.catch(() => undefined);
    await vi.waitFor(() => expect(h.permission).toHaveBeenCalledOnce());
    current = false; permission.resolve({ status: 'undetermined' }); await settled;
    expect(h.request).not.toHaveBeenCalled(); expect(h.token).not.toHaveBeenCalled(); expect(h.schedule).not.toHaveBeenCalled();
  });
});
