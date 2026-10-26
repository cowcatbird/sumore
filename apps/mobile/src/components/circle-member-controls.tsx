import { SymbolView } from 'expo-symbols';
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { ActionButton, FormSheet } from '@/components/form-sheet';
import { ReportContentForm } from '@/components/report-content-sheet';
import { Space, Type, useAppColors } from '@/constants/theme';
import type { BlockedPerson } from '@/domain/circle-membership';
import { useApp } from '@/features/app-store';
import { isLocalArtPreview } from '@/features/local-art-preview';

type Person = { id: string; displayName: string };
type Panel = { kind: 'manage' } | { kind: 'person' | 'block'; person: Person; circleId: string }
  | { kind: 'report'; person: Person; circleId: string }
  | { kind: 'leave'; circleId: string } | { kind: 'unblock'; person: Person } | null;
type State = {
  ownerId: string; panel: Panel; pending: boolean; blocked: BlockedPerson[] | null;
  loading: boolean; listError: string | null; error: string | null; success: string | null;
};
const initial = (ownerId: string): State => ({ ownerId, panel: null, pending: false, blocked: null,
  loading: false, listError: null, error: null, success: null });
const messageFor = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;
const MemberControlsContext = createContext<{ openPerson: (personId: string) => void; disabled: boolean; available: boolean } | null>(null);

