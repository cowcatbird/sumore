import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, type PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, Text, View } from 'react-native';

import { AppContext, type AppContextValue } from '@/features/app-store';
import type { Decision, GrantMinutes } from '@/types/domain';
import type { BackgroundId, CircleShop, ShopItemId } from '@/domain/circle-shop';
import type { BlockedPerson } from '@/domain/circle-membership';
import type { DemoAction, DemoState } from '@/domain/demo-screen-time';
import { initialPreviewShop, LEGACY_PREVIEW_SHOP_KEY, PREVIEW_SHOP_KEY, pressPreviewPanicButton, purchasePreviewItem, restorePreviewShop, setPreviewBackground } from '@/features/preview-circle-shop';
import { resetRequestedLocalDemo } from '@/features/local-preview-reset';
import { currentPreviewShop, PREVIEW_MEMBERSHIP_KEY, restorePreviewMembership, restorePreviewRoster,
  updatePreviewMembershipRecord, type PreviewMembershipRecord } from '@/features/preview-circle-membership';
import { addPreviewFriend, blockPreviewPerson, cancelPreviewRequest, createPreviewAppState, decidePreviewRequest, DEMO_FRIEND_CODE, expirePreviewRequests,
  leavePreviewCircle, unblockPreviewPerson,
  joinPreviewCircle, previewAppSnapshot, refillPreviewRequests, resetPreviewAppState, respondToPreviewOutgoing, sendPreviewRequest, setPreviewCamperCount,
  updatePreviewGroupPolicy, updatePreviewProfile, updatePreviewScreenTime, type PreviewAppState } from '@/features/preview-app-state';

export { sampleLooks } from '@/features/preview-app-state';

/** Both conditions must hold. Release builds never activate example accounts. */
export const isLocalArtPreview = __DEV__ && process.env.EXPO_PUBLIC_LOCAL_ART_PREVIEW === '1';

type LocalArtPreviewValue = {
  count: number;
  burnt: boolean;
  toggleBurnt: () => void;
  setCamperCount: (count: number) => void;
  reset: () => void;
  resetCompleted: boolean;
  refillRequests: () => void;
  respondToOutgoing: (decision: Decision) => Promise<void>;
  demoFriendCode: typeof DEMO_FRIEND_CODE;
  screenTime: DemoState;
  updateScreenTime: (action: DemoAction) => void;
};

const LocalArtPreviewContext = createContext<LocalArtPreviewValue | null>(null);

export function LocalArtPreviewProvider({ children }: PropsWithChildren) {
  if (!isLocalArtPreview) {
    throw new Error('This browser workspace is unavailable in this build.');
  }
  return <EnabledLocalArtPreview>{children}</EnabledLocalArtPreview>;
}

