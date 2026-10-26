import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  type CharacterAppearance, type CharacterCache, type SharedCharacter,
  characterSyncStorageKey, defaultAppearance, loadCharacterCache, serializeCharacterCache,
} from '@/domain/character';
import { useApp } from '@/features/app-store';
import { createCharacterSync, type CharacterSyncState } from '@/features/character-sync';
import { applyCharacterSelection } from '@/features/character-selection';
import { isLocalArtPreview } from '@/features/local-art-preview';
import { withAccountTimeout } from '@/lib/account-timeout';
import { loadSharedCharacter, updateCharacter } from '@/services/supabase-backend';
import { unlockedAppearance } from '@/domain/circle-shop';

export type { CharacterSaveStatus } from '@/features/character-sync';

type CharacterContextValue = CharacterSyncState & {
  setAppearance: (patch: Partial<CharacterAppearance>) => void;
  retrySave: () => void;
  sharedMode: boolean;
};

const CharacterContext = createContext<CharacterContextValue | null>(null);

// Serialized, profile-scoped offline writes survive provider remounts. Pending
// edits are recorded before the RPC; an acknowledged remote save clears them.
const writes = new Map<string, Promise<void>>();
function queueWrite(key: string, cache: CharacterCache): Promise<void> {
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => AsyncStorage.setItem(key, serializeCharacterCache(cache)));
  writes.set(key, next);
  void next.finally(() => {
    if (writes.get(key) === next) writes.delete(key);
  }).catch(() => undefined);
  return next;
}

export function CharacterProvider({ children }: PropsWithChildren) {
  const { profile, circleShop } = useApp();
  const storageKey = characterSyncStorageKey(profile.id);
  return <CharacterSession key={`${storageKey}:${circleShop?.id ?? 'legacy'}`} storageKey={storageKey} profileId={profile.id}
    sharedCharacter={profile.character} sharedMode={!isLocalArtPreview && Boolean(profile.id)}>
    {children}
  </CharacterSession>;
}

function CharacterSession({ children, storageKey, profileId, sharedCharacter, sharedMode }: PropsWithChildren<{
  storageKey: string; profileId: string; sharedCharacter: SharedCharacter | undefined; sharedMode: boolean;
}>) {
  const { refresh, circleShop } = useApp();
  const [state, setState] = useState<CharacterSyncState>({
    appearance: { ...defaultAppearance }, loaded: false, status: 'loading', error: null, shared: false,
  });
  const controller = useRef<ReturnType<typeof createCharacterSync> | null>(null);
  const server = useRef<SharedCharacter | undefined>(sharedCharacter);
  const latestShop = useRef(circleShop);

  useLayoutEffect(() => { latestShop.current = circleShop; }, [circleShop]);

  useEffect(() => {
    server.current = sharedCharacter;
    controller.current?.receive(sharedCharacter);
  }, [sharedCharacter]);

  useEffect(() => {
    let active = true;
    const sync = createCharacterSync({
      sharedMode,
      writeCache: cache => queueWrite(storageKey, cache),
      // The RPC checks target_profile_id against auth.uid at execution time.
      // A queued save from a signed-out profile cannot affect the new account.
      save: (appearance, expectedRevision) => updateCharacter(profileId, appearance, expectedRevision),
      onState: setState,
      reconcile: async () => {
        // Deliver the acknowledged revision synchronously to this editor;
        // refresh() alone schedules React state and can settle before render.
        const latest = await loadSharedCharacter(profileId);
        if (!active) return;
        sync.receive(latest);
        await refresh();
      },
    });
    controller.current = sync;
    sync.receive(server.current);
    async function restore() {
      try {
        const cached = await withAccountTimeout((async () => {
          await writes.get(storageKey)?.catch(() => undefined);
          return loadCharacterCache(profileId, key => AsyncStorage.getItem(key));
        })(), 'Loading your offline camper took too long.');
        if (active) await sync.hydrate(cached);
      } catch {
        if (active) await sync.hydrate(null, true);
      }
    }
    void restore();
    return () => {
      active = false;
      sync.stop();
      if (controller.current === sync) controller.current = null;
    };
  }, [storageKey, profileId, sharedMode, refresh]);

  const allowedLook = useMemo(() => unlockedAppearance(circleShop, state.appearance), [state.appearance, circleShop]);
  const setAppearance = useCallback((patch: Partial<CharacterAppearance>) => {
    // A purchase can finish after newer body/color edits or shared snapshots.
    // Read the live controller instead of retaining the look from that render.
    applyCharacterSelection(controller.current, latestShop.current, patch);
  }, []);
  const retrySave = useCallback(() => { void controller.current?.retry(); }, []);
  const value = useMemo<CharacterContextValue>(() => ({
    ...state, appearance: allowedLook, setAppearance, retrySave, sharedMode,
  }), [state, allowedLook, setAppearance, retrySave, sharedMode]);
  return <CharacterContext.Provider value={value}>{children}</CharacterContext.Provider>;
}

export function useCharacter(): CharacterContextValue {
  const context = useContext(CharacterContext);
  if (!context) throw new Error('useCharacter must be used inside CharacterProvider');
  return context;
}
