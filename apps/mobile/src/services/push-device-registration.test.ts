import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { id: string; user_id: string; token: string; disabled_at: string | null };
type Filters = Record<string, string>;
const h = vi.hoisted(() => ({ owner: 'owner' as string | null, storage: new Map<string, string>(), rows: new Map<string, Row>(),
  read: vi.fn(), save: vi.fn(), remove: vi.fn(), session: vi.fn(), identity: vi.fn(),
  stage: vi.fn(), activate: vi.fn(), retire: vi.fn(), sequence: 0,
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: h.read, setItemAsync: h.save, deleteItemAsync: h.remove, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' }));
vi.mock('@/lib/supabase', () => ({ requireSupabase: () => ({
  auth: { getSession: h.session, getUser: h.identity },
  from: (table: string) => {
    if (table !== 'device_push_tokens') throw new Error('Unexpected table');
    return {
      upsert: (value: Row, options: unknown) => ({ select: () => ({ single: () => h.stage(value, options) }) }),
      update: (value: Partial<Row>) => {
        const filters: Filters = {};
        const query = { eq: (key: string, val: string) => { filters[key] = val; return query; }, select: () => query,
          maybeSingle: () => h.activate(value, filters) };
        return query;
      },
      delete: () => {
        const filters: Filters = {};
        const query = { eq: (key: string, val: string) => { filters[key] = val; return query; },
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => h.retire(filters).then(resolve, reject) };
        return query;
      },
    };
  },
}) }));

const receiptKey = 'sumore_push_registration_v1';
const journalKey = 'sumore_push_device_tokens_v1';
const token = 'ExpoPushToken[this-device]';
const receipt = { ownerId: 'owner', token, projectId: 'project', buildId: 'android:18' };
let service: typeof import('./push-device-registration');
const matches = (row: Row, filters: Filters) => Object.entries(filters).every(([key, value]) => row[key as keyof Row] === value);
function stage(value: Row) {
  const row = { ...value, id: h.rows.get(value.token)?.id ?? `row-${++h.sequence}` };
  h.rows.set(value.token, row);
  return { data: { id: row.id }, error: null };
}
function activate(value: Partial<Row>, filters: Filters) {
  const row = [...h.rows.values()].find(item => matches(item, filters));
  if (row) Object.assign(row, value);
  return { data: row ? { id: row.id } : null, error: null };
}
function knownDevice() {
  h.storage.set(receiptKey, JSON.stringify(receipt));
  h.rows.set(token, { id: 'existing', token, user_id: 'owner', disabled_at: null });
}
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); h.storage.clear(); h.rows.clear(); h.owner = 'owner'; h.sequence = 0;
  h.read.mockReset().mockImplementation(async key => h.storage.get(key) ?? null);
  h.save.mockReset().mockImplementation(async (key, value) => { h.storage.set(key, value); });
  h.remove.mockReset().mockImplementation(async key => { h.storage.delete(key); });
  h.session.mockReset().mockImplementation(async () => ({ data: { session: h.owner ? { user: { id: h.owner } } : null }, error: null }));
  h.identity.mockReset().mockImplementation(async () => ({ data: { user: h.owner ? { id: h.owner } : null }, error: null }));
  h.stage.mockReset().mockImplementation(async value => stage(value));
  h.activate.mockReset().mockImplementation(async (value, filters) => activate(value, filters));
  h.retire.mockReset().mockImplementation(async filters => {
    for (const [key, row] of h.rows) if (matches(row, filters)) h.rows.delete(key);
    return { error: null };
  });
  service = await import('./push-device-registration');
});

