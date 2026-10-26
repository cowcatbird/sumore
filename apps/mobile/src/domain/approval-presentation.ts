import type { RecentDecision, ScreenTimeStatus } from '@/types/domain';

/** Only a matching native receipt can claim that this request unlocked apps. */
export function approvalMessage(decision: NonNullable<RecentDecision>, status: ScreenTimeStatus, now = Date.now()): string {
  if (decision.status !== 'approved') return 'Request declined.';
  if (!status.available) return `${decision.minutes} minutes approved. Open the installed app to apply them.`;
  if (status.appliedRequestId === decision.id && status.appliedGrantId && !status.shielded && status.temporaryAccessExpiresAt && Date.parse(status.temporaryAccessExpiresAt) > now) {
    return `${decision.minutes} extra minutes unlocked. Until ${new Date(status.temporaryAccessExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  }
  if (!status.authorized || !status.blockingEnabled || status.requiresReset) return `${decision.minutes} minutes approved. Enable your app limit in Screen Time to use them.`;
  if (status.mode === 'daily' && !status.dailyLimitReached && !status.temporaryAccessExpiresAt) return `${decision.minutes} minutes approved. Open sumore when your limit is reached to use them.`;
  // An expired receipt and one not yet delivered look alike here. Do not show
  // an endless spinner or infer a new unlock from an old approval.
  return `${decision.minutes} minutes approved. Unused extra time applies automatically while sumore is open.`;
}
