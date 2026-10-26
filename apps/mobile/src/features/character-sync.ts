import {
  type CharacterAppearance, type CharacterCache, type SharedCharacter,
  defaultAppearance, normalizeAppearance, sameAppearance,
} from '@/domain/character';
import { withAccountTimeout } from '@/lib/account-timeout';

export type CharacterSaveStatus = 'loading' | 'ready' | 'saving' | 'saved' | 'error';
export type CharacterSyncState = {
  appearance: CharacterAppearance;
  loaded: boolean;
  status: CharacterSaveStatus;
  error: string | null;
  shared: boolean;
};

/** Profile-scoped optimistic editor. It never mutates another account's cache. */
export function createCharacterSync({ sharedMode, writeCache, save, onState, reconcile }: {
  sharedMode: boolean;
  writeCache: (cache: CharacterCache) => Promise<void>;
  save: (appearance: CharacterAppearance, expectedRevision: number) => Promise<SharedCharacter>;
  onState: (state: CharacterSyncState) => void;
  reconcile: () => Promise<void>;
}) {
  let state: CharacterSyncState = { appearance: { ...defaultAppearance }, loaded: false, status: 'loading', error: null, shared: false };
  let server: SharedCharacter | undefined;
  let active = true;
  let dirty = false;
  let importing = false;
  let editingRevision = 0;
  let pumping = false;

  const emit = (patch: Partial<CharacterSyncState>) => {
    state = { ...state, ...patch };
    if (active) onState(state);
  };
  const cache = (pending: boolean): CharacterCache => ({
    appearance: state.appearance, pending, baseRevision: server?.revision ?? null,
  });
  const store = async (pending: boolean) => {
    try {
      await withAccountTimeout(writeCache(cache(pending)), 'Saving the offline camper copy took too long.');
      return true;
    } catch { return false; }
  };

  function receive(next: SharedCharacter | undefined) {
    if (!active || !next || (server && next.revision < server.revision)) return;
    server = next;
    if (!state.loaded || pumping) return;
    // A successful but unacknowledged save can be confirmed by the next poll.
    if (next.appearance && (sameAppearance(next.appearance, state.appearance) || !dirty || importing)) {
      if (!dirty && state.shared && sameAppearance(next.appearance, state.appearance)) return;
      dirty = false;
      importing = false;
      emit({ appearance: next.appearance, shared: true, status: 'saved', error: null });
      void store(false);
    }
  }

  async function pump() {
    if (!active || !state.loaded || pumping || !dirty) return;
    pumping = true;
    try {
      while (active && dirty) {
        if (importing && server?.appearance) { dirty = false; break; }
        const attempt = editingRevision;
        const chosen = state.appearance;
        const expectedRevision = server?.revision;
        emit({ status: 'saving', error: null });
        const cached = await store(sharedMode);
        if (!active) return;
        if (!sharedMode) {
          if (attempt !== editingRevision) continue;
          if (!cached) throw new Error('Your camper could not be saved on this device. Please try again.');
          dirty = false;
          emit({ status: 'saved', shared: false });
          break;
        }
        if (expectedRevision === undefined) throw new Error('Shared looks are not enabled on the server yet. Your choice is kept on this device; tap Retry after the update.');
        const result = await save(chosen, expectedRevision);
        if (!active) return;
        // Polling can see a newer external edit before our response arrives.
        if (server && result.revision < server.revision) {
          throw new Error('Your camper changed on another device. Tap Retry to share the look shown here.');
        }
        server = result;
        if (attempt !== editingRevision) continue;
        dirty = false;
        importing = false;
        const savedLocally = await store(false);
        if (!active) return;
        // Editing may continue while the offline cache is being written.
        if (attempt !== editingRevision) continue;
        emit({ status: savedLocally ? 'saved' : 'error', shared: true, error: savedLocally ? null : 'Shared with your circle, but this device could not save an offline copy. Tap Retry.' });
      }
    } catch (caught) {
      if (active) {
        emit({ status: 'error', shared: sameAppearance(server?.appearance, state.appearance), error: caught instanceof Error ? caught.message : 'Could not share your camper. Check your connection and tap Retry.' });
      }
    } finally {
      pumping = false;
      if (active) receive(server);
      if (active && sharedMode) {
        // Resolve unknown-commit timeouts and CAS conflicts using the server,
        // never by blindly resubmitting an obsolete revision.
        void reconcile().catch(() => undefined);
      }
    }
  }

  async function hydrate(local: CharacterCache | null, localError = false) {
    if (!active) return;
    const remoteLook = server?.appearance;
    if (sharedMode && remoteLook && (!local?.pending || sameAppearance(local.appearance, remoteLook))) {
      emit({ appearance: remoteLook, loaded: true, status: 'saved', shared: true });
      void store(false);
      return;
    }
    const look = local?.appearance ?? remoteLook ?? { ...defaultAppearance };
    emit({ appearance: look, loaded: true, status: localError ? 'error' : 'ready', shared: false,
      error: localError ? 'Your saved local camper could not be read. Pick a look to save it again.' : null });
    if (!local || !sharedMode) return;

    // Carry over a legacy per-profile local look only into an unset remote
    // record. Revision-zero compare-and-swap cannot overwrite an existing look.
    if (server?.appearance === null && server.revision === 0) {
      dirty = true;
      importing = !local.pending;
      await pump();
    } else if (local.pending) {
      dirty = true;
      if (server && local.baseRevision === server.revision) await pump();
      else emit({ status: 'error', error: 'This device has an unshared look and the saved camper changed elsewhere. Tap Retry to share the look shown here.' });
    }
  }

  function setAppearance(patch: Partial<CharacterAppearance>) {
    if (!active || !state.loaded) return;
    const appearance = normalizeAppearance({ ...state.appearance, ...patch });
    importing = false;
    dirty = true;
    editingRevision += 1;
    emit({ appearance, shared: false, status: 'saving', error: null });
    void pump();
  }

  async function retry() {
    if (!active || !state.loaded || pumping) return;
    if (sharedMode) await reconcile().catch(() => undefined);
    if (!active) return;
    dirty = true;
    importing = false;
    editingRevision += 1;
    await pump();
  }

  return { hydrate, receive, setAppearance, retry, stop: () => { active = false; }, getState: () => state };
}
