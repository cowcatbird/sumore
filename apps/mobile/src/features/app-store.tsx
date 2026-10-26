import type { Session } from '@supabase/supabase-js';
import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { createProfileLoader } from '@/features/profile-loader';
import { createScreenTimeGrantSync } from '@/features/screen-time-grant-sync';
import { restoreLatestSession } from '@/features/session-restore';
import { isSupabaseConfigured, requireSupabase } from '@/lib/supabase';
import { applyScreenTimeGrant, configureScreenTimeAccount, getScreenTimeStatus } from '@/native/screen-time';
import {
  addFriendByCode,
  cancelTimeRequest as cancelRemoteRequest,
  changeCircleBackground,
  claimScreenTimeGrant,
  createTimeRequest as createRemoteRequest,
  decideTimeRequest as decideRemoteRequest,
  loadSnapshot,
  getActiveScreenTimeGrant,
  joinSharedCircle as joinRemoteCircle,
  onAuthStateChange,
  purchaseCircleItem,
  signInAnonymously,
  signOut as signOutRemote,
  subscribeToAppChanges,
  defaultGroupPolicy,
  updateGroupPolicy as updateRemoteGroupPolicy,
  updateProfile as updateRemoteProfile, triggerPanicButton,
} from '@/services/supabase-backend';
import type { AppSnapshot, Decision, GrantMinutes } from '@/types/domain';
import type { BackgroundId, ShopItemId } from '@/domain/circle-shop';
import type { BlockedPerson } from '@/domain/circle-membership';
import { blockCirclePerson, getBlockedPeople as loadBlockedPeople, leaveSharedCircle, unblockCirclePerson } from '@/services/circle-membership';

const emptySnapshot: AppSnapshot = {
  profile: { id: '', displayName: '', friendCode: '', initials: '' },
  friends: [],
  incomingRequests: [],
  outgoingRequest: null,
  recentDecision: null,
  groupPolicy: defaultGroupPolicy,
  campfire: { localDate: '', seats: [], groupGolden: 0 },
};

export type AppContextValue = AppSnapshot & {
  isConfigured: boolean;
  isReady: boolean;
  isAuthenticated: boolean;
  profileLoading: boolean;
  busy: boolean;
  error: string | null;
  session: Session | null;
  clearError: () => void;
  refresh: () => Promise<void>;
  sendRequest: (minutes: GrantMinutes, reason?: string) => Promise<void>;
  decideRequest: (id: string, decision: Decision) => Promise<void>;
  cancelRequest: () => Promise<void>;
  addFriend: (code: string) => Promise<void>;
  joinSharedCircle: (code: string) => Promise<void>;
  leaveCircle: () => Promise<void>;
  blockPerson: (personId: string) => Promise<void>;
  unblockPerson: (personId: string) => Promise<void>;
  getBlockedPeople: () => Promise<BlockedPerson[]>;
  purchaseItem: (item: ShopItemId) => Promise<void>;
  pressPanicButton: () => Promise<void>;
  setBackground: (background: BackgroundId) => Promise<void>;
  updateGroupPolicy: (title: string, body: string) => Promise<void>;
  updateProfile: (displayName: string) => Promise<void>;
  continueWithoutEmail: (displayName: string) => Promise<void>;
  signOut: () => Promise<void>;
};

