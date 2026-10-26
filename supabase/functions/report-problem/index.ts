import { createClient } from 'jsr:@supabase/supabase-js@2.115.0';
import { createFeedbackHandler } from './core.ts';

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const apiKey = Deno.env.get('RESEND_API_KEY');
const sender = Deno.env.get('FEEDBACK_FROM') ?? '';

Deno.serve(createFeedbackHandler({
  configured: Boolean(url && serviceKey && apiKey && sender),
  sender,
  async authenticate(token) {
    const admin = createClient(url!, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.auth.getUser(token);
    return error ? null : data.user;
  },
  async rpc(name, args) {
    const admin = createClient(url!, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.rpc(name, args);
    if (error) throw new Error('Report operation failed');
    return data;
  },
  async send(input) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({ from: input.from, to: [input.to], subject: input.subject, text: input.text }),
    });
    if (!response.ok) throw new Error('Email delivery unavailable');
    const result = await response.json();
    if (!result || typeof result.id !== 'string') throw new Error('Email delivery unavailable');
    return { id: result.id };
  },
}));
