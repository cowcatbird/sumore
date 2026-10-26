import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function read(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const settings = read('../app/settings.tsx');
const screenTime = read('../app/screen-time.tsx');
const friends = read('../app/friends.tsx');

/** Verify the early-return guard is in the actual handler, not just a comment. */
function handler(name: string) {
  const source = ts.createSourceFile('settings.tsx', settings, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body: ts.Block | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText() === name && node.initializer
      && ts.isArrowFunction(node.initializer) && ts.isBlock(node.initializer.body)) body = node.initializer.body;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!body) throw new Error(`Missing handler ${name}`);
  return body;
}

describe('interactive localhost preview screens', () => {
  it.each(['screen-time', 'friends', 'settings'])('renders the real %s layout rather than an artwork-only placeholder', screen => {
    const text = read(`../app/${screen}.tsx`);
    expect(text).not.toContain('ArtworkPreviewNotice');
    expect(text).toContain('<ScreenHeader');
    expect(text).toContain('<LocalPreviewBanner');
  });

  it.each(['enablePush', 'previewNotification'])('returns before real notification APIs in %s', name => {
    const first = handler(name).statements[0];
    expect(ts.isIfStatement(first)).toBe(true);
    if (!ts.isIfStatement(first)) return;
    expect(first.expression.getText()).toBe('isLocalArtPreview');
    expect(ts.isBlock(first.thenStatement)).toBe(true);
    if (!ts.isBlock(first.thenStatement)) return;
    expect(ts.isReturnStatement(first.thenStatement.statements.at(-1)!)).toBe(true);
    expect(first.thenStatement.getText()).not.toMatch(/registerForPushNotifications|upsertPushToken|scheduleNotificationPreview|getNotificationReadiness/);
  });

  it('keeps notification readiness and native screen-time controls out of the demo', () => {
    expect(settings).toContain('if (isLocalArtPreview) return;\n    mounted.current = true;');
    expect(settings).toContain('getNotificationReadiness(ownerId)');
    expect(screenTime).toContain('isLocalArtPreview ? <LocalPreviewScreenTimeControls /> : <ScreenTimeControls />');
    expect(settings).not.toContain('ScreenTimeControls');
    const localControls = read('../components/local-preview-screen-time-controls.tsx');
    expect(localControls).not.toMatch(/from ['"](?:@\/|\.\.\/)(?:native|services|lib\/supabase)/);
  });

  it('never shares demo codes or signs out the real account', () => {
    const codeActions = read('../components/friend-code-actions.tsx');
    expect(friends).toContain('demo={isLocalArtPreview}');
    expect(codeActions).toContain("if (!code || disabled || pending.current || (demo && kind === 'share')) return;");
    expect(codeActions).toContain('Sharing is unavailable in this browser.');
    const account = read('../components/account-controls.tsx');
    expect(account).toContain("if (isLocalArtPreview) { setNotice('Account deletion is unavailable in this browser. Nothing was deleted. Open the installed app to manage your account.'); return; }");
    expect(account).toContain("if (isLocalArtPreview) { setNotice('Account recovery is unavailable in this browser. Open the installed app to restore your account.'); return; }");
    expect(settings).not.toContain('signOut');
  });

  it('keeps old request links working through the combined Circle screen', () => {
    const requests = read('../app/requests.tsx');
    expect(requests).toContain('Redirect');
    expect(requests).toContain("pathname: '/friends'");
    expect(requests).toContain("section: 'requests'");
    expect(friends).toContain('<CircleRequests');
  });

  it('retains development opt-in and disables all remote character synchronization', () => {
    expect(read('./local-art-preview.tsx')).toContain("__DEV__ && process.env.EXPO_PUBLIC_LOCAL_ART_PREVIEW === '1'");
    expect(read('../app/_layout.tsx')).toContain('isLocalArtPreview ? LocalArtPreviewProvider : AppProvider');
    expect(read('./character-store.tsx')).toContain('sharedMode={!isLocalArtPreview && Boolean(profile.id)}');
  });

  it('allows opening the Camp request sheet in the demo without enabling native status', () => {
    const camp = read('../app/index.tsx');
    expect(camp).toContain('useScreenTimeStatus(!isLocalArtPreview)');
    expect(camp).not.toContain("if (isLocalArtPreview) { router.push('/customize'); return; }");
    expect(camp).toContain('preview.respondToOutgoing');
  });

  it('gates both opening and submitting a demo ask on the same remaining-time policy', () => {
    const camp = read('../app/index.tsx');
    expect(camp).toContain('const askBlockReason = preview ? demoAskBlockReason(preview.screenTime) : null');
    expect(camp).toContain('if (busy || askBlockReason) return;');
    expect(camp).toContain('disabled={busy || Boolean(outgoingRequest) || askBlockReason !== null}');
    expect(camp).toContain('disabled={busy || askBlockReason !== null || Boolean(outgoingRequest)}');
    expect(camp).toContain('extra minutes added in this browser. Phone app limits are unchanged.');
    expect(read('../components/local-preview-screen-time-controls.tsx')).toContain('disabled={askBlockReason !== null}');
  });

  it('explains panic eligibility with a reachable sheet and blocks duplicate confirmations', () => {
    const camp = read('../app/index.tsx');
    expect(camp).toContain('previewPanicButtonBlockReason(preview.screenTime, panicSMores)');
    expect(camp).toContain('panicButtonBlockReason(screenTime, panicSMores)');
    expect(camp).toContain("panicBlockReason ? 'Panic button unavailable'");
    expect(camp).toContain('accessibilityHint={panicBlockReason ?? undefined}');
    expect(camp).toContain('disabled={panicPending || panicBlockReason !== null}');
    expect(camp).toContain('setPanicOpen(false); router.push(\'/screen-time\');');
    expect(camp).toContain('if (panicPending || panicBlockReason || panicSubmittingRef.current) return;');
    expect(camp.indexOf('panicSubmittingRef.current = true')).toBeLessThan(camp.indexOf('await pressPanicButton()'));
    expect(camp).toContain('panicSubmittingRef.current = false');
    expect(camp).toContain('setPanicError(caught instanceof Error ? caught.message');
    expect(camp).toContain('Phone app limits are unchanged and no notifications are sent.');
    expect(camp).toContain('Panic access still works, and your balance stays at 0.');
    expect(camp).toContain('Costs 1 circle s’more if available. Your balance never goes below 0.');
    expect(camp).toContain('circleShop?.balance ?? Number.NaN');
    const opener = camp.slice(camp.indexOf('accessibilityLabel="Panic button"'), camp.indexOf('<SymbolView', camp.indexOf('accessibilityLabel="Panic button"')));
    expect(opener).toContain('disabled={panicPending}');
    expect(opener).toContain('setPanicOpen(true)');
    expect(opener).not.toContain('disabled={panicBlockReason');
  });

  it('prepares panic effects together and commits only after local wallet storage succeeds', () => {
    const provider = read('./local-art-preview.tsx');
    const panic = provider.slice(provider.indexOf('const pressPanicButton ='), provider.indexOf('const setBackground ='));
    expect(panic).toContain('if (mutationPending.current) throw');
    expect(panic.indexOf('mutationPending.current = true')).toBeLessThan(panic.indexOf('await AsyncStorage.setItem'));
    expect(panic).toContain('pressPreviewPanicButton(expirePreviewRequests(demoRef.current), shopRef.current)');
    expect(panic).toContain('updatePreviewMembershipRecord(membershipRef.current, next.state, next.shop)');
    for (const commit of ['membershipRef.current = saved', 'shopRef.current = next.shop', 'commitDemo(expirePreviewRequests(next.state))', 'setCircleShop(next.shop)']) {
      expect(panic.indexOf(commit)).toBeGreaterThan(panic.indexOf('await AsyncStorage.setItem'));
    }
    expect(panic).toContain('mutationPending.current = false');
    expect(panic).not.toContain('await mutateShop');
    expect(panic).not.toMatch(/from ['"](?:@\/|\.\.\/)(?:native|services|lib\/supabase)/);
  });
});
