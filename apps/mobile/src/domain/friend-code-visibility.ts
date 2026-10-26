export type FriendCodeReveal = { ownerId: string; code: string } | null;

/** A reveal belongs to one account and one version of its code. Never persist it. */
export function isFriendCodeVisible(reveal: FriendCodeReveal, ownerId: string, code: string): boolean {
  return !!ownerId && !!code && reveal?.ownerId === ownerId && reveal.code === code;
}

export function toggleFriendCode(reveal: FriendCodeReveal, ownerId: string, code: string): FriendCodeReveal {
  return !ownerId || !code || isFriendCodeVisible(reveal, ownerId, code) ? null : { ownerId, code };
}
