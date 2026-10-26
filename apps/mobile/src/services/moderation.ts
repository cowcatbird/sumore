import { withAccountTimeout } from '@/lib/account-timeout';
import { requireSupabase } from '@/lib/supabase';
import {
  COMMUNITY_RULES_VERSION, isModerationId, isModerationAction, isReportReason, isReportStatus,
  parseModerationQueue, parseModerationStatus,
  type ModerationAction, type ReportReason, type ReportStatus,
} from '@/domain/moderation';
export { COMMUNITY_RULES_VERSION } from '@/domain/moderation';
export type { ModerationStatus, ModerationReport, ModerationAction, ReportReason, ReportStatus } from '@/domain/moderation';

const changedAccount = 'Your account changed. Reopen this screen before trying again.';
const uncertain = 'The result could not be confirmed. Refresh before trying again.';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function id(value: string) { if (!isModerationId(value)) throw new Error('Refresh your account before trying again.'); }
function note(value: string) {
  const clean = value.trim();
  if ([...clean].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(clean)) throw new Error('Use at most 500 characters without unsupported control characters.');
  return clean;
}

/** Session checked on both sides; SQL independently checks expected_user_id. No mutation retries. */
async function call(name: string, ownerId: string, args: Record<string, unknown> = {}): Promise<unknown> {
  id(ownerId);
  const client = requireSupabase();
  const verify = async () => {
    const { data, error } = await withAccountTimeout(client.auth.getSession(), changedAccount);
    if (error || data.session?.user.id !== ownerId) throw new Error(changedAccount);
  };
  await verify();
  const { data, error } = await withAccountTimeout(client.rpc(name, { ...args, expected_user_id: ownerId }), uncertain);
  await verify();
  if (error?.code === 'PGRST202') throw new Error('Community controls need a server update. You can still use personal screen-time controls and account deletion.');
  if (error) throw new Error(error.message || uncertain);
  return data;
}

export async function getModerationStatus(ownerId: string) {
  return parseModerationStatus(await call('get_my_moderation_status', ownerId));
}

export async function acceptCommunityRules(ownerId: string, version: string) {
  // Never accept a future policy the installed app has not actually displayed.
  if (version !== COMMUNITY_RULES_VERSION) throw new Error('Update sumore to read and accept the latest community rules.');
  const status = parseModerationStatus(await call('accept_community_rules', ownerId, { rules_version: version }));
  if (status.acceptedRulesVersion !== version) throw new Error(uncertain);
  return status;
}

export async function reportCircleContent(ownerId: string, groupId: string, input: {
  targetUserId: string; targetRequestId?: string | null; reason: ReportReason; details: string; clientReportId: string;
}): Promise<{ reportId: string; status: 'received' }> {
  id(groupId); id(input.targetUserId); id(input.clientReportId);
  if (input.targetUserId === ownerId) throw new Error('You cannot report yourself.');
  if (input.targetRequestId != null) id(input.targetRequestId);
  if (!isReportReason(input.reason)) throw new Error('Choose a report reason.');
  const result = await call('submit_circle_report', ownerId, {
    expected_group_id: groupId, target_user_id: input.targetUserId, target_request_id: input.targetRequestId ?? null,
    reason: input.reason, details: note(input.details), client_report_id: input.clientReportId,
  });
  if (!record(result) || !isModerationId(result.reportId) || result.status !== 'received') throw new Error(uncertain);
  return { reportId: result.reportId, status: 'received' };
}

export async function getModerationQueue(ownerId: string, statusFilter: ReportStatus = 'open', cursor?: { createdAt: string; id: string }) {
  if (!isReportStatus(statusFilter)) throw new Error('Choose a report status.');
  if (cursor) {
    id(cursor.id);
    if (!Number.isFinite(Date.parse(cursor.createdAt))) throw new Error('Refresh the report list before continuing.');
  }
  return parseModerationQueue(await call('get_moderation_queue', ownerId, { status_filter: statusFilter,
    ...(cursor ? { after_created_at: cursor.createdAt, after_id: cursor.id } : {}) }));
}

export async function reviewModerationReport(ownerId: string, input: {
  reportId: string; expectedVersion: number; action: ModerationAction; moderatorNote: string; restrictionDays?: number | null;
}): Promise<{ reportId: string; status: ReportStatus; version: number }> {
  id(input.reportId);
  const clean = note(input.moderatorNote);
  if (!isModerationAction(input.action) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('Refresh the report before reviewing it.');
  if (['warn', 'restrict', 'restore'].includes(input.action) && !clean) throw new Error('Explain this decision to the camper.');
  const days = input.restrictionDays ?? null;
  if (input.action === 'restrict' ? !Number.isInteger(days) || Number(days) < 1 || Number(days) > 365 : days !== null) throw new Error('Choose a valid restriction duration.');
  const result = await call('review_moderation_report', ownerId, {
    report_id: input.reportId, expected_version: input.expectedVersion, action: input.action,
    moderator_note: clean, restriction_days: days,
  });
  if (!record(result) || result.reportId !== input.reportId || !isReportStatus(result.status)
    || !Number.isSafeInteger(result.version) || Number(result.version) !== input.expectedVersion + 1) throw new Error(uncertain);
  return { reportId: result.reportId, status: result.status, version: Number(result.version) };
}