/** No AppProvider, auth session, subscription, or remote operation lives here. */
function EnabledLocalArtPreview({ children }: PropsWithChildren) {
  const [demo, setDemo] = useState(() => createPreviewAppState());
  const demoRef = useRef(demo);
  const [error, setError] = useState<string | null>(null);
  const [circleShop, setCircleShop] = useState<CircleShop>();
  const [busy, setBusy] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [resetCompleted, setResetCompleted] = useState(false);
  const shopRef = useRef<CircleShop | undefined>(undefined);
  const membershipRef = useRef<PreviewMembershipRecord | undefined>(undefined);
  const mutationPending = useRef(false);
  const commitDemo = useCallback((next: PreviewAppState) => { demoRef.current = next; setDemo(next); }, []);
  const mutateDemo = useCallback(async (change: (current: PreviewAppState) => PreviewAppState) => {
    if (mutationPending.current) throw new Error('Please wait for your circle to finish saving.');
    setError(null);
    // Read from the ref so two actions in one render cannot overwrite each other.
    const current = expirePreviewRequests(demoRef.current);
    commitDemo(current);
    try { commitDemo(change(current)); }
    catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The activity could not be updated.');
      throw caught;
    }
  }, [commitDemo]);
  useEffect(() => {
    const requests = [...demo.incomingRequests, ...(demo.outgoingRequest ? [demo.outgoingRequest] : [])];
    if (!requests.length) return;
    const expiresAt = Math.min(...requests.map(request => Date.parse(request.expiresAt)));
    const timer = setTimeout(() => commitDemo(expirePreviewRequests(demoRef.current)), Math.max(0, expiresAt - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [commitDemo, demo.incomingRequests, demo.outgoingRequest]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // Full-page startup only: dependent stores have not mounted yet, so
        // stale appearance/tour writes cannot resurrect cleared demo data.
        const cleanPath = await resetRequestedLocalDemo(isLocalArtPreview,
          Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.href : null, AsyncStorage);
        if (cleanPath !== null && active) setResetCompleted(true);
        const membership = await AsyncStorage.getItem(PREVIEW_MEMBERSHIP_KEY);
        const current = membership === null ? await AsyncStorage.getItem(PREVIEW_SHOP_KEY) : null;
        const legacy = membership === null && current === null ? await AsyncStorage.getItem(LEGACY_PREVIEW_SHOP_KEY) : null;
        const shared = membership === null ? restorePreviewShop(current, new Date(), legacy) : initialPreviewShop();
        const saved = restorePreviewMembership(membership, demoRef.current, shared, new Date(), current !== null || legacy !== null);
        if (!active) return;
        // Persist the first grant before enabling any purchase buttons.
        await AsyncStorage.setItem(PREVIEW_MEMBERSHIP_KEY, JSON.stringify(saved));
        if (!active) return;
        membershipRef.current = saved;
        shopRef.current = currentPreviewShop(saved);
        commitDemo(restorePreviewRoster(demoRef.current, saved));
        setCircleShop(shopRef.current);
      } catch {
        if (active) setError('The circle wallet could not be loaded. Reload to retry.');
      }
    })();
    return () => { active = false; };
  }, [commitDemo, loadAttempt]);
  const mutateShop = useCallback(async (change: (shop: CircleShop) => CircleShop) => {
    if (mutationPending.current) throw new Error('Please wait for your purchase to finish.');
    if (!shopRef.current || !membershipRef.current) throw new Error('Your circle’s wallet is loading.');
    mutationPending.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = change(shopRef.current);
      const saved = updatePreviewMembershipRecord(membershipRef.current, demoRef.current, next);
      await AsyncStorage.setItem(PREVIEW_MEMBERSHIP_KEY, JSON.stringify(saved));
      membershipRef.current = saved;
      shopRef.current = next;
      setCircleShop(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The purchase could not be saved.');
      throw caught;
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  }, []);
  const mutateMembership = useCallback(async (change: (state: PreviewAppState) => PreviewAppState) => {
    if (mutationPending.current) throw new Error('Please wait for your circle to finish saving.');
    if (!membershipRef.current) throw new Error('Your circle is loading.');
    mutationPending.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = change(expirePreviewRequests(demoRef.current));
      const saved = updatePreviewMembershipRecord(membershipRef.current, next);
      // Persist wallet and membership together before removing any campers.
      // Failed storage never leaves an optimistic block or a lost shared wallet.
      await AsyncStorage.setItem(PREVIEW_MEMBERSHIP_KEY, JSON.stringify(saved));
      membershipRef.current = saved;
      shopRef.current = currentPreviewShop(saved);
      commitDemo(expirePreviewRequests(next));
      setCircleShop(shopRef.current);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The circle could not be saved.');
      throw caught;
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  }, [commitDemo]);
  const purchaseItem = useCallback((item: ShopItemId) => mutateShop(shop => purchasePreviewItem(shop, item)), [mutateShop]);
  const pressPanicButton = useCallback(async () => {
    if (mutationPending.current) throw new Error('Please wait for your circle to finish saving.');
    if (!shopRef.current || !membershipRef.current) throw new Error('Your circle’s wallet is loading.');
    mutationPending.current = true;
    setBusy(true);
    setError(null);
    try {
      // Recheck the current policy at confirmation, then prepare every effect
      // before saving. A failed write spends nothing and adds no demo time.
      const next = pressPreviewPanicButton(expirePreviewRequests(demoRef.current), shopRef.current);
      const saved = updatePreviewMembershipRecord(membershipRef.current, next.state, next.shop);
      await AsyncStorage.setItem(PREVIEW_MEMBERSHIP_KEY, JSON.stringify(saved));
      membershipRef.current = saved;
      shopRef.current = next.shop;
      commitDemo(expirePreviewRequests(next.state));
      setCircleShop(next.shop);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The panic button could not be saved.');
      throw caught;
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  }, [commitDemo]);
  const setBackground = useCallback((background: BackgroundId) => mutateShop(shop => setPreviewBackground(shop, background)), [mutateShop]);

  const setCamperCount = useCallback((nextCount: number) => {
    void mutateMembership(current => setPreviewCamperCount(current, nextCount)).catch(() => undefined);
  }, [mutateMembership]);
  const clearError = useCallback(() => setError(null), []);
  const toggleBurnt = useCallback(() => {
    if (mutationPending.current) return;
    const current = demoRef.current;
    commitDemo({ ...current, burnt: !current.burnt });
  }, [commitDemo]);
  const reset = useCallback(() => {
    void mutateMembership(current => resetPreviewAppState(current)).catch(() => undefined);
  }, [mutateMembership]);
  const refillRequests = useCallback(() => {
    if (mutationPending.current) return;
    commitDemo(refillPreviewRequests(demoRef.current));
    setError(null);
  }, [commitDemo]);
  const updateScreenTime = useCallback((action: DemoAction) => {
    if (mutationPending.current) return;
    commitDemo(updatePreviewScreenTime(expirePreviewRequests(demoRef.current), action));
    setError(null);
  }, [commitDemo]);
  const sendRequest = useCallback((minutes: GrantMinutes, reason?: string) => mutateDemo(current => sendPreviewRequest(current, minutes, reason)), [mutateDemo]);
  const decideRequest = useCallback((id: string, decision: Decision) => mutateDemo(current => decidePreviewRequest(current, id, decision)), [mutateDemo]);
  const cancelRequest = useCallback(() => mutateDemo(cancelPreviewRequest), [mutateDemo]);
  const addFriend = useCallback((code: string) => mutateMembership(current => addPreviewFriend(current, code)), [mutateMembership]);
  const joinSharedCircle = useCallback((code: string) => mutateMembership(current => joinPreviewCircle(current, code)), [mutateMembership]);
  const leaveCircle = useCallback(() => mutateMembership(leavePreviewCircle), [mutateMembership]);
  const blockPerson = useCallback((id: string) => mutateMembership(current => blockPreviewPerson(current, id)), [mutateMembership]);
  const unblockPerson = useCallback((id: string) => mutateMembership(current => unblockPreviewPerson(current, id)), [mutateMembership]);
  const getBlockedPeople = useCallback(async (): Promise<BlockedPerson[]> => demoRef.current.blockedPeople.map(person => ({ ...person })), []);
  const updateProfile = useCallback((name: string) => mutateDemo(current => updatePreviewProfile(current, name)), [mutateDemo]);
  const updateGroupPolicy = useCallback((title: string, body: string) => mutateDemo(current => updatePreviewGroupPolicy(current, title, body)), [mutateDemo]);
  const outgoingRequestId = demo.outgoingRequest?.id ?? null;
  const respondToOutgoing = useCallback((decision: Decision) => mutateDemo(current => respondToPreviewOutgoing(current, decision, new Date(), outgoingRequestId)), [mutateDemo, outgoingRequestId]);
  const signOut = useCallback(async () => {
    const message = 'No account is signed in in this browser. Open the installed app to manage your account.';
    setError(message);
    throw new Error(message);
  }, []);
  const refresh = useCallback(() => mutateDemo(expirePreviewRequests), [mutateDemo]);

  const app = useMemo<AppContextValue>(() => {
    return {
      ...previewAppSnapshot(demo, circleShop),
      isConfigured: true,
      isReady: true,
      isAuthenticated: true,
      profileLoading: false,
      busy,
      error,
      session: null,
      clearError,
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
      continueWithoutEmail: updateProfile,
      signOut,
    };
  }, [demo, error, clearError, refresh, circleShop, busy, purchaseItem, pressPanicButton, setBackground, sendRequest, decideRequest, cancelRequest,
    addFriend, joinSharedCircle, leaveCircle, blockPerson, unblockPerson, getBlockedPeople, updateGroupPolicy, updateProfile, signOut]);

  const controls = useMemo<LocalArtPreviewValue>(() => ({ count: demo.friends.length + 1, burnt: demo.burnt, toggleBurnt, setCamperCount, reset, resetCompleted,
    refillRequests, respondToOutgoing, demoFriendCode: DEMO_FRIEND_CODE, screenTime: demo.screenTime, updateScreenTime }),
  [demo.friends.length, demo.burnt, demo.screenTime, toggleBurnt, setCamperCount, reset, resetCompleted, refillRequests, respondToOutgoing, updateScreenTime]);
  if (!circleShop) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
    {error ? <>
      <Text accessibilityRole="alert" style={{ color: '#FFF3DE' }}>{error}</Text>
      <Pressable accessibilityRole="button" onPress={() => { setError(null); setLoadAttempt(value => value + 1); }}
        style={{ padding: 16, backgroundColor: '#FFAD66', borderRadius: 16 }}><Text>Retry</Text></Pressable>
    </> : <ActivityIndicator accessibilityLabel="Loading your circle" color="#FFAD66" />}
  </View>;
  return (
    <LocalArtPreviewContext.Provider value={controls}>
      <AppContext.Provider value={app}>{children}</AppContext.Provider>
    </LocalArtPreviewContext.Provider>
  );
}

/** Null in the real app, so home can omit development-only example controls. */
export function useLocalArtPreview(): LocalArtPreviewValue | null {
  return useContext(LocalArtPreviewContext);
}
