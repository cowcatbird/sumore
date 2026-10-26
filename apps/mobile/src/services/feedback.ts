import Constants from 'expo-constants';
import * as MailComposer from 'expo-mail-composer';
import { Linking, Platform } from 'react-native';

export const FEEDBACK_ADDRESS = 'cowcatbird.dev@gmail.com';
export const FEEDBACK_SUBJECT = '[Report a problem] sumore';
export type ReportEmailResult = 'opened' | 'cancelled' | 'saved' | 'accepted';

export function problemReportEmail(message: string) {
  const text = message.trim();
  if (text.length < 10 || text.length > 4000) throw new Error('Write between 10 and 4,000 characters.');
  return {
    recipients: [FEEDBACK_ADDRESS],
    subject: FEEDBACK_SUBJECT,
    body: `${text}\n\n---\nsumore ${Constants.expoConfig?.version ?? 'unknown'} · ${Platform.OS}`,
    isHtml: false,
  };
}

/** Opens a user-reviewed draft. Never sends through a server or retries a send. */
export async function openProblemReportEmail(message: string): Promise<ReportEmailResult> {
  const email = problemReportEmail(message);
  try {
    const available = Platform.OS !== 'web' && await MailComposer.isAvailableAsync().catch(() => false);
    if (available) {
      const { status } = await MailComposer.composeAsync(email);
      // Android always reports SENT, even when the user cancels the intent.
      if (Platform.OS === 'ios') {
        if (status === MailComposer.MailComposerStatus.CANCELLED) return 'cancelled';
        if (status === MailComposer.MailComposerStatus.SAVED) return 'saved';
        if (status === MailComposer.MailComposerStatus.SENT) return 'accepted';
      }
    } else {
      // Also supports iPhones using Gmail/default mail without Apple Mail configured.
      await Linking.openURL(`mailto:${FEEDBACK_ADDRESS}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}`);
    }
    return 'opened';
  } catch {
    throw new Error('Could not open an email app. Copy your report and email it to cowcatbird.dev@gmail.com.');
  }
}
