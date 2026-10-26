// No request body, credentials, OTP, or session is ever logged here.
// This module is dependency-injected for offline security regression tests.
export type AccessUser = {
  id: string;
  email?: string;
  is_anonymous?: boolean;
  app_metadata?: Record<string, unknown>;
  factors?: { status: string }[];
};
export type RecoverySession = { access_token: string; refresh_token: string; user: { id: string } };
export type AccessDependencies = {
  authenticate(token: string): Promise<AccessUser | null>;
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  getUser(id: string): Promise<AccessUser | null>;
  attachRecoveryIdentity(user: AccessUser, email: string): Promise<AccessUser>;
  createSession(user: AccessUser): Promise<RecoverySession>;
  deleteAccount(token: string): Promise<void>;
  ipHash(request: Request): Promise<string>;
};

const invalidKey = 'That login key could not be used. Check it and try again.';
const unavailable = 'Account access is unavailable. Please try again.';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache',
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: cors });
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function normalizeLoginKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 160) return null;
  const compact = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^SUMORE[0-9A-F]{48}$/.test(compact)) return null;
  return `SUMORE-${compact.slice(6).match(/.{6}/g)!.join('-')}`;
}

export function createLoginKey(): string {
  // 24 CSPRNG bytes = 192 bits, not Math.random/UUID or the public friend code.
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `SUMORE-${hex.match(/.{6}/g)!.join('-')}`;
}

export async function hashSecret(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function boundedBody(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  let length = 0;
  let text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      length += value.byteLength;
      if (length > 2048) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export function createAccountAccessHandler(deps: AccessDependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    const bearer = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (!bearer) return json({ error: 'Sign in to sumore first.' }, 401);
    let operation = '';
    try {
      // Validate with Auth, not a locally decoded/unverified JWT.
      const actor = await deps.authenticate(bearer);
      if (!actor) return json({ error: 'Sign in to sumore first.' }, 401);
      const text = await boundedBody(request);
      if (text === null) return json({ error: 'Invalid request.' }, 400);
      let body: Record<string, unknown> | null;
      try { body = record(JSON.parse(text)); } catch { return json({ error: 'Invalid request.' }, 400); }
      operation = typeof body?.action === 'string' ? body.action : '';
      if (!['status', 'create', 'revoke', 'recover', 'finish', 'delete'].includes(operation)) return json({ error: 'Invalid request.' }, 400);
      const allowed = await deps.rpc('account_access_allow', {
        actor_id: actor.id, ip_hash: await deps.ipHash(request), operation,
      });
      if (allowed !== true) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);

      if (operation === 'delete') {
        // The existing owner-only SQL RPC locks/settles the group before the
        // actual auth.users deletion. No client-supplied user ID is accepted.
        await deps.deleteAccount(bearer);
        return json({ deleted: true });
      }

      if (operation === 'status') {
        const key = normalizeLoginKey(body?.key);
        const status = record(await deps.rpc('account_key_status', {
          actor_id: actor.id, candidate_hash: key ? await hashSecret(key) : null,
        }));
        return json({ hasKey: status?.hasKey === true, matches: status?.matches === true });
      }
      if (operation === 'revoke') {
        await deps.rpc('account_revoke_key', { actor_id: actor.id });
        return json({ revoked: true });
      }
      if (operation === 'create') {
        if (actor.factors?.some(factor => factor.status === 'verified')) return json({ error: 'Login keys are unavailable for accounts with two-factor authentication.' }, 409);
        let identity = actor;
        if (!identity.email) {
          // Re-read so an email linked since bearer verification is preserved.
          const current = await deps.getUser(actor.id);
          if (!current || current.id !== actor.id) throw new Error('Identity unavailable');
          if (current.factors?.some(factor => factor.status === 'verified')) return json({ error: 'Login keys are unavailable for accounts with two-factor authentication.' }, 409);
          identity = current;
        }
        if (!identity.email) {
          if (!identity.is_anonymous) return json({ error: unavailable }, 409);
          // Supabase cannot issue a refreshable session for an identity-less
          // anonymous user. This opaque, non-deliverable address is stable for
          // the SAME UUID, so concurrent first-key creation cannot cross two
          // different identities. It is an identifier, never a login secret.
          const email = `${await hashSecret(`sumore-private-identity-v1:${actor.id}`)}@accounts.sumore.invalid`;
          identity = await deps.attachRecoveryIdentity(identity, email);
          if (identity.id !== actor.id || identity.email !== email) throw new Error('Identity mismatch');
        }
        const key = createLoginKey();
        await deps.rpc('account_store_key', {
          actor_id: actor.id, new_hash: await hashSecret(key), identity_email: identity.email,
        });
        return json({ key });
      }
      if (operation === 'finish') {
        const ticket = normalizeLoginKey(body?.ticket);
        if (!ticket) return json({ previousKeyRevoked: false });
        const finished = await deps.rpc('account_finish_transfer', {
          actor_id: actor.id, candidate_ticket_hash: await hashSecret(ticket),
        });
        return json({ previousKeyRevoked: finished === true });
      }

      // Invalid syntax, missing keys, missing identities and revoked accounts
      // all receive the SAME response. Even invalid syntax uses the limiter.
      const key = normalizeLoginKey(body?.key);
      if (!key) return json({ error: invalidKey }, 400);
      const found = record(await deps.rpc('account_lookup_key', { candidate_hash: await hashSecret(key) }));
      if (typeof found?.userId !== 'string' || typeof found.email !== 'string') return json({ error: invalidKey }, 400);
      const target = await deps.getUser(found.userId);
      if (!target || target.email !== found.email || target.factors?.some(factor => factor.status === 'verified')) return json({ error: invalidKey }, 400);
      // Capture the source key before the potentially slow Auth exchange. A
      // source rotation during recovery must not be revoked by late cleanup.
      const ticket = createLoginKey();
      const needsFinish = await deps.rpc('account_prepare_transfer', {
        actor_id: actor.id, target_id: target.id, new_ticket_hash: await hashSecret(ticket),
      });
      const session = await deps.createSession(target);
      if (session.user.id !== target.id || !session.access_token || !session.refresh_token) throw new Error('Session mismatch');
      // A rotation/revocation racing the Auth operation must invalidate this
      // recovery attempt before any session credentials leave the edge.
      const current = record(await deps.rpc('account_key_status', { actor_id: target.id, candidate_hash: await hashSecret(key) }));
      if (current?.matches !== true) return json({ error: invalidKey }, 400);
      return json({ userId: target.id, accessToken: session.access_token, refreshToken: session.refresh_token,
        cleanupTicket: needsFinish === true ? ticket : null });
    } catch {
      return operation === 'recover' ? json({ error: invalidKey }, 400) : json({ error: unavailable }, 503);
    }
  };
}
