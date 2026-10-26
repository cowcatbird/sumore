/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isFriendCodeVisible, toggleFriendCode } from './friend-code-visibility';

describe('friend code disclosure', () => {
  it('starts hidden, reveals on one tap, and hides on the next tap', () => {
    expect(isFriendCodeVisible(null, 'alice', 'ALICE123')).toBe(false);
    const revealed = toggleFriendCode(null, 'alice', 'ALICE123');
    expect(isFriendCodeVisible(revealed, 'alice', 'ALICE123')).toBe(true);
    expect(toggleFriendCode(revealed, 'alice', 'ALICE123')).toBeNull();
  });

  it('never carries a reveal into another account or a changed code', () => {
    const revealed = toggleFriendCode(null, 'alice', 'ALICE123');
    expect(isFriendCodeVisible(revealed, 'bob', 'BOB456')).toBe(false);
    expect(isFriendCodeVisible(revealed, 'bob', 'ALICE123')).toBe(false);
    expect(isFriendCodeVisible(revealed, 'alice', 'NEWCODE')).toBe(false);
  });

  it('does not reveal a missing account or missing code', () => {
    expect(toggleFriendCode(null, '', 'ALICE123')).toBeNull();
    expect(toggleFriendCode(null, 'alice', '')).toBeNull();
  });

  it('removes roster codes and clears the reveal on blur/account change while retaining sharing and joining', () => {
    const ui = readFileSync(new URL('../app/friends.tsx', import.meta.url), 'utf8');
    expect(ui).not.toContain('friend.friendCode');
    expect(ui).not.toContain('personCode');
    expect(ui).not.toContain('see your new code');
    expect(ui).toContain('useState<FriendCodeReveal>(null)');
    expect(ui).toMatch(/useFocusEffect\(useCallback\(\(\) => \{\s*const ownerId = profile\.id;\s*return \(\) => setRevealedCode\(current => current\?\.ownerId === ownerId \? null : current\);\s*\}, \[profile\.id\]\)\)/);
    expect(ui).toContain("{codeVisible ? profile.friendCode : 'Tap to reveal'}");
    expect(ui).toContain('accessibilityValue={codeVisible ? { text: profile.friendCode } : undefined}');
    expect(ui).toContain("accessibilityLabel={codeVisible ? 'Hide your friend code' : 'Show your friend code'}");
    expect(ui).toMatch(/codePlate:\s*\{\s*minHeight: 44/);
    for (const phrase of ['await joinSharedCircle(joinCode)', 'onRequestClose={closeInvite}', 'value={joinCode}']) {
      expect(ui).toContain(phrase);
    }
    expect(ui).not.toMatch(/updateFriendCode|friendCodeDraft|Save code|Changing this disables/);
    expect(ui).toContain('Your permanent friend code. It cannot be changed.');
    expect(ui).toContain('{codeVisible && <FriendCodeActions');
    expect(ui).toContain('<CircleScreen key={profile.id} />');
    const actions = readFileSync(new URL('../components/friend-code-actions.tsx', import.meta.url), 'utf8');
    expect(actions).toContain('<CodeActions key={props.code} {...props} />');
    expect(actions).toContain('await Share.share({');
    expect(actions).toContain('await Clipboard.setStringAsync(code)');
    const requests = readFileSync(new URL('../components/circle-requests.tsx', import.meta.url), 'utf8');
    expect(requests).not.toContain('friend.friendCode');
  });

  it('requires a separate confirmation before moving into another shared circle', () => {
    const ui = readFileSync(new URL('../app/friends.tsx', import.meta.url), 'utf8');
    const confirmation = 'if (!confirmJoin) { setConfirmJoin(true); return; }';
    expect(ui).toContain(confirmation);
    expect(ui.indexOf(confirmation)).toBeLessThan(ui.indexOf('await joinSharedCircle(joinCode)'));
    expect(ui).toContain('Only you will move. Your old circle keeps its s’mores and unlocks.');
    expect(ui).toContain('Stay in my circle');
    expect(ui).toContain('disabled={busy || !circleShop || joinCode.trim().length < 4}');
  });
});
