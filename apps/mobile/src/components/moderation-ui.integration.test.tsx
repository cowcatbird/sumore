import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommunityRulesSheet } from './community-rules';
import { ReportContentForm } from './report-content-sheet';

type Button = { label?: string; accessibilityLabel?: string; onPress: () => void; disabled?: boolean; children?: ReactNode };
type EffectSlot = { deps?: readonly unknown[]; cleanup?: () => void };
const h = vi.hoisted(() => ({
  slots: [] as unknown[], cursor: 0, layouts: [] as (() => void)[], buttons: new Map<string, Button>(),
  forms: new Map<string, { onClose: () => void; busy: boolean }>(), inputs: new Map<string, { onChangeText: (value: string) => void; value: string; editable: boolean; maxLength: number }>(),
  ownerId: 'owner-a', groupId: 'circle-a', preview: false, accepting: false, loading: false, error: null as string | null,
  status: { rulesVersion: '2026-10-12', acceptedRulesVersion: null as string | null, restriction: null, notices: [], isModerator: false },
  report: vi.fn(), accept: vi.fn(), refresh: vi.fn(), close: vi.fn(), block: vi.fn(), busy: vi.fn(), uuid: vi.fn(), email: vi.fn(), clipboard: vi.fn(),
}));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [h.slots[index], (next: unknown) => { h.slots[index] = typeof next === 'function' ? next(h.slots[index]) : next; }];
    },
    useRef: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = { current: initial };
      return h.slots[index];
    },
    useLayoutEffect: (callback: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = h.cursor++;
      const previous = h.slots[index] as EffectSlot | undefined;
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        h.layouts.push(() => { previous?.cleanup?.(); const cleanup = callback(); h.slots[index] = { deps, cleanup }; });
      }
    },
  };
});
vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  Text: ({ children, accessibilityRole }: { children: ReactNode; accessibilityRole?: string }) => createElement('span', { role: accessibilityRole }, children),
  Pressable: (props: Button) => { if (props.accessibilityLabel) h.buttons.set(props.accessibilityLabel, props); return createElement('button', { disabled: props.disabled }, props.children); },
  Keyboard: { dismiss: vi.fn() }, Linking: { openURL: vi.fn() },
}));
vi.mock('expo-crypto', () => ({ randomUUID: () => h.uuid() }));
vi.mock('expo-clipboard', () => ({ setStringAsync: h.clipboard }));
vi.mock('@/services/moderation-email', () => ({ openCommunityReportEmail: h.email,
  communityReportEmail: (input: { reportId: string; details: string }) => ({ recipients: ['cowcatbird.dev@gmail.com'], subject: '[Community report] sumore', body: `Reference: ${input.reportId}\n${input.details}`, isHtml: false }),
}));
vi.mock('@/components/form-sheet', () => ({
  ActionButton: (props: Button & { label: string }) => { h.buttons.set(props.label, props); return createElement('button', { disabled: props.disabled }, props.label); },
  FormSheet: ({ visible, title, children, ...props }: { visible: boolean; title: string; children: ReactNode; onClose: () => void; busy: boolean }) => {
    if (!visible) return null; h.forms.set(title, props); return createElement('section', null, children);
  },
}));
vi.mock('@/components/keyboard-form', () => ({ KeyboardTextInput: (props: { accessibilityLabel: string; onChangeText: (value: string) => void; value: string; editable: boolean; maxLength: number }) => {
  h.inputs.set(props.accessibilityLabel, props); return createElement('textarea', { value: props.value, readOnly: !props.editable });
} }));
vi.mock('@/components/settings-action-row', () => ({ SettingsActionRow: () => null }));
vi.mock('@/constants/theme', () => ({ Space: { xs: 8, sm: 12, md: 16, lg: 24 }, Radius: { coal: 999, fold: 16, blanket: 24 },
  Type: { body: {}, bodySmall: {}, control: {}, heading: {}, meter: {} }, useAppColors: () => ({ ink: '#111', inkSoft: '#555' }) }));
vi.mock('@/features/app-store', () => ({ useApp: () => ({ profile: { id: h.ownerId }, circleShop: { id: h.groupId } }) }));
vi.mock('@/features/moderation-store', () => ({ useModeration: () => ({ status: h.status, preview: h.preview, accepting: h.accepting,
  loading: h.loading, error: h.error, report: h.report, acceptRules: h.accept, refresh: h.refresh }) }));
