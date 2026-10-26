import { appTourStorageKey } from '@/domain/app-tour-state';
import { characterStorageKey, characterSyncStorageKey } from '@/domain/character';
import { LEGACY_PREVIEW_SHOP_KEY, PREVIEW_SHOP_KEY } from './preview-circle-shop';
import { PREVIEW_MEMBERSHIP_KEY } from './preview-circle-membership';

// Exact demo-owned keys only. Never clear storage, auth, or another profile.
export const LOCAL_DEMO_DATA_KEYS = [
  PREVIEW_SHOP_KEY,
  LEGACY_PREVIEW_SHOP_KEY,
  PREVIEW_MEMBERSHIP_KEY,
  characterStorageKey('local-art-preview'),
  characterSyncStorageKey('local-art-preview'),
  appTourStorageKey('local-art-preview'),
] as const;

/** Explicit one-shot URL action, only for a loopback development preview. */
export function localDemoResetUrl(enabled: boolean, href: string | null): URL | null {
  if (!enabled || !href) return null;
  try {
    const url = new URL(href);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && url.searchParams.get('resetLocalDemo') === '1' ? url : null;
  } catch { return null; }
}

/** Called at initial load, before any camper/tour providers can start writes. */
export async function resetRequestedLocalDemo(enabled: boolean, href: string | null,
  storage: { multiRemove: (keys: string[]) => Promise<void> }): Promise<string | null> {
  const url = localDemoResetUrl(enabled, href);
  if (!url) return null;
  await storage.multiRemove([...LOCAL_DEMO_DATA_KEYS]);
  url.searchParams.delete('resetLocalDemo');
  return `${url.pathname}${url.search}${url.hash}`;
}