export function CircleMemberMenuButton({ personId, displayName }: { personId: string; displayName: string }) {
  const controls = useContext(MemberControlsContext);
  const c = useAppColors();
  if (!controls?.available) return null;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Options for ${displayName}`}
    accessibilityState={{ disabled: controls.disabled }} disabled={controls.disabled} onPress={() => controls.openPerson(personId)}
    style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: controls.disabled ? 0.5 : 1 }}>
    <SymbolView name={{ ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' }} size={20} tintColor={c.inkSoft} />
  </Pressable>;
}

/** One action sheet and synchronous submission guard for the entire roster. */
export function CircleMemberControls({ children }: { children?: ReactNode }) {
  const { profile, friends, circleShop, busy, leaveCircle, blockPerson, unblockPerson, getBlockedPeople } = useApp();
  const c = useAppColors();
  const [saved, setState] = useState(() => initial(profile.id));
  if (saved.ownerId !== profile.id) setState(initial(profile.id));
  const state = saved.ownerId === profile.id ? saved : initial(profile.id);
  const owner = useRef<string | null>(profile.id);
  const generation = useRef(0);
  const submitting = useRef(false);
  const listRequest = useRef(0);
  useLayoutEffect(() => {
    owner.current = profile.id; generation.current += 1; submitting.current = false; listRequest.current += 1;
    return () => { owner.current = null; generation.current += 1; listRequest.current += 1; };
  }, [profile.id]);
  const disabled = busy || state.pending;
  const body = { color: c.inkSoft, fontSize: 14, lineHeight: 21 } as const;
  const current = (ownerId: string, epoch: number) => owner.current === ownerId && generation.current === epoch;
  const update = (patch: Partial<State>) => setState(value => value.ownerId === profile.id ? { ...value, ...patch } : value);

  const loadBlocked = async () => {
    const userId = profile.id, epoch = generation.current, request = ++listRequest.current;
    update({ loading: true, listError: null });
    try {
      const blocked = await getBlockedPeople();
      if (current(userId, epoch) && listRequest.current === request) update({ blocked, loading: false });
    } catch (error) {
      if (current(userId, epoch) && listRequest.current === request) {
        update({ loading: false, listError: messageFor(error, 'Could not load blocked people. Try again.') });
      }
    }
  };
  const openManage = () => {
    if (submitting.current || busy || !circleShop || owner.current !== profile.id) return;
    update({ panel: { kind: 'manage' }, error: null, success: null, blocked: null });
    void loadBlocked();
  };
  const openPerson = (personId: string) => {
    if (submitting.current || busy || !circleShop || owner.current !== profile.id) return;
    const person = friends.find(friend => friend.id === personId && friend.id !== profile.id);
    if (!person) return;
    listRequest.current += 1;
    update({ panel: { kind: 'person', person: { id: person.id, displayName: person.displayName }, circleId: circleShop.id },
      error: null, success: null, loading: false });
  };
  const close = () => {
    if (submitting.current) return;
    listRequest.current += 1;
    update({ panel: null, loading: false, error: null, success: null });
  };
  const navigate = (panel: Panel, clearMessages = false) => {
    if (submitting.current || owner.current !== profile.id) return;
    update({ panel, ...(clearMessages ? { error: null, success: null } : {}) });
    if (panel?.kind === 'manage' && state.blocked === null && !state.loading && !state.listError) void loadBlocked();
  };
  const run = async () => {
    if (submitting.current || busy || owner.current !== profile.id) return;
    const panel = state.panel;
    if (!panel || panel.kind === 'manage' || panel.kind === 'person' || panel.kind === 'report') return;
    if (panel.kind !== 'unblock' && (!circleShop || panel.circleId !== circleShop.id || !friends.length ||
      (panel.kind === 'block' && !friends.some(friend => friend.id === panel.person.id && friend.id !== profile.id)))) {
      update({ error: 'Your circle changed. Close this sheet and choose the action again.' });
      return;
    }
    const userId = profile.id, epoch = generation.current;
    submitting.current = true; listRequest.current += 1;
    update({ pending: true, loading: false, error: null, success: null });
    try {
      if (panel.kind === 'leave') await leaveCircle();
      else if (panel.kind === 'block') await blockPerson(panel.person.id);
      else await unblockPerson(panel.person.id);
      if (!current(userId, epoch)) return;
      // The server can confirm a safe no-op if the last peer left first.
      // Do not claim a new/empty circle without that transition in this API.
      const success = panel.kind === 'leave' ? 'Circle change confirmed. Your current circle is shown below.'
        : panel.kind === 'block' ? `${panel.person.displayName} is blocked. Your current circle is shown below; they were not removed.`
        : `${panel.person.displayName} is unblocked. You have not rejoined a circle.`;
      setState(value => value.ownerId !== userId ? value : { ...value, panel: { kind: 'manage' },
        success: isLocalArtPreview ? `${success} Saved in this browser only.` : success,
        blocked: panel.kind === 'unblock' ? value.blocked?.filter(person => person.id !== panel.person.id) ?? null : null });
      // The mutation already succeeded. A failed list refresh must not turn it
      // into an apparent failed leave/block or encourage duplicate writes.
      if (panel.kind !== 'unblock') void loadBlocked();
    } catch (error) {
      if (current(userId, epoch)) update({ error: messageFor(error, 'Could not change your circle. Try again.') });
    } finally {
      if (current(userId, epoch)) { submitting.current = false; update({ pending: false }); }
    }
  };
  const panel = state.panel;
  const title = panel?.kind === 'person' ? panel.person.displayName
    : panel?.kind === 'report' ? `Report ${panel.person.displayName}`
    : panel?.kind === 'block' ? `Block ${panel.person.displayName}?`
    : panel?.kind === 'leave' ? 'Leave your circle?'
    : panel?.kind === 'unblock' ? `Unblock ${panel.person.displayName}?` : 'Manage circle';
  return <MemberControlsContext.Provider value={{ openPerson, disabled, available: !!circleShop }}>
    {children}
    {circleShop && <Pressable accessibilityRole="button" accessibilityLabel="Manage circle"
      accessibilityState={{ disabled }} disabled={disabled} onPress={openManage}
      style={{ alignSelf: 'flex-end', paddingVertical: Space.xs, minHeight: 44, gap: 8, flexDirection: 'row', alignItems: 'center',
        opacity: disabled ? 0.5 : 1 }}>
      <SymbolView name={{ ios: 'person.2.badge.gearshape', android: 'manage_accounts', web: 'manage_accounts' }} size={17} tintColor={c.inkSoft} />
      <Text style={{ ...Type.bodySmall, color: c.inkSoft }}>Manage circle</Text>
    </Pressable>}
    <FormSheet title={title} visible={!!panel} onClose={close} busy={state.pending}>
      {isLocalArtPreview && <Text style={body}>Changes here stay in this browser and do not affect your phone’s circle.</Text>}
      {panel?.kind === 'person' && <>
        <ActionButton label="Report person" disabled={disabled}
          onPress={() => navigate({ ...panel, kind: 'report' }, true)} />
        <Text style={body}>Blocking this person also leaves the current circle. They stay in the circle; you do not remove them.</Text>
        <ActionButton label={`Block ${panel.person.displayName}`} danger disabled={disabled}
          onPress={() => navigate({ ...panel, kind: 'block' }, true)} />
        <ActionButton label="Cancel" disabled={disabled} onPress={close} />
      </>}
      {panel?.kind === 'report' && <ReportContentForm
        key={`${profile.id}:${panel.circleId}:${panel.person.id}`}
        target={{ ownerId: profile.id, circleId: panel.circleId, targetUserId: panel.person.id,
          displayName: panel.person.displayName, kind: 'person' }}
        onBusyChange={value => { submitting.current = value; update({ pending: value }); }}
        onBlock={() => navigate({ kind: 'block', person: panel.person, circleId: panel.circleId }, true)}
        onDone={close} />}
      {(panel?.kind === 'leave' || panel?.kind === 'block') && <>
        {panel.kind === 'block' && <>
          <Text style={body}>{panel.person.displayName} will be blocked. You leave this circle; they are not removed.</Text>
          <Text style={body}>We store both account IDs and the block date to prevent new connections and requests. Only you can see your blocked list. Unblocking or deleting either account removes the record.</Text>
        </>}
        <Text style={body}>Your account, private login key, and this phone’s app limits stay unchanged.</Text>
        <Text style={body}>This circle keeps its shared s’mores and purchases. You start an empty personal circle.</Text>
        <Text style={body}>No one can approve your requests until you join a circle with friends.</Text>
        <ActionButton label={panel.kind === 'leave' ? 'Confirm leave circle' : `Confirm block ${panel.person.displayName} and leave circle`}
          danger disabled={disabled} onPress={() => { void run(); }} />
        <ActionButton label="Cancel" disabled={disabled} onPress={() => navigate(panel.kind === 'leave' ? { kind: 'manage' } : { ...panel, kind: 'person' })} />
      </>}
      {panel?.kind === 'unblock' && <>
        <Text style={body}>Remove your block on {panel.person.displayName}? This does not automatically rejoin their circle or restore your old membership.</Text>
        <ActionButton label={`Confirm unblock ${panel.person.displayName}`} disabled={disabled} onPress={() => { void run(); }} />
        <ActionButton label="Cancel" disabled={disabled} onPress={() => navigate({ kind: 'manage' })} />
      </>}
      {panel?.kind === 'manage' && <>
        {state.success && <Text accessibilityLiveRegion="polite" style={{ ...body, color: c.emerald }}>{state.success}</Text>}
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '700' }}>Your circle</Text>
        <Text style={body}>{friends.length ? 'Leave to start an empty personal circle. Your current circle keeps its shared s’mores and purchases.' : 'You are already in a personal circle. Join friends to receive approvals.'}</Text>
        <ActionButton label="Leave circle" danger disabled={disabled || !circleShop || !friends.length}
          onPress={() => { if (circleShop && friends.length) navigate({ kind: 'leave', circleId: circleShop.id }, true); }} />
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '700', marginTop: 12 }}>Blocked people</Text>
        {state.loading ? <ActivityIndicator color={c.ember} accessibilityLabel="Loading blocked people" />
          : state.listError ? <>
            <Text accessibilityRole="alert" style={{ ...body, color: c.scarlet }}>{state.listError}</Text>
            <ActionButton label="Retry blocked people" disabled={disabled} onPress={() => { void loadBlocked(); }} />
          </> : state.blocked && (state.blocked.length ? state.blocked.map(person => <View key={person.id} style={{ gap: 8 }}>
            <Text style={{ color: c.ink, fontSize: 15, fontWeight: '600' }}>{person.displayName}</Text>
            <ActionButton label={`Unblock ${person.displayName}`} disabled={disabled}
              onPress={() => navigate({ kind: 'unblock', person }, true)} />
          </View>) : <Text style={body}>No blocked people.</Text>)}
      </>}
      {state.pending && <ActivityIndicator color={c.ember} accessibilityLabel="Updating circle" />}
      {state.error && <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ ...body, color: c.scarlet }}>{state.error}</Text>}
    </FormSheet>
  </MemberControlsContext.Provider>;
}