vi.mock('@/services/moderation', () => ({ COMMUNITY_RULES_VERSION: '2026-10-12' }));
const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (node: ReactNode) => string };
const target = { ownerId: 'owner-a', circleId: 'circle-a', targetUserId: 'friend-id', displayName: 'Scout', kind: 'person' as const };
let screen: 'report' | 'rules' = 'report';
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function render() {
  h.cursor = 0; h.buttons.clear(); h.forms.clear(); h.inputs.clear();
  const html = renderToStaticMarkup(screen === 'report'
    ? createElement(ReportContentForm, { target, onBusyChange: h.busy, onBlock: h.block, onDone: h.close })
    : createElement(CommunityRulesSheet, { visible: true, onClose: h.close }));
  h.layouts.splice(0).forEach(callback => callback()); return html;
}
async function press(label: string) {
  const button = h.buttons.get(label); expect(button, `Missing ${label}`).toBeDefined();
  if (!button!.disabled) button!.onPress(); await flush(); return render();
}
beforeEach(() => {
  vi.clearAllMocks(); h.slots = []; h.cursor = 0; h.layouts = []; h.buttons.clear(); h.forms.clear(); h.inputs.clear();
  h.ownerId = 'owner-a'; h.groupId = 'circle-a'; h.preview = false; h.accepting = false; h.loading = false; h.error = null;
  h.status = { rulesVersion: '2026-10-12', acceptedRulesVersion: null, restriction: null, notices: [], isModerator: false };
  h.uuid.mockReturnValue('draft-uuid'); h.report.mockResolvedValue({ reportId: 'saved-report-id', status: 'received' }); h.accept.mockResolvedValue(undefined);
  h.email.mockReset().mockResolvedValue('opened'); h.clipboard.mockReset().mockResolvedValue(undefined); screen = 'report';
});
afterEach(() => { for (const slot of h.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as EffectSlot).cleanup?.(); });

