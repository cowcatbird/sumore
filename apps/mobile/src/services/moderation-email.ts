import * as MailComposer from 'expo-mail-composer';
import { Linking, Platform } from 'react-native';

import { isModerationId, isReportReason, type ReportReason } from '@/domain/moderation';
import type { ReportEmailResult } from '@/services/feedback';
export type { ReportEmailResult } from '@/services/feedback';

export const COMMUNITY_REPORT_ADDRESS = 'cowcatbird.dev@gmail.com';
export const COMMUNITY_REPORT_SUBJECT = '[Community report] sumore';
export type CommunityReportEmailInput = {
  reportId: string; targetDisplayName: string; kind: 'person' | 'request'; reason: ReportReason; details: string;
};
const labels: Record<ReportReason, string> = {
  offensive_content: 'Offensive content', harassment: 'Harassment or threats', spam: 'Spam', other: 'Other concern',
};

export function communityReportEmail(input: CommunityReportEmailInput) {
  if (!isModerationId(input.reportId) || !isReportReason(input.reason)
    || (input.kind !== 'person' && input.kind !== 'request') || !input.targetDisplayName.trim()
    || [...input.targetDisplayName].length > 60 || [...input.details.trim()].length > 500) {
    throw new Error('Reopen the report form before preparing an email.');
  }
  return {
    recipients: [COMMUNITY_REPORT_ADDRESS], subject: COMMUNITY_REPORT_SUBJECT, isHtml: false as const,
    body: `I would like to report a community concern in sumore.\n\nReport reference: ${input.reportId}\nReported camper: ${input.targetDisplayName}\nReported content: ${input.kind === 'request' ? 'Request' : 'Name or shared app labels'}\nConcern: ${labels[input.reason]}\n\n${input.details.trim() || 'No additional details.'}\n\n---\nThis report’s original context was saved privately in sumore. Please verify that record before taking action; this email draft can be edited.\nDo not include private login keys.`,
  };
}

/** User reviews and taps Send. No automatic sender, retries or inbox-delivery claims. */
export async function openCommunityReportEmail(input: CommunityReportEmailInput, isCurrent = () => true): Promise<ReportEmailResult> {
  const email = communityReportEmail(input);
  const changedAccount = 'Your account or circle changed. Close this form before preparing an email.';
  if (!isCurrent()) throw new Error(changedAccount);
  try {
    const available = Platform.OS !== 'web' && await MailComposer.isAvailableAsync().catch(() => false);
    if (!isCurrent()) throw new Error(changedAccount);
    if (available) {
      const { status } = await MailComposer.composeAsync(email);
      // Android SENT only means the chooser was opened, including cancellation.
      if (Platform.OS === 'ios') {
        if (status === MailComposer.MailComposerStatus.CANCELLED) return 'cancelled';
        if (status === MailComposer.MailComposerStatus.SAVED) return 'saved';
        if (status === MailComposer.MailComposerStatus.SENT) return 'accepted';
      }
    } else {
      await Linking.openURL(`mailto:${COMMUNITY_REPORT_ADDRESS}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`);
    }
    return 'opened';
  } catch {
    if (!isCurrent()) throw new Error(changedAccount);
    throw new Error('Your report was saved, but an email could not be opened. Copy the report and email cowcatbird.dev@gmail.com.');
  }
}
