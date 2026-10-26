/** Webhook contents are hints only. Current SQL policy authorizes each batch. */
type NotificationContext = {
  requestId: string; status: 'pending' | 'approved' | 'denied'; minutes: number;
  requesterName: string; deciderName: string | null; tokens: string[];
};
export type PushMessage = { to: string; sound: string; title: string; body: string; data: Record<string, string> };
type PanicContext = { panicId: string; actorName: string; tokens: string[] };
type Dependencies = {
  secret: string | undefined;
  context(requestId: string, status: string): Promise<unknown>;
  /** Absent on a server whose database predates the panic button. */
  panicContext?(panicId: string): Promise<unknown>;
  send(messages: PushMessage[]): Promise<void>;
};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

function validatedContext(raw: unknown, requestId: string, status: string): NotificationContext | null {
  if (raw === null) return null;
  if (!record(raw) || raw.requestId !== requestId || raw.status !== status || !Number.isInteger(raw.minutes) || Number(raw.minutes) < 1 || Number(raw.minutes) > 1440
    || typeof raw.requesterName !== 'string' || !raw.requesterName.trim() || (raw.deciderName !== null && typeof raw.deciderName !== 'string')
    || !Array.isArray(raw.tokens) || raw.tokens.some(token => typeof token !== 'string')) throw new Error('Invalid notification context');
  return { requestId, status: raw.status as NotificationContext['status'], minutes: Number(raw.minutes), requesterName: raw.requesterName,
    deciderName: raw.deciderName, tokens: [...new Set(raw.tokens as string[])].filter(token => token.length <= 256 && /^Expo(nent)?PushToken\[[^\]\s]+\]$/.test(token)) };
}

function validatedPanicContext(raw: unknown, panicId: string): PanicContext | null {
  if (raw === null) return null;
  if (!record(raw) || raw.panicId !== panicId || typeof raw.actorName !== 'string' || !raw.actorName.trim()
    || !Array.isArray(raw.tokens) || raw.tokens.some(token => typeof token !== 'string')) throw new Error('Invalid notification context');
  return {
    panicId, actorName: raw.actorName,
    tokens: [...new Set(raw.tokens as string[])].filter(token => token.length <= 256 && /^Expo(nent)?PushToken\[[^\]\s]+\]$/.test(token)),
  };
}

async function body(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Invalid body');
  let size = 0; let text = ''; const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      size += value.byteLength;
      if (size > 65_536) { await reader.cancel(); throw new Error('Invalid body'); }
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
}

export function createPushHandler(deps: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (!deps.secret || request.headers.get('x-webhook-secret') !== deps.secret) return json({ error: 'Unauthorized.' }, 401);
    let payload: unknown;
    try { payload = await body(request); } catch { return json({ error: 'Invalid webhook.' }, 400); }
    if (!record(payload) || !record(payload.record)) return json({ sent: 0 });

    // The panic button alerts the circle even when its wallet was already empty.
    // It is its own table and its own single message: there is no pending or
    // decided state to track, and nothing for a recipient to answer.
    if (payload.table === 'panic_events') {
      const panic = payload.record;
      if (payload.type !== 'INSERT') return json({ sent: 0 });
      if (typeof panic.id !== 'string' || !uuid.test(panic.id)) return json({ error: 'Invalid webhook.' }, 400);
      if (!deps.panicContext) return json({ sent: 0 });
      try {
        const context = validatedPanicContext(await deps.panicContext(panic.id), panic.id);
        if (!context?.tokens.length) return json({ sent: 0 });
        await deps.send(context.tokens.slice(0, 100).map(to => ({
          to, sound: 'default',
          title: 'ALERT!',
          body: `${context.actorName} has used the panic button.`,
          data: { url: '/', panicId: context.panicId },
        } as PushMessage)));
        return json({ sent: Math.min(context.tokens.length, 100) });
      } catch {
        return json({ error: 'Notification delivery could not be confirmed.' }, 500);
      }
    }

    if (payload.table !== 'time_requests') return json({ sent: 0 });
    const event = payload.record;
    if (typeof event.id !== 'string' || !uuid.test(event.id)) return json({ error: 'Invalid webhook.' }, 400);
    const pending = payload.type === 'INSERT' && event.status === 'pending';
    const decided = payload.type === 'UPDATE' && record(payload.old_record) && payload.old_record.status === 'pending' &&
      (event.status === 'approved' || event.status === 'denied');
    if (!pending && !decided) return json({ sent: 0 });
    const status = event.status as string;
    const sent = new Set<string>();
    try {
      // Recheck before every batch. Already-dispatched external pushes cannot
      // be recalled from Expo/APNs/FCM or a phone's notification center.
      for (;;) {
        const context = validatedContext(await deps.context(event.id, status), event.id, status);
        if (!context) break;
        const tokens = context.tokens.filter(token => !sent.has(token)).slice(0, 100);
        if (!tokens.length) break;
        const approved = context.status === 'approved';
        const messages = tokens.map(to => ({
          to, sound: 'default',
          title: context.status === 'pending' ? `${context.requesterName} is asking` : approved ? `${context.deciderName ?? 'A friend'} approved` : 'Not this time',
          body: context.status === 'pending' ? `Approve or deny ${context.minutes} more minutes.` : approved ? `You have ${context.minutes} more minutes.` : `${context.deciderName ?? 'A friend'} helped you stick with your limit.`,
          data: context.status === 'pending' ? { url: '/requests', requestId: context.requestId } : { url: '/', requestId: context.requestId, decision: context.status },
        } as PushMessage));
        await deps.send(messages);
        tokens.forEach(token => sent.add(token));
      }
      return json({ sent: sent.size });
    } catch {
      // Do not log private push tokens, IDs, webhook contents or SDK errors.
      return json({ error: 'Notification delivery could not be confirmed.' }, 500);
    }
  };
}