describe('Moderation report form', () => {
  it('requires a selected reason and keeps details optional, bounded, keyboard-aware and private', async () => {
    const html = render(); expect(h.buttons.get('Open report email')!.disabled).toBe(true);
    expect(html).toContain('Don’t include login keys'); expect(html).toContain('identity stays private');
    expect(h.inputs.get('Report details (optional)')!.maxLength).toBe(500);
    await press('Spam'); expect(h.buttons.get('Open report email')!.disabled).toBe(false);
    await press('Open report email'); expect(h.report).toHaveBeenCalledExactlyOnceWith(target, 'spam', '', 'draft-uuid');
    expect(h.email).toHaveBeenCalledWith({ reportId: 'saved-report-id', targetDisplayName: 'Scout', kind: 'person', reason: 'spam', details: '' }, expect.any(Function));
  });
  it('does not report when a person menu opens, and never auto-blocks after receipt', async () => {
    render(); expect(h.report).not.toHaveBeenCalled(); await press('Harassment or threats');
    const html = await press('Open report email'); expect(html).toContain('A private copy of this report is saved');
    expect(html).toContain('Delivery to support is not confirmed'); expect(html).toContain('Support can see your email address');
    expect(h.block).not.toHaveBeenCalled(); expect(h.buttons.has('Open report email')).toBe(false);
    await press('Block Scout'); expect(h.block).toHaveBeenCalledTimes(1);
  });
  it('synchronously prevents duplicate reports before a render, and waits for server receipt', async () => {
    const pending = Promise.withResolvers<{ reportId: string; status: string }>(); h.report.mockReturnValueOnce(pending.promise);
    render(); await press('Spam'); const send = h.buttons.get('Open report email')!.onPress;
    send(); send(); await flush(); expect(h.report).toHaveBeenCalledTimes(1);
    expect(render()).toContain('Preparing report email'); expect(render()).not.toContain('private copy of this report is saved'); expect(h.email).not.toHaveBeenCalled();
    expect(h.busy).toHaveBeenCalledWith(true);
    pending.resolve({ reportId: 'saved-report-id', status: 'received' }); await flush(); expect(render()).toContain('private copy of this report is saved'); expect(h.busy).toHaveBeenLastCalledWith(false); expect(h.email).toHaveBeenCalledOnce();
  });
  it('keeps the identical receipt and payload for a user-triggered uncertain retry', async () => {
    h.report.mockRejectedValueOnce(new Error('The result could not be confirmed.'));
    render(); await press('Something else'); h.inputs.get('Report details (optional)')!.onChangeText('  Repeated harassment  '); render();
    const error = await press('Open report email'); expect(error).toContain('result could not be confirmed'); expect(error).not.toContain('private copy of this report is saved'); expect(h.email).not.toHaveBeenCalled();
    expect(h.inputs.get('Report details (optional)')!.editable).toBe(false);
    expect(h.buttons.get('Spam')!.disabled).toBe(true); expect(h.report).toHaveBeenCalledTimes(1);
    await press('Retry same report'); expect(h.uuid).toHaveBeenCalledTimes(1);
    expect(h.report.mock.calls[1]).toEqual(h.report.mock.calls[0]);
  });
  it('does not send reports from the browser preview or show a fake receipt', async () => {
    h.preview = true; render(); await press('Spam');
    expect(h.buttons.get('Open report email')!.disabled).toBe(true);
    const html = await press('Open report email'); expect(html).toContain('No report will be sent'); expect(html).not.toContain('private copy of this report is saved');
    h.buttons.get('Open report email')!.onPress(); await flush();
    expect(h.report).not.toHaveBeenCalled(); expect(h.email).not.toHaveBeenCalled(); expect(h.clipboard).not.toHaveBeenCalled();
  });
  it.each(['owner', 'circle'])('refuses a stale %s before submission', async change => {
    render(); await press('Spam'); const oldSend = h.buttons.get('Open report email')!.onPress;
    if (change === 'owner') h.ownerId = 'owner-b'; else h.groupId = 'circle-b';
    const html = render(); expect(html).toContain('account or circle changed'); expect(h.buttons.get('Open report email')!.disabled).toBe(true);
    // A fresh callback checks the captured identity even if invoked directly.
    h.buttons.get('Open report email')!.onPress(); oldSend(); await flush(); expect(h.report).not.toHaveBeenCalled(); expect(h.email).not.toHaveBeenCalled();
  });
  it('ignores an old report response after unmount', async () => {
    const pending = Promise.withResolvers<{ reportId: string; status: string }>(); h.report.mockReturnValueOnce(pending.promise);
    render(); await press('Spam'); await press('Open report email');
    for (const slot of h.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as EffectSlot).cleanup?.();
    h.busy.mockClear(); pending.resolve({ reportId: 'saved-report-id', status: 'received' }); await flush();
    expect(h.busy).not.toHaveBeenCalled(); expect(render()).not.toContain('private copy of this report is saved'); expect(h.email).not.toHaveBeenCalled();
  });
  it.each([
    ['opened', 'Finish reviewing and sending in your email app'],
    ['cancelled', 'Email cancelled'],
    ['saved', 'Draft saved in your email app'],
    ['accepted', 'Your email app accepted the send request'],
  ])('describes composer result %s without claiming email delivery', async (result, expected) => {
    h.email.mockResolvedValue(result); render(); await press('Spam'); const html = await press('Open report email');
    expect(html).toContain(expected); expect(html).not.toContain('Email delivered'); expect(html).not.toContain('Email sent successfully');
    expect(html).toContain(result === 'cancelled' ? 'no email was confirmed sent' : 'Delivery to support is not confirmed');
  });
  it('reopens the saved email after compose failure without submitting another report', async () => {
    h.email.mockRejectedValueOnce(new Error('Email could not be opened.'));
    render(); await press('Something else'); h.inputs.get('Report details (optional)')!.onChangeText('Harassment details'); render();
    const failed = await press('Open report email'); expect(failed).toContain('Email could not be opened'); expect(failed).toContain('Report reference: saved-report-id');
    expect(h.report).toHaveBeenCalledOnce(); expect(h.buttons.has('Copy email details')).toBe(true);
    const recovered = await press('Reopen report email'); expect(recovered).toContain('Finish reviewing');
    expect(h.report).toHaveBeenCalledOnce(); expect(h.email).toHaveBeenCalledTimes(2); expect(h.email.mock.calls[1][0]).toEqual(h.email.mock.calls[0][0]);
  });
  it('copies a saved report draft only on an explicit tap and does not imply sending', async () => {
    render(); await press('Spam'); await press('Open report email'); expect(h.clipboard).not.toHaveBeenCalled();
    const html = await press('Copy email details');
    expect(h.clipboard).toHaveBeenCalledExactlyOnceWith('To: cowcatbird.dev@gmail.com\nSubject: [Community report] sumore\n\nReference: saved-report-id\n');
    expect(html).toContain('Nothing was emailed automatically'); expect(h.report).toHaveBeenCalledOnce(); expect(h.email).toHaveBeenCalledOnce();
  });
  it('shows a usable manual fallback if copying the draft fails', async () => {
    h.clipboard.mockRejectedValueOnce(new Error('Unavailable'));
    render(); await press('Spam'); await press('Open report email'); const html = await press('Copy email details');
    expect(html).toContain('Could not copy the email'); expect(html).toContain('Report reference: saved-report-id'); expect(html).not.toContain('Copied email details');
  });
  it('does not launch a draft when the account changes while saving its reference', async () => {
    const pending = Promise.withResolvers<{ reportId: string; status: string }>(); h.report.mockReturnValueOnce(pending.promise);
    render(); await press('Spam'); await press('Open report email'); h.ownerId = 'owner-b'; render();
    pending.resolve({ reportId: 'saved-report-id', status: 'received' }); await flush();
    expect(h.email).not.toHaveBeenCalled(); expect(render()).not.toContain('Report reference: saved-report-id');
  });
  it('binds deferred composer work to the account and disables copying or reopening after a switch', async () => {
    render(); await press('Spam'); await press('Open report email');
    const isCurrent = h.email.mock.calls[0][1] as () => boolean; expect(isCurrent()).toBe(true);
    const reopen = h.buttons.get('Reopen report email')!.onPress; const copy = h.buttons.get('Copy email details')!.onPress;
    h.ownerId = 'owner-b'; render(); expect(isCurrent()).toBe(false); reopen(); copy(); await flush();
    expect(h.email).toHaveBeenCalledOnce(); expect(h.clipboard).not.toHaveBeenCalled(); expect(h.report).toHaveBeenCalledOnce();
  });
});

