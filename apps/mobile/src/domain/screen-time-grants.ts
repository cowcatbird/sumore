/** A server-created, fixed-expiry permission. Never turn minutes into a new timer. */
export type ScreenTimeGrant = {
  grantId: string;
  requesterId: string;
  /** Null for a panic grant: nobody approved it, so no request stands behind it. */
  requestId: string | null;
  source: 'request' | 'panic';
  startedAt: string;
  expiresAt: string;
  serverNow: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function parseScreenTimeGrant(value: unknown): ScreenTimeGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The server returned an invalid Screen Time grant.');
  const grant = value as Record<string, unknown>;
  for (const key of ['grantId', 'requesterId']) {
    if (typeof grant[key] !== 'string' || !uuid.test(grant[key])) throw new Error('The Screen Time grant is missing its verified identity.');
  }
  // An older server omits source entirely; those grants are request grants.
  const source = grant.source === undefined ? 'request' : grant.source;
  if (source !== 'request' && source !== 'panic') throw new Error('The Screen Time grant has an unknown source.');
  // A request grant must still name its approval. Only panic may stand alone,
  // so a malformed or missing request id cannot be laundered into an unlock.
  if (source === 'request') {
    if (typeof grant.requestId !== 'string' || !uuid.test(grant.requestId)) throw new Error('The Screen Time grant is missing its verified identity.');
  } else if (grant.requestId !== null && grant.requestId !== undefined) {
    throw new Error('A panic grant cannot carry an approved request.');
  }
  for (const key of ['startedAt', 'expiresAt', 'serverNow']) {
    if (typeof grant[key] !== 'string' || !timestamp.test(grant[key]) || !Number.isFinite(Date.parse(grant[key]))) {
      throw new Error('The Screen Time grant is missing its fixed expiry.');
    }
  }
  const started = Date.parse(grant.startedAt as string);
  const expires = Date.parse(grant.expiresAt as string);
  const now = Date.parse(grant.serverNow as string);
  const allowedDurations = source === 'panic' ? [15 * 60_000] : [15 * 60_000, 30 * 60_000];
  if (!allowedDurations.includes(expires - started) || now < started) {
    throw new Error('The Screen Time grant has an unsupported time window.');
  }
  return {
    grantId: grant.grantId as string, requesterId: grant.requesterId as string,
    requestId: source === 'request' ? (grant.requestId as string) : null,
    source, startedAt: grant.startedAt as string,
    expiresAt: grant.expiresAt as string, serverNow: grant.serverNow as string,
  };
}
