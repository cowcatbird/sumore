/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { LOCAL_DEMO_DATA_KEYS, localDemoResetUrl, resetRequestedLocalDemo } from './local-preview-reset';

describe('localhost demo reset isolation', () => {
  it.each([
    [false, 'http://localhost:8082/customize?resetLocalDemo=1'],
    [true, 'https://sumore.example/customize?resetLocalDemo=1'],
    [true, 'http://localhost.example:8082/?resetLocalDemo=1'],
    [true, 'http://192.168.1.2:8082/?resetLocalDemo=1'],
    [true, 'http://localhost:8082/customize'],
    [true, 'http://localhost:8082/customize?resetLocalDemo=0'],
    [true, 'file:///localhost?resetLocalDemo=1'],
    [true, 'not a URL'],
    [true, null],
  ] as const)('never removes data unless this is an explicit loopback demo action (%s, %s)', async (enabled, href) => {
    const multiRemove = vi.fn();
    expect(localDemoResetUrl(enabled, href)).toBeNull();
    expect(await resetRequestedLocalDemo(enabled, href, { multiRemove })).toBeNull();
    expect(multiRemove).not.toHaveBeenCalled();
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('clears only the six exact demo keys at %s and consumes the reset flag', async host => {
    const data = new Map<string, string>([
      ...LOCAL_DEMO_DATA_KEYS.map(key => [key, 'old demo data'] as [string, string]),
      ['sb-project-auth-token', 'real session'],
      ['sumore:character:v2:real-user', 'real camper'],
      ['sumore:app-tour:v1:real-user', 'real onboarding'],
      ['sumore:local-art-preview:circle-shop:another-demo', 'unrelated preview'],
    ]);
    const multiRemove = vi.fn(async (keys: string[]) => { keys.forEach(key => data.delete(key)); });
    const cleaned = await resetRequestedLocalDemo(true, `http://${host}:8082/customize?resetLocalDemo=1&view=colors#camp`, { multiRemove });
    expect(multiRemove).toHaveBeenCalledExactlyOnceWith([...LOCAL_DEMO_DATA_KEYS]);
    expect(LOCAL_DEMO_DATA_KEYS).toHaveLength(6);
    expect(LOCAL_DEMO_DATA_KEYS).toContain('sumore:local-art-preview:membership:v1');
    expect(data.size).toBe(4);
    expect(data.get('sb-project-auth-token')).toBe('real session');
    expect(data.get('sumore:character:v2:real-user')).toBe('real camper');
    expect(cleaned).toBe('/customize?view=colors#camp');
    expect(localDemoResetUrl(true, `http://${host}:8082${cleaned}`)).toBeNull();
  });

  it('reports storage failure rather than claiming a reset succeeded', async () => {
    await expect(resetRequestedLocalDemo(true, 'http://localhost:8082/?resetLocalDemo=1', {
      multiRemove: vi.fn().mockRejectedValue(new Error('Storage unavailable')),
    })).rejects.toThrow('Storage unavailable');
  });

  it('finishes the reset before loading demo data or mounting character and tour stores', () => {
    const text = readFileSync(new URL('./local-art-preview.tsx', import.meta.url), 'utf8');
    expect(text.indexOf('await resetRequestedLocalDemo')).toBeLessThan(text.indexOf('await AsyncStorage.getItem(PREVIEW_SHOP_KEY)'));
    expect(text).toContain('if (!circleShop) return');
    expect(text.indexOf('if (!circleShop) return')).toBeLessThan(text.indexOf('<AppContext.Provider'));
    expect(text).toContain('Platform.OS === \'web\'');
    expect(text).not.toContain('AsyncStorage.clear(');
    const layout = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain('preview?.resetCompleted && navigationState?.key');
    expect(layout).toContain('router.setParams({ resetLocalDemo: undefined })');
  });
});
