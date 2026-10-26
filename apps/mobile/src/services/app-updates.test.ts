import { afterEach, describe, expect, it, vi } from 'vitest';

import { downloadAppUpdate } from './app-updates';

describe('manual app updates', () => {
  afterEach(() => vi.useRealTimers());

  it('does not download when the installed revision is current', async () => {
    const client = { checkForUpdateAsync: vi.fn().mockResolvedValue({ isAvailable: false }), fetchUpdateAsync: vi.fn() };
    await expect(downloadAppUpdate(client)).resolves.toBe('current');
    expect(client.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it('downloads a compatible update without automatically restarting or touching auth', async () => {
    const client = { checkForUpdateAsync: vi.fn().mockResolvedValue({ isAvailable: true }), fetchUpdateAsync: vi.fn().mockResolvedValue({ isNew: true }) };
    await expect(downloadAppUpdate(client)).resolves.toBe('ready');
    expect(client.fetchUpdateAsync).toHaveBeenCalledTimes(1);
  });

  it('supports a server-directed rollback to the embedded build', async () => {
    const client = { checkForUpdateAsync: vi.fn().mockResolvedValue({ isAvailable: false, isRollBackToEmbedded: true }), fetchUpdateAsync: vi.fn().mockResolvedValue({ isNew: false, isRollBackToEmbedded: true }) };
    await expect(downloadAppUpdate(client)).resolves.toBe('ready');
  });

  it('reports unsuccessful downloads instead of offering a broken restart', async () => {
    const client = { checkForUpdateAsync: vi.fn().mockResolvedValue({ isAvailable: true }), fetchUpdateAsync: vi.fn().mockResolvedValue({ isNew: false }) };
    await expect(downloadAppUpdate(client)).rejects.toThrow('could not be downloaded');
  });

  it('bounds a stalled check and ignores a late result', async () => {
    vi.useFakeTimers();
    let finish!: (result: { isAvailable: boolean }) => void;
    const client = { checkForUpdateAsync: vi.fn(() => new Promise<{ isAvailable: boolean }>(resolve => { finish = resolve; })), fetchUpdateAsync: vi.fn() };
    const result = expect(downloadAppUpdate(client, 100)).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(100);
    await result;
    finish({ isAvailable: true });
    await Promise.resolve();
    expect(client.fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it('bounds a stalled download too', async () => {
    vi.useFakeTimers();
    const client = { checkForUpdateAsync: vi.fn().mockResolvedValue({ isAvailable: true }), fetchUpdateAsync: vi.fn(() => new Promise<{ isNew: boolean }>(() => undefined)) };
    const result = expect(downloadAppUpdate(client, 100)).rejects.toThrow('took too long');
    await vi.advanceTimersByTimeAsync(100);
    await result;
  });
});
