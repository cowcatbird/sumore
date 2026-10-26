import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppSnapshot } from '@/types/domain';

import { ACCOUNT_LOAD_TIMEOUT_MS, createProfileLoader, withAccountTimeout } from './profile-loader';

function profile(id: string, displayName = 'Alex'): AppSnapshot {
  return {
    profile: { id, displayName, friendCode: `${id}-CODE`, initials: 'A' },
    friends: [], incomingRequests: [], outgoingRequest: null, recentDecision: null,
    groupPolicy: { title: '', body: '' }, campfire: { localDate: '', seats: [], groupGolden: 0 },
  };
}

function setup() {
  const load = vi.fn<() => Promise<AppSnapshot>>();
  const onSnapshot = vi.fn();
  const onLoading = vi.fn();
  return { load, onSnapshot, onLoading, loader: createProfileLoader({ load, onSnapshot, onLoading }) };
}

afterEach(() => vi.useRealTimers());

describe('account profile loading', () => {
  it('does not emit loading or snapshot updates for unchanged background polls', async () => {
    const { loader, load, onSnapshot, onLoading } = setup();
    load.mockImplementation(async () => profile('caleb'));
    loader.setUser('caleb');
    await loader.refresh();
    onLoading.mockClear();
    for (let poll = 0; poll < 6; poll++) await loader.refresh();
    expect(load).toHaveBeenCalledTimes(7); // Server truth is still checked.
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onLoading).not.toHaveBeenCalled();
  });

  it('still delivers changed data and resets comparison on account switch', async () => {
    const { loader, load, onSnapshot } = setup();
    load.mockResolvedValueOnce(profile('caleb')).mockResolvedValueOnce(profile('caleb', 'New name'))
      .mockResolvedValueOnce(profile('other')).mockResolvedValueOnce(profile('caleb', 'New name'));
    loader.setUser('caleb');
    await loader.refresh(); await loader.refresh();
    loader.setUser('other'); await loader.refresh();
    loader.setUser('caleb'); await loader.refresh();
    expect(onSnapshot).toHaveBeenCalledTimes(4);
    expect(onSnapshot).toHaveBeenLastCalledWith(profile('caleb', 'New name'));
  });

  it('preserves explicit loading feedback after a saved edit', async () => {
    const { loader, load, onLoading } = setup();
    load.mockResolvedValue(profile('caleb'));
    loader.setUser('caleb'); await loader.refresh();
    onLoading.mockClear();
    await loader.refresh(true);
    expect(onLoading.mock.calls).toEqual([[true], [false]]);
  });

  it('coalesces signup, realtime, and foreground reads for the same account', async () => {
    const { loader, load, onSnapshot, onLoading } = setup();
    const deferred = Promise.withResolvers<AppSnapshot>();
    load.mockReturnValue(deferred.promise);
    loader.setUser('caleb');
    const reads = [loader.refresh(), loader.refresh(), loader.refresh()];
    await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(1);
    deferred.resolve(profile('caleb'));
    await Promise.all(reads);
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(profile('caleb'));
    expect(onLoading).toHaveBeenLastCalledWith(false);
  });

  it('waits out a pre-save read then downloads the saved name', async () => {
    const { loader, load, onSnapshot } = setup();
    const deferred = Promise.withResolvers<AppSnapshot>();
    load.mockReturnValueOnce(deferred.promise).mockResolvedValueOnce(profile('caleb', 'New name'));
    loader.setUser('caleb');
    const background = loader.refresh();
    const afterSave = loader.refresh(true);
    deferred.resolve(profile('caleb', ''));
    await Promise.all([background, afterSave]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onSnapshot).toHaveBeenLastCalledWith(profile('caleb', 'New name'));
  });

  it('does not return an old account or its error after switching identities', async () => {
    const { loader, load, onSnapshot } = setup();
    const oldRead = Promise.withResolvers<AppSnapshot>();
    load.mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(profile('other'));
    loader.setUser('caleb');
    const previous = loader.refresh();
    await Promise.resolve();
    loader.setUser('other');
    await loader.refresh();
    oldRead.resolve(profile('caleb'));
    await previous;
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(profile('other'));
  });

  it('discards in-flight profile data on sign out', async () => {
    const { loader, load, onSnapshot, onLoading } = setup();
    const deferred = Promise.withResolvers<AppSnapshot>();
    load.mockReturnValue(deferred.promise);
    loader.setUser('caleb');
    const reading = loader.refresh();
    loader.setUser(null);
    deferred.resolve(profile('caleb'));
    await reading;
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onLoading).toHaveBeenLastCalledWith(false);
  });

  it('rejects another account’s profile without displaying it', async () => {
    const { loader, load, onSnapshot } = setup();
    load.mockResolvedValue(profile('someone-else'));
    loader.setUser('caleb');
    await expect(loader.refresh()).rejects.toThrow('verify this profile');
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('surfaces failed loads and allows Retry without resetting the account', async () => {
    const { loader, load, onSnapshot, onLoading } = setup();
    load.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(profile('caleb'));
    loader.setUser('caleb');
    await expect(loader.refresh()).rejects.toThrow('Offline');
    expect(onLoading).toHaveBeenLastCalledWith(false);
    await loader.refresh();
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(profile('caleb'));
  });

  it('times out hung reads and ignores their late response after a successful retry', async () => {
    vi.useFakeTimers();
    const { loader, load, onSnapshot, onLoading } = setup();
    const deferred = Promise.withResolvers<AppSnapshot>();
    load.mockReturnValueOnce(deferred.promise).mockResolvedValueOnce(profile('caleb', 'New name'));
    loader.setUser('caleb');
    const reading = loader.refresh();
    const rejected = expect(reading).rejects.toThrow('tap Retry');
    await vi.advanceTimersByTimeAsync(ACCOUNT_LOAD_TIMEOUT_MS);
    await rejected;
    expect(onLoading).toHaveBeenLastCalledWith(false);
    await loader.refresh();
    deferred.resolve(profile('caleb', 'Old name'));
    await Promise.resolve();
    expect(onSnapshot).toHaveBeenCalledExactlyOnceWith(profile('caleb', 'New name'));
  });

  it('keeps the existing account when the session restore times out', async () => {
    vi.useFakeTimers();
    const deferred = Promise.withResolvers<null>();
    const restore = withAccountTimeout(deferred.promise, 'Restore took too long. Retry.');
    const rejected = expect(restore).rejects.toThrow('Restore took too long');
    await vi.advanceTimersByTimeAsync(ACCOUNT_LOAD_TIMEOUT_MS);
    await rejected;
  });
});
