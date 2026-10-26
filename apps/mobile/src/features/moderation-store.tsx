import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import { useApp } from '@/features/app-store';
import { isLocalArtPreview } from '@/features/local-art-preview';
import { acceptCommunityRules, COMMUNITY_RULES_VERSION, getModerationStatus, reportCircleContent, type ModerationStatus } from '@/services/moderation';

export type ReportTarget = {
  ownerId: string; circleId: string; targetUserId: string; displayName: string;
  kind: 'person' | 'request'; requestId?: string;
};
export type ReportReason = 'offensive_content' | 'harassment' | 'spam' | 'other';
type ModerationContextValue = {
  status: ModerationStatus | null; loading: boolean; error: string | null; accepting: boolean; preview: boolean;
  refresh: () => Promise<void>; acceptRules: () => Promise<void>;
  report: (target: ReportTarget, reason: ReportReason, detail: string, clientReportId: string) => Promise<{ reportId: string; status: 'received' }>;
};
const Context = createContext<ModerationContextValue | null>(null);

export function ModerationProvider({ children }: PropsWithChildren) {
  const { profile } = useApp();
  // Keying the inner provider drops private status and in-flight ownership on
  // every account transition, including A → B → A.
  return <AccountModeration key={profile.id}>{children}</AccountModeration>;
}

function AccountModeration({ children }: PropsWithChildren) {
  const { profile, circleShop, friends, incomingRequests } = useApp();
  const [status, setStatus] = useState<ModerationStatus | null>(() => isLocalArtPreview ? {
    rulesVersion: COMMUNITY_RULES_VERSION, acceptedRulesVersion: null, isModerator: false, restriction: null, notices: [],
  } : null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const active = useRef(false);
  const load = useRef(0);
  const mutation = useRef(false);
  const current = useRef({ profile, circleShop, friends, incomingRequests });
  useLayoutEffect(() => { current.current = { profile, circleShop, friends, incomingRequests }; });
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; load.current += 1; }; }, []);
  const refresh = useCallback(async () => {
    if (isLocalArtPreview || !active.current || mutation.current) return;
    const request = ++load.current;
    setLoading(true); setError(null);
    try {
      const next = await getModerationStatus(profile.id);
      if (active.current && request === load.current) setStatus(next);
    } catch (caught) {
      if (active.current && request === load.current) setError(caught instanceof Error ? caught.message : 'Community status could not be loaded. Try again.');
    } finally {
      if (active.current && request === load.current) setLoading(false);
    }
  }, [profile.id]);
  useEffect(() => {
    // Defer the first network read; status loading must not synchronously
    // cascade a second render while all account providers are mounting.
    void Promise.resolve().then(() => { if (active.current) return refresh(); });
    const subscription = AppState.addEventListener('change', next => { if (next === 'active') void refresh(); });
    return () => subscription.remove();
  }, [refresh]);
  const acceptRules = async () => {
    if (isLocalArtPreview) throw new Error('Acceptance is unavailable in this browser. Nothing was sent to the server.');
    if (!active.current || current.current.profile.id !== profile.id) throw new Error('Your account changed. Open the rules again.');
    if (mutation.current) throw new Error('Please wait for your current action to finish.');
    if (!status) throw new Error('Refresh community status before accepting the rules.');
    if (status.rulesVersion !== COMMUNITY_RULES_VERSION) throw new Error('The community rules changed. Update sumore before accepting them.');
    mutation.current = true; setAccepting(true); load.current += 1; setLoading(false);
    try {
      const next = await acceptCommunityRules(profile.id, COMMUNITY_RULES_VERSION);
      if (!active.current) throw new Error('Your account changed. Open the rules again.');
      load.current += 1;
      setStatus(next); setError(null);
    } finally {
      mutation.current = false;
      if (active.current) setAccepting(false);
    }
  };
  const report = async (target: ReportTarget, reason: ReportReason, detail: string, clientReportId: string) => {
    if (isLocalArtPreview) throw new Error('Reports cannot be sent from this browser. No report was sent.');
    const latest = current.current;
    if (!active.current || target.ownerId !== latest.profile.id || target.circleId !== latest.circleShop?.id
      || target.targetUserId === latest.profile.id || !latest.friends.some(friend => friend.id === target.targetUserId)
      || (target.kind === 'request' && !latest.incomingRequests.some(request => request.id === target.requestId && request.friend.id === target.targetUserId))) {
      throw new Error('Your account, circle, or this content changed. Close this sheet and choose the content again.');
    }
    if (mutation.current) throw new Error('Please wait for your current action to finish.');
    mutation.current = true;
    try {
      const receipt = await reportCircleContent(profile.id, target.circleId, {
        targetUserId: target.targetUserId, targetRequestId: target.requestId, reason, details: detail, clientReportId,
      });
      if (!active.current) throw new Error('Your account changed. The report result is not shown for this account.');
      if (current.current.circleShop?.id !== target.circleId) throw new Error('Your circle changed while sending. The report may have been received; its result cannot be confirmed here.');
      return receipt;
    } finally { mutation.current = false; }
  };
  return <Context.Provider value={{ status, loading, error, accepting, preview: isLocalArtPreview, refresh, acceptRules, report }}>{children}</Context.Provider>;
}

export function useModeration() {
  const context = useContext(Context);
  if (!context) throw new Error('ModerationProvider is missing.');
  return context;
}