export const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: PropsWithChildren) {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [session, setSession] = useState<Session | null>(null);
  const [isReady, setIsReady] = useState(!isSupabaseConfigured);
  const [busy, setBusy] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenTimeError, setScreenTimeError] = useState<string | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const sessionRevision = useRef(0);
  const accountGeneration = useRef(0);
  const activeActions = useRef(0);
  const [grantSync] = useState(() => createScreenTimeGrantSync({
    configureAccount: configureScreenTimeAccount,
    getStatus: getScreenTimeStatus,
    applyGrant: applyScreenTimeGrant,
    claimGrant: claimScreenTimeGrant,
    getActiveGrant: getActiveScreenTimeGrant,
    triggerPanic: async expectedUser => (await triggerPanicButton(expectedUser)).grant,
    onError: setScreenTimeError,
  }));
  const [profileLoader] = useState(() => createProfileLoader({
      load: loadSnapshot,
      onSnapshot: next => {
        setSnapshot(next);
        void grantSync.sync(next.recentDecision);
      },
      onLoading: setProfileLoading,
  }));

  const acceptSession = useCallback((nextSession: Session | null) => {
    sessionRevision.current += 1;
    if (sessionRef.current?.user.id !== nextSession?.user.id) {
      accountGeneration.current += 1;
      setSnapshot(emptySnapshot);
    }
    // setUser invalidates old async receipts synchronously; its native work is
    // queued outside this auth callback so Supabase's auth lock is never held.
    void grantSync.setUser(nextSession?.user.id ?? null);
    profileLoader.setUser(nextSession?.user.id ?? null);
    sessionRef.current = nextSession;
    setSession(nextSession);
    setIsReady(true);
  }, [grantSync, profileLoader]);

  const run = useCallback(async <T,>(action: () => Promise<T>) => {
    const generation = accountGeneration.current;
    activeActions.current += 1;
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Something went wrong. Please try again.';
      if (accountGeneration.current === generation) setError(message);
      throw caught;
    } finally {
      activeActions.current -= 1;
      setBusy(activeActions.current > 0);
    }
  }, []);

  const restoreSession = useCallback(async () => {
    await restoreLatestSession({
      read: () => requireSupabase().auth.getSession(),
      revision: () => sessionRevision.current,
      accept: acceptSession,
    });
  }, [acceptSession]);

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured) return;
    setError(null);
    try {
      if (!sessionRef.current) await restoreSession();
      void grantSync.sync();
      await profileLoader.refresh(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load your account. Tap Retry.');
      throw caught;
    }
  }, [grantSync, profileLoader, restoreSession]);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      return;
    }

    let mounted = true;
    // Ignore INITIAL_SESSION here: the explicit read below can distinguish a
    // restore error from a genuinely signed-out device. Auth callbacks stay
    // synchronous so they never hold Supabase's auth lock during a profile RPC.
    const { data } = onAuthStateChange((nextSession, event) => {
      if (mounted && event !== 'INITIAL_SESSION') acceptSession(nextSession);
    });
    restoreSession()
      .catch((caught) => {
        if (mounted) setError(caught instanceof Error ? caught.message : 'Could not restore your account.');
      });
    return () => {
      mounted = false;
      // Invalidate pending restoration and snapshot responses on unmount.
      sessionRevision.current += 1;
      profileLoader.setUser(null);
      // Unmount/Strict Mode cleanup must not erase saved native restrictions.
      // Only an actual sign-out or account change clears the device account.
      grantSync.invalidate();
      data.subscription.unsubscribe();
    };
  }, [acceptSession, grantSync, profileLoader, restoreSession]);

  const sessionUserId = session?.user.id;
  useEffect(() => {
    if (!sessionUserId) return;

    let active = true;
    const refreshSafely = () => {
      if (!active || (AppState.currentState && AppState.currentState !== 'active')) return;
      // Retry native/server grant reconciliation even if the profile endpoint
      // fails separately. A successful profile read must not erase its errors.
      void grantSync.sync();
      profileLoader.refresh().then(() => {
        if (active) setError(null);
      }).catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not refresh.');
      });
    };
    const initialRefresh = setTimeout(refreshSafely, 0);
    const interval = setInterval(refreshSafely, 10_000);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshSafely();
    });
    const channel = subscribeToAppChanges(refreshSafely);

    return () => {
      active = false;
      clearTimeout(initialRefresh);
      clearInterval(interval);
      appStateSubscription.remove();
      requireSupabase().removeChannel(channel);
    };
  }, [grantSync, profileLoader, sessionUserId]);

  const sendRequest = useCallback(
    (minutes: GrantMinutes, reason = '') =>
      run(async () => {
        await createRemoteRequest(minutes, reason);
        await refresh();
      }),
    [refresh, run],
  );

  const decideRequest = useCallback(
    (id: string, decision: Decision) =>
      run(async () => {
        await decideRemoteRequest(id, decision);
        await refresh();
      }),
    [refresh, run],
  );

  const cancelRequest = useCallback(async () => {
    if (!snapshot.outgoingRequest) return;
    await run(async () => {
      await cancelRemoteRequest(snapshot.outgoingRequest!.id);
      await refresh();
    });
  }, [refresh, run, snapshot.outgoingRequest]);

  const addFriend = useCallback(
    (code: string) =>
      run(async () => {
        await addFriendByCode(code);
        await refresh();
      }),
    [refresh, run],
  );

  const joinSharedCircle = useCallback((code: string) => run(async () => {
    await joinRemoteCircle(code);
    await refresh();
  }), [refresh, run]);

  const membershipPending = useRef(false);
  const membershipChange = useCallback(async (change: (owner: string, group: string) => Promise<unknown>) => {
    if (membershipPending.current) throw new Error('Please wait for your circle change to finish.');
    const owner = snapshot.profile.id;
    const group = snapshot.circleShop?.id;
    const generation = accountGeneration.current;
    if (!owner || !group || sessionRef.current?.user.id !== owner) throw new Error('Refresh your circle before trying again.');
    membershipPending.current = true;
    try {
      await run(async () => {
        try {
          await change(owner, group);
        } catch (caught) {
          // A lost response can follow a committed leave/block. Reconcile the
          // current account without replaying a mutation or claiming success.
          if (accountGeneration.current === generation) await refresh().catch(() => undefined);
          throw caught;
        }
        if (accountGeneration.current !== generation || sessionRef.current?.user.id !== owner) {
          throw new Error('Your account changed. Reopen Circle before trying again.');
        }
        try { await refresh(); }
        catch {
          throw new Error('Your circle change was saved, but the latest view could not load. Reopen Circle to refresh before making another change.');
        }
      });
    } finally { membershipPending.current = false; }
  }, [snapshot.profile.id, snapshot.circleShop?.id, refresh, run]);
  const leaveCircle = useCallback(() => membershipChange(leaveSharedCircle), [membershipChange]);
  const blockPerson = useCallback((personId: string) => membershipChange((owner, group) => blockCirclePerson(owner, group, personId)), [membershipChange]);
  const unblockPerson = useCallback((personId: string) => membershipChange(owner => unblockCirclePerson(owner, personId)), [membershipChange]);
  const getBlockedPeople = useCallback(async () => {
    const owner = snapshot.profile.id;
    const generation = accountGeneration.current;
    if (!owner || owner !== sessionRef.current?.user.id) throw new Error('Refresh your account before opening blocked people.');
    const people = await loadBlockedPeople(owner);
    if (accountGeneration.current !== generation || sessionRef.current?.user.id !== owner) throw new Error('Your account changed. Reopen Circle before trying again.');
    return people;
  }, [snapshot.profile.id]);

  const purchaseItem = useCallback((item: ShopItemId) => run(async () => {
    const groupId = snapshot.circleShop?.id;
    if (!groupId) throw new Error('Shared s’mores need the updated server.');
    const owner = sessionRef.current?.user.id;
    await purchaseCircleItem(groupId, item);
    if (owner === sessionRef.current?.user.id) await refresh();
  }), [snapshot.circleShop?.id, refresh, run]);

  /**
   * Grant fifteen unrestricted minutes, spending one circle s'more if available.
   *
   * Preflight the installed engine and await native acknowledgement in the
   * grant queue. The server transaction cannot make a device unlock atomic:
   * if delivery fails, recover its existing receipt without spending again.
   */
  const pressPanicButton = useCallback(() => run(async () => {
    const owner = sessionRef.current?.user.id;
    try {
      await grantSync.pressPanicButton(snapshot.circleShop?.balance ?? Number.NaN);
    } finally {
      // Refresh the wallet even when the server charged but native delivery
      // failed. A refresh failure must not obscure the original grant result.
      if (owner === sessionRef.current?.user.id) await refresh().catch(() => undefined);
    }
  }), [grantSync, snapshot.circleShop?.balance, refresh, run]);

  const setBackground = useCallback((background: BackgroundId) => run(async () => {
    const groupId = snapshot.circleShop?.id;
    if (!groupId) throw new Error('Shared backgrounds need the updated server.');
    const owner = sessionRef.current?.user.id;
    await changeCircleBackground(groupId, background);
    if (owner === sessionRef.current?.user.id) await refresh();
  }), [snapshot.circleShop?.id, refresh, run]);

  const updateGroupPolicy = useCallback(
    (title: string, body: string) =>
      run(async () => {
        await updateRemoteGroupPolicy(title, body);
        await refresh();
      }),
    [refresh, run],
  );

  const updateProfile = useCallback(
    (displayName: string) =>
      run(async () => {
        await updateRemoteProfile(displayName);
        await refresh();
      }),
    [refresh, run],
  );

  const continueWithoutEmail = useCallback(
    (displayName: string) =>
      run(async () => {
        const nextSession = await signInAnonymously(displayName);
        acceptSession(nextSession);
        await refresh();
      }),
    [acceptSession, refresh, run],
  );

  const signOut = useCallback(async () => {
    // Stop accepting old receipts as soon as sign-out begins, not only after a
    // network response. Rebind the retained account if signing out fails.
    void grantSync.setUser(null);
    try {
      await run(signOutRemote);
      acceptSession(null);
    } catch (caught) {
      void grantSync.setUser(sessionRef.current?.user.id ?? null);
      throw caught;
    }
  }, [acceptSession, grantSync, run]);

  const value = useMemo<AppContextValue>(
    () => ({
      ...snapshot,
      isConfigured: isSupabaseConfigured,
      isReady,
      isAuthenticated: Boolean(session),
      profileLoading,
      busy,
      error: error ?? screenTimeError,
      session,
      clearError: () => setError(null),
      refresh,
      sendRequest,
      decideRequest,
      cancelRequest,
      addFriend,
      joinSharedCircle,
      leaveCircle,
      blockPerson,
      unblockPerson,
      getBlockedPeople,
      purchaseItem,
      pressPanicButton,
      setBackground,
      updateGroupPolicy,
      updateProfile,
      continueWithoutEmail,
      signOut,
    }),
    [
      busy,
      cancelRequest,
      continueWithoutEmail,
      addFriend,
      joinSharedCircle,
      leaveCircle,
      blockPerson,
      unblockPerson,
      getBlockedPeople,
      purchaseItem,
      pressPanicButton,
      setBackground,
      decideRequest,
      error,
      screenTimeError,
      isReady,
      profileLoading,
      refresh,
      sendRequest,
      session,
      signOut,
      snapshot,
      updateProfile,
      updateGroupPolicy,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}