describe('device-only push token ownership', () => {
  it('journals before disabled staging, then activates only the returned row id', async () => {
    h.stage.mockImplementationOnce(async value => {
      expect(JSON.parse(h.storage.get(journalKey)!)).toEqual([{ ownerId: 'owner', token, uncertainStage: true }]);
      expect(value.disabled_at).toEqual(expect.any(String));
      return stage(value);
    });
    await service.persistDevicePushToken(token, 'android', 'owner', () => true);
    expect(h.stage).toHaveBeenCalledWith(expect.objectContaining({ token, user_id: 'owner', disabled_at: expect.any(String) }), { onConflict: 'token' });
    expect(h.activate).toHaveBeenCalledWith(expect.objectContaining({ disabled_at: null }), { id: 'row-1', user_id: 'owner', token });
    expect(h.rows.get(token)?.disabled_at).toBeNull();
    expect(h.storage.has(receiptKey)).toBe(false);
  });
  it.each([null, 'different'])('does not save for a different or missing account (%s)', async owner => {
    h.owner = owner;
    await expect(service.persistDevicePushToken(token, 'ios', 'owner', () => true)).rejects.toThrow('active account changed');
    expect(h.stage).not.toHaveBeenCalled();
  });
  it('rejects failed identity verification even if the response includes a user', async () => {
    h.identity.mockResolvedValue({ data: { user: { id: 'owner' } }, error: { message: 'expired' } });
    await expect(service.persistDevicePushToken(token, 'ios', 'owner', () => true)).rejects.toThrow();
    expect(h.stage).not.toHaveBeenCalled();
  });
  it('rechecks cancellation after identity verification', async () => {
    let current = true; const identity = Promise.withResolvers<unknown>(); h.identity.mockReturnValueOnce(identity.promise);
    const pending = service.persistDevicePushToken(token, 'android', 'owner', () => current);
    await vi.waitFor(() => expect(h.identity).toHaveBeenCalledOnce());
    current = false; identity.resolve({ data: { user: { id: 'owner' } }, error: null });
    await expect(pending).rejects.toThrow(); expect(h.stage).not.toHaveBeenCalled();
  });
  it('does not write a backend token if its durable journal cannot be saved', async () => {
    h.save.mockRejectedValue(new Error('Keychain unavailable'));
    await expect(service.persistDevicePushToken(token, 'android', 'owner', () => true)).rejects.toThrow();
    expect(h.stage).not.toHaveBeenCalled(); expect(h.activate).not.toHaveBeenCalled();
  });
  it('retains token knowledge after a failed stage or activation, even without a success receipt', async () => {
    h.stage.mockRejectedValueOnce(new Error('timed out'));
    await expect(service.persistDevicePushToken(token, 'ios', 'owner', () => true)).rejects.toThrow();
    expect(JSON.parse(h.storage.get(journalKey)!)).toEqual([{ ownerId: 'owner', token, uncertainStage: true }]);
    await service.withRetiredDevicePush('owner', async () => { h.owner = null; });
    expect(h.retire).toHaveBeenCalledWith({ user_id: 'owner', token });
    expect(JSON.parse(h.storage.get(journalKey)!)).toEqual([{ ownerId: 'owner', token, uncertainStage: true }]);
  });
  it('retires only this device’s exact owner/token, including an older-build v1 receipt', async () => {
    knownDevice();
    h.rows.set('ExpoPushToken[other-device]', { id: 'other-device', token: 'ExpoPushToken[other-device]', user_id: 'owner', disabled_at: null });
    h.rows.set('ExpoPushToken[other-owner]', { id: 'other-owner', token: 'ExpoPushToken[other-owner]', user_id: 'other', disabled_at: null });
    h.storage.set(journalKey, JSON.stringify([{ ownerId: 'other', token: 'ExpoPushToken[other-owner]' }]));
    await service.withRetiredDevicePush('owner', async () => {
      expect(h.rows.has(token)).toBe(false); expect(h.storage.has(receiptKey)).toBe(false); h.owner = null;
    });
    expect(h.retire).toHaveBeenCalledExactlyOnceWith({ user_id: 'owner', token });
    expect(h.rows.size).toBe(2);
    expect(JSON.parse(h.storage.get(journalKey)!)).toEqual([{ ownerId: 'other', token: 'ExpoPushToken[other-owner]' }]);
  });
  it('retains and retires both device tokens when a successful re-enable rotates the token', async () => {
    knownDevice(); const nextToken = 'ExpoPushToken[rotated]';
    await service.persistDevicePushToken(nextToken, 'android', 'owner', () => true);
    await service.saveDevicePushReceipt({ ...receipt, token: nextToken }, () => true);
    expect(JSON.parse(h.storage.get(journalKey)!)).toEqual([{ ownerId: 'owner', token }, { ownerId: 'owner', token: nextToken }]);
    await service.withRetiredDevicePush('owner', async () => { h.owner = null; });
    expect(h.rows.size).toBe(0);
    expect(h.retire.mock.calls).toEqual([[{ user_id: 'owner', token }], [{ user_id: 'owner', token: nextToken }]]);
  });
  it('keeps the account and durable token knowledge when exact retirement fails', async () => {
    knownDevice(); h.retire.mockResolvedValueOnce({ error: { message: 'private server details' } });
    const changeAccount = vi.fn();
    await expect(service.withRetiredDevicePush('owner', changeAccount)).rejects.toThrow('Could not safely disconnect');
    expect(changeAccount).not.toHaveBeenCalled(); expect(h.owner).toBe('owner');
    expect(h.storage.get(receiptKey)).toBe(JSON.stringify(receipt)); expect(h.rows.has(token)).toBe(true);
  });
  it('does not retire another owner’s receipt or invent a token for legacy clients', async () => {
    h.storage.set(receiptKey, JSON.stringify({ ...receipt, ownerId: 'other' }));
    await service.withRetiredDevicePush('owner', async () => { h.owner = null; });
    expect(h.retire).not.toHaveBeenCalled(); expect(h.storage.has(receiptKey)).toBe(true);
    h.owner = 'owner'; h.storage.clear();
    await service.withRetiredDevicePush('owner', async () => undefined);
    expect(h.retire).not.toHaveBeenCalled(); expect(h.stage).not.toHaveBeenCalled();
  });
  it('invalidates native registration immediately, and keeps the gate through auth replacement', async () => {
    const current = service.captureDevicePushRegistration(() => true);
    const auth = Promise.withResolvers<void>();
    const transition = service.withRetiredDevicePush('owner', () => auth.promise);
    expect(current()).toBe(false);
    const duringTransition = service.captureDevicePushRegistration(() => true);
    expect(duringTransition()).toBe(false);
    const save = service.persistDevicePushToken(token, 'android', 'owner', duringTransition);
    const failed = expect(save).rejects.toThrow();
    auth.resolve(); await transition; await failed;
    expect(h.stage).not.toHaveBeenCalled();
  });
  it('waits for an in-flight stage, then retires it before auth changes without activating it', async () => {
    const deferred = Promise.withResolvers<unknown>(); h.stage.mockReturnValueOnce(deferred.promise);
    const pending = service.persistDevicePushToken(token, 'android', 'owner', () => true);
    const failed = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(h.stage).toHaveBeenCalledOnce());
    const changeAccount = vi.fn(async () => { h.owner = 'other'; });
    const transition = service.withRetiredDevicePush('owner', changeAccount);
    expect(changeAccount).not.toHaveBeenCalled();
    deferred.resolve(stage(h.stage.mock.calls[0][0]));
    await failed; await transition;
    expect(h.activate).not.toHaveBeenCalled(); expect(h.rows.has(token)).toBe(false);
    expect(changeAccount).toHaveBeenCalledOnce();
  });
  it('retires an activation that completes while auth replacement is waiting', async () => {
    const deferred = Promise.withResolvers<unknown>(); h.activate.mockReturnValueOnce(deferred.promise);
    const pending = service.persistDevicePushToken(token, 'android', 'owner', () => true);
    const failed = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(h.activate).toHaveBeenCalledOnce());
    const transition = service.withRetiredDevicePush('owner', async () => { h.owner = 'other'; });
    deferred.resolve(activate(...h.activate.mock.calls[0] as [Partial<Row>, Filters]));
    await failed; await transition;
    expect(h.rows.has(token)).toBe(false);
    await service.persistDevicePushToken(token, 'android', 'other', () => true);
    expect(h.rows.get(token)?.user_id).toBe('other');
  });
  it('a timed-out activation cannot resurrect or change a replacement account’s token row', async () => {
    h.activate.mockRejectedValueOnce(new Error('network timeout'));
    await expect(service.persistDevicePushToken(token, 'android', 'owner', () => true)).rejects.toThrow();
    const [lateValues, lateFilters] = h.activate.mock.calls[0] as [Partial<Row>, Filters];
    await service.withRetiredDevicePush('owner', async () => { h.owner = 'other'; });
    expect(activate(lateValues, lateFilters).data).toBeNull();
    await service.persistDevicePushToken(token, 'android', 'other', () => true);
    expect(activate(lateValues, lateFilters).data).toBeNull();
    expect(h.rows.get(token)).toMatchObject({ user_id: 'other', disabled_at: null });
  });
  it('a late timed-out stage stays disabled and cannot send after the account changed', async () => {
    h.stage.mockRejectedValueOnce(new Error('network timeout'));
    await expect(service.persistDevicePushToken(token, 'android', 'owner', () => true)).rejects.toThrow();
    const lateValues = h.stage.mock.calls[0][0];
    await service.withRetiredDevicePush('owner', async () => { h.owner = 'other'; });
    stage(lateValues);
    expect(h.rows.get(token)?.disabled_at).toEqual(expect.any(String));
    expect(h.activate).not.toHaveBeenCalled();
    expect(JSON.parse(h.storage.get(journalKey)!)).toEqual([{ ownerId: 'owner', token, uncertainStage: true }]);
    h.owner = 'owner';
    await service.withRetiredDevicePush('owner', async () => { h.owner = null; });
    expect(h.rows.has(token)).toBe(false);
  });
  it('keeps earlier staging uncertainty even when a later registration succeeds', async () => {
    h.stage.mockRejectedValueOnce(new Error('network timeout'));
    await expect(service.persistDevicePushToken(token, 'android', 'owner', () => true)).rejects.toThrow();
    await service.persistDevicePushToken(token, 'android', 'owner', () => true);
    expect(h.rows.get(token)?.disabled_at).toBeNull();
    await service.withRetiredDevicePush('owner', async () => { h.owner = null; });
    expect(h.rows.has(token)).toBe(false);
    expect(JSON.parse(h.storage.get(journalKey)!)).toEqual([{ ownerId: 'owner', token, uncertainStage: true }]);
  });
  it('a delayed receipt write finishes before retirement and never leaks across the auth change', async () => {
    knownDevice(); const saved = Promise.withResolvers<void>();
    h.save.mockImplementationOnce(async (key, value) => { await saved.promise; h.storage.set(key, value); });
    const current = service.captureDevicePushRegistration(() => true);
    const pending = service.saveDevicePushReceipt(receipt, current);
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    const transition = service.withRetiredDevicePush('owner', async () => { h.owner = 'other'; });
    saved.resolve(); await pending; await transition;
    expect(h.storage.has(receiptKey)).toBe(false); expect(h.rows.has(token)).toBe(false);
    await expect(service.saveDevicePushReceipt(receipt, current)).rejects.toThrow();
  });
  it('fails closed on corrupt known-token storage without attempting a broad deletion', async () => {
    knownDevice(); h.storage.set(journalKey, '{bad'); const action = vi.fn();
    await expect(service.withRetiredDevicePush('owner', action)).rejects.toThrow('Could not safely disconnect');
    expect(h.retire).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
  });
});
