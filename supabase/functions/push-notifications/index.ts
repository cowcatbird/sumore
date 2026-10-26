import { createClient } from 'jsr:@supabase/supabase-js@2.115.0';
import { createPushHandler } from './core.ts';

const expoPushEndpoint = 'https://exp.host/--/api/v2/push/send';

Deno.serve(async request => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const secret = Deno.env.get('DATABASE_WEBHOOK_SECRET');
  // Authenticate before creating an SDK client or querying recipient data.
  // Missing migration fails closed: never fall back to unfiltered recipients.
  return createPushHandler({
    secret,
    context: async (requestId, status) => {
      if (!supabaseUrl || !serviceRoleKey) throw new Error('Missing server configuration');
      const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await admin.rpc('circle_notification_context', { target_request_id: requestId, expected_status: status });
      if (error) throw new Error('Notification eligibility unavailable');
      return data;
    },
    panicContext: async panicId => {
      if (!supabaseUrl || !serviceRoleKey) throw new Error('Missing server configuration');
      const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await admin.rpc('panic_notification_context', { target_panic_id: panicId });
      if (error) throw new Error('Notification eligibility unavailable');
      return data;
    },
    send: async messages => {
      const response = await fetch(expoPushEndpoint, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(messages),
      });
      if (!response.ok) throw new Error('Push service unavailable');
    },
  })(request);
});