describe('Explicit community rules acceptance', () => {
  beforeEach(() => { screen = 'rules'; });
  it('starts unchecked, does not accept on open/close, and keeps personal controls available', async () => {
    const html = render(); expect(h.buttons.get('Accept community rules')!.disabled).toBe(true);
    expect(html).toContain('Your personal controls remain available'); expect(html).toContain('delete your account');
    h.forms.get('Community rules')!.onClose(); expect(h.accept).not.toHaveBeenCalled(); expect(h.close).toHaveBeenCalledTimes(1);
    await press('I agree to the community rules'); expect(h.buttons.get('Accept community rules')!.disabled).toBe(false);
    await press('Accept community rules'); expect(h.accept).toHaveBeenCalledTimes(1);
  });
  it('does not save acceptance just by checking the box, and guards rapid duplicates', async () => {
    const pending = Promise.withResolvers<void>(); h.accept.mockReturnValueOnce(pending.promise);
    render(); await press('I agree to the community rules'); expect(h.accept).not.toHaveBeenCalled();
    const accept = h.buttons.get('Accept community rules')!.onPress; accept(); accept(); h.forms.get('Community rules')!.onClose();
    await flush(); expect(h.accept).toHaveBeenCalledTimes(1); expect(h.close).not.toHaveBeenCalled(); pending.resolve(); await flush();
  });
  it('shows save errors honestly without claiming acceptance', async () => {
    h.accept.mockRejectedValueOnce(new Error('Acceptance could not be confirmed.'));
    render(); await press('I agree to the community rules');
    expect(await press('Accept community rules')).toContain('Acceptance could not be confirmed');
    expect(render()).not.toContain('You’ve accepted');
  });
  it('cannot accept an unseen future version or accept in browser preview', async () => {
    h.status.rulesVersion = 'future'; render(); await press('I agree to the community rules');
    expect(h.buttons.get('Accept community rules')!.disabled).toBe(true); expect(render()).toContain('Update sumore');
    h.status.rulesVersion = '2026-10-12'; h.preview = true; render();
    expect(h.buttons.get('I agree to the community rules')!.disabled).toBe(true);
    expect(h.buttons.get('Accept community rules')!.disabled).toBe(true); expect(h.accept).not.toHaveBeenCalled();
  });
  it('uses the existing keyboard form and one modal for a member report', () => {
    const source = readFileSync(new URL('./report-content-sheet.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<KeyboardTextInput'); expect(source).not.toContain('KeyboardAvoidingView');
    const member = readFileSync(new URL('./circle-member-controls.tsx', import.meta.url), 'utf8');
    expect(member.match(/<FormSheet /g)).toHaveLength(1); expect(member).toContain('<ReportContentForm');
    expect(member).not.toContain('<ReportContentSheet');
  });
});
