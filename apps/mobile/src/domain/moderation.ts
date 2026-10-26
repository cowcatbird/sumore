export const COMMUNITY_RULES_VERSION = '2026-10-12';
export const REPORT_REASONS = ['offensive_content', 'harassment', 'spam', 'other'] as const;
export type ReportReason = typeof REPORT_REASONS[number];
export const MODERATION_ACTIONS = ['dismiss', 'remove_content', 'warn', 'restrict', 'restore'] as const;
export type ModerationAction = typeof MODERATION_ACTIONS[number];
export type ReportStatus = 'open' | 'resolved' | 'dismissed';

export type ModerationStatus = {
  rulesVersion: string;
  acceptedRulesVersion: string | null;
  isModerator: boolean;
  restriction: null | { reason: string; until: string | null; createdAt: string };
  notices: { id: string; message: string; createdAt: string }[];
};
export type ModerationReport = {
  id: string;
  targetUserId: string | null;
  targetDisplayName: string;
  kind: 'person' | 'request';
  reason: ReportReason;
  details: string;
  snapshot: {
    displayName: string;
    requestReason?: string | null;
    requestCategoryLabel?: string | null;
    sharedLabels?: { label: string; minutes: number }[];
  };
  status: ReportStatus;
  createdAt: string;
  version: number;
  action?: ModerationAction | null;
};

export const isModerationId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 500): value is string => typeof value === 'string' && [...value].length <= max;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const invalid = () => new Error('Community information could not be verified. Refresh and try again.');
export const isReportStatus = (value: unknown): value is ReportStatus => value === 'open' || value === 'resolved' || value === 'dismissed';
export const isModerationAction = (value: unknown): value is ModerationAction => MODERATION_ACTIONS.includes(value as ModerationAction);
export const isReportReason = (value: unknown): value is ReportReason => REPORT_REASONS.includes(value as ReportReason);

/** Return only the fields needed by the UI; never forward incidental private data. */
export function parseModerationStatus(value: unknown): ModerationStatus {
  if (!record(value) || !text(value.rulesVersion, 40) || !value.rulesVersion
    || !(value.acceptedRulesVersion === null || text(value.acceptedRulesVersion, 40))
    || typeof value.isModerator !== 'boolean' || !Array.isArray(value.notices)) throw invalid();
  let restriction: ModerationStatus['restriction'] = null;
  if (value.restriction !== null) {
    const r = value.restriction;
    if (!record(r) || !text(r.reason) || !date(r.createdAt) || !(r.until === null || date(r.until))) throw invalid();
    restriction = { reason: r.reason, until: r.until, createdAt: r.createdAt };
  }
  const seen = new Set<string>();
  const notices = value.notices.map(n => {
    if (!record(n) || !isModerationId(n.id) || seen.has(n.id) || !text(n.message) || !date(n.createdAt)) throw invalid();
    seen.add(n.id);
    return { id: n.id, message: n.message, createdAt: n.createdAt };
  });
  return { rulesVersion: value.rulesVersion, acceptedRulesVersion: value.acceptedRulesVersion,
    isModerator: value.isModerator, restriction, notices };
}

export function parseModerationQueue(value: unknown): ModerationReport[] {
  if (!Array.isArray(value)) throw invalid();
  const seen = new Set<string>();
  return value.map(r => {
    if (!record(r) || !isModerationId(r.id) || seen.has(r.id)
      || !(r.targetUserId === null || isModerationId(r.targetUserId)) || !text(r.targetDisplayName, 60)
      || (r.kind !== 'person' && r.kind !== 'request') || !isReportReason(r.reason) || !text(r.details)
      || !isReportStatus(r.status) || !date(r.createdAt) || !Number.isSafeInteger(r.version) || Number(r.version) < 1
      || !(r.action === undefined || r.action === null || isModerationAction(r.action))
      || !record(r.snapshot) || !text(r.snapshot.displayName, 60)) throw invalid();
    seen.add(r.id);
    const snapshot: ModerationReport['snapshot'] = { displayName: r.snapshot.displayName };
    for (const key of ['requestReason', 'requestCategoryLabel'] as const) {
      const field = r.snapshot[key];
      if (field !== undefined) {
        if (field !== null && !text(field, 1000)) throw invalid();
        snapshot[key] = field;
      }
    }
    if (r.snapshot.sharedLabels !== undefined) {
      if (!Array.isArray(r.snapshot.sharedLabels) || r.snapshot.sharedLabels.length > 50) throw invalid();
      snapshot.sharedLabels = r.snapshot.sharedLabels.map((entry: unknown) => {
        if (!record(entry) || !text(entry.label, 32) || !Number.isInteger(entry.minutes) || Number(entry.minutes) < 1 || Number(entry.minutes) > 1440) throw invalid();
        return { label: entry.label, minutes: Number(entry.minutes) };
      });
    }
    return { id: r.id, targetUserId: r.targetUserId, targetDisplayName: r.targetDisplayName,
      kind: r.kind, reason: r.reason, details: r.details, snapshot, status: r.status, createdAt: r.createdAt,
      version: Number(r.version), action: r.action as ModerationReport['action'] };
  });
}
