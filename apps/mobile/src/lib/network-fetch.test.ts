import { afterEach, describe, expect, it, vi } from 'vitest';

import { NETWORK_TIMEOUT_MS, networkFetch } from './network-fetch';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('bounded account network requests', () => {
  it('preserves the request and response and clears its timeout on success', async () => {
    vi.useFakeTimers();
    const response = { clone: () => ({ text: async () => '{}' }) } as Response;
    const fetcher = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetcher);
    expect(await networkFetch('https://example.com/profile', { method: 'POST', body: '{}' })).toBe(response);
    expect(fetcher).toHaveBeenCalledWith('https://example.com/profile', expect.objectContaining({ method: 'POST', body: '{}', signal: expect.any(AbortSignal) }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a hung save and returns a useful retry error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('Aborted')));
    })));
    const request = networkFetch('https://example.com/profile');
    const rejected = expect(request).rejects.toThrow('connection took too long');
    await vi.advanceTimersByTimeAsync(NETWORK_TIMEOUT_MS);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves caller cancellation without relabeling it as a timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_input, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('Caller cancelled')));
    })));
    const controller = new AbortController();
    const request = networkFetch('https://example.com/profile', { signal: controller.signal });
    const rejected = expect(request).rejects.toThrow('Caller cancelled');
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the deadline after headers arrive when the JSON body stalls', async () => {
    vi.useFakeTimers();
    const body = Promise.withResolvers<string>();
    const response = { clone: () => ({ text: () => body.promise }) };
    const fetcher = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetcher);
    const request = networkFetch('https://example.com/signup');
    const rejected = expect(request).rejects.toThrow('connection took too long');
    await vi.advanceTimersByTimeAsync(NETWORK_TIMEOUT_MS);
    await rejected;
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    body.resolve('{}');
    await Promise.resolve();
  });

  it('returns the original JSON body intact after buffering a clone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"session":"safe"}')));
    const response = await networkFetch('https://example.com/signup');
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toEqual({ session: 'safe' });
  });
});
