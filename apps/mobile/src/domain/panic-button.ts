import { demoLimitRemaining, type DemoState } from '@/domain/demo-screen-time';
import type { ScreenTimeStatus } from '@/types/domain';

export const PANIC_MINUTES = 15;

/** Used by both the sheet and the fresh, queued check before spending. */
export function panicButtonBlockReason(status: ScreenTimeStatus, balance: number): string | null {
  if (!status.available) return 'Panic access needs Screen Time on your installed phone app.';
  if (status.supportsPanicGrants !== true) return 'Update the installed app before using panic access.';
  if (!status.authorized) return 'Panic access needs Screen Time access on this phone.';
  if (status.requiresReset) return 'Repair your Screen Time settings before using panic access.';
  if (!status.blockingEnabled) return 'Enable your app limits in Screen Time first.';
  if (status.selection.applications + status.selection.categories + status.selection.webDomains < 1) {
    return 'Choose the apps you want to limit in Screen Time first.';
  }
  if (status.temporaryAccessExpiresAt) return 'Your unrestricted time is already running.';
  if (status.mode === 'daily' && status.dailyLimitReached !== true) {
    return 'Use your remaining screen time before using panic access.';
  }
  if (!Number.isSafeInteger(balance) || balance < 0) return 'Your circle’s balance is unavailable. Refresh and try again.';
  return null;
}

/** Browser-only accounting follows the same eligibility rules, without native access. */
export function previewPanicButtonBlockReason(state: DemoState, balance: number): string | null {
  if (!state.enabled || !state.apps.length) return 'Set up a daily allowance in Screen Time first.';
  if (demoLimitRemaining(state) > 0) return 'Use your remaining screen time before using panic access.';
  if (!Number.isSafeInteger(balance) || balance < 0) return 'Your circle’s balance is unavailable. Refresh and try again.';
  return null;
}
