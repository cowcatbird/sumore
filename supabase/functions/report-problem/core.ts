// Dependency-injected so authentication, failure/retry and privacy rules can be
// tested without connecting to Supabase or sending real email.
export type FeedbackInput = { id: string; message: string; platform: string; appVersion: string };
export type FeedbackDependencies = {
  configured: boolean;
  sender: string;
  authenticate(token: string): Promise<{ id: string } | null>;
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  send(input: { from: string; to: string; subject: string; text: string; idempotencyKey: string }): Promise<{ id: string }>;
};
const recipient = 'cowcatbird.dev@gmail.com';
const subject = '[Report a problem] sumore';
const unavailable = 'Reports are unavailable right now. Please try again later.';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maximumBytes = 12 * 1024;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
const object = (input: unknown): Record<string, unknown> | null => input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null;
class InvalidBody extends Error {}

async function boundedBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > maximumBytes) throw new InvalidBody();
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new InvalidBody();
  const reader = request.body?.getReader();
  if (!reader) throw new InvalidBody();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) { await reader.cancel(); throw new InvalidBody(); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result)); }
  catch { throw new InvalidBody(); }
}

function validate(value: unknown): FeedbackInput | null {
  const input = object(value);
  if (!input || Object.keys(input).sort().join(',') !== 'appVersion,id,message,platform') return null;
  if (typeof input.id !== 'string' || !uuid.test(input.id) || typeof input.message !== 'string') return null;
  const message = input.message.trim();
  const length = Array.from(message).length;
  if (length < 10 || length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(message)) return null;
  if (typeof input.platform !== 'string' || !['ios', 'android', 'web'].includes(input.platform)) return null;
  if (typeof input.appVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,63}$/.test(input.appVersion)) return null;
  return { id: input.id.toLowerCase(), message, platform: input.platform, appVersion: input.appVersion };
}

export function createFeedbackHandler(deps: FeedbackDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    // No reservation, quota consumption or persisted report without configured
    // provider credentials. No client/provider errors or secrets are echoed.
    if (!deps.configured || !deps.sender || /[\r\n]/.test(deps.sender)) return json({ error: unavailable }, 503);
    const token = request.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) return json({ error: 'Sign in to sumore first.' }, 401);
    let reservation: { actor_id: string; report_id: string; lease_id: string } | null = null;
    try {
      const actor = await deps.authenticate(token);
      if (!actor || !uuid.test(actor.id)) return json({ error: 'Sign in to sumore first.' }, 401);
      const input = validate(await boundedBody(request));
      if (!input) return json({ error: 'Enter a report of 10 to 4000 characters.' }, 400);
      const prepared = object(await deps.rpc('feedback_reserve', {
        actor_id: actor.id, report_id: input.id, report_message: input.message,
        report_platform: input.platform, report_version: input.appVersion, sender: deps.sender,
      }));
      if (prepared?.state === 'sent') return json({ sent: true, reportId: input.id });
      if (prepared?.state === 'rateLimited') return json({ error: 'Too many reports. Please try again later.' }, 429);
      if (prepared?.state === 'conflict') return json({ error: 'This report changed. Start a new report.' }, 409);
      if (prepared?.state === 'expired') return json({ error: 'This report could not be confirmed. Please contact support before resending.' }, 409);
      if (prepared?.state !== 'ready' || typeof prepared.leaseId !== 'string' || !uuid.test(prepared.leaseId)
        || typeof prepared.sender !== 'string' || prepared.sender.length > 200 || /[\r\n]/.test(prepared.sender)) return json({ error: unavailable }, 503);
      reservation = { actor_id: actor.id, report_id: input.id, lease_id: prepared.leaseId };
      const delivered = await deps.send({
        from: prepared.sender, to: recipient, subject,
        text: `Report: ${input.id}\nAccount: ${actor.id}\nPlatform: ${input.platform}\nVersion: ${input.appVersion}\n\n${input.message}`,
        idempotencyKey: `sumore-feedback/${actor.id.toLowerCase()}/${input.id}`,
      });
      if (!delivered || !uuid.test(delivered.id)) throw new Error('Provider did not confirm acceptance');
      if (await deps.rpc('feedback_finish', { ...reservation, provider_id: delivered.id }) !== true) throw new Error('Report not confirmed');
      return json({ sent: true, reportId: input.id });
    } catch (error) {
      if (reservation) {
        try { await deps.rpc('feedback_release', reservation); } catch { /* Safe retry uses the same provider idempotency key. */ }
      }
      return error instanceof InvalidBody ? json({ error: 'Invalid report.' }, 400) : json({ error: unavailable }, 503);
    }
  };
}
