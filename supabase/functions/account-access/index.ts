import { createClient } from 'jsr:@supabase/supabase-js@2.115.0';
import { createAccountAccessHandler, type AccessUser } from './core.ts';
import { trustedClientAddress } from './client-address.ts';

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const publicKey = Deno.env.get('SUPABASE_ANON_KEY');

// Never accept an admin credential from the caller or put it in client code.
Deno.serve(async request => {
  if (!url || !serviceKey || !publicKey) return Response.json({ error: 'Account access is unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
  const admin = createClient(url, serviceKey, options);
  return createAccountAccessHandler({
    async authenticate(token) {
      const { data, error } = await admin.auth.getUser(token);
      return error ? null : data.user as AccessUser | null;
    },
    async rpc(name, args) {
      const { data, error } = await admin.rpc(name, args);
      if (error) throw new Error('Account operation failed');
      return data;
    },
    async getUser(id) {
      const { data, error } = await admin.auth.admin.getUserById(id);
      return error ? null : data.user as AccessUser | null;
    },
    async attachRecoveryIdentity(user, email) {
      const { data, error } = await admin.auth.admin.updateUserById(user.id, {
        email, email_confirm: true,
        app_metadata: { ...user.app_metadata, sumore_recovery_identity: true },
      });
      if (error || !data.user) throw new Error('Identity setup failed');
      return data.user;
    },
    async createSession(user) {
      if (!user.email) throw new Error('Identity unavailable');
      // generateLink does NOT send an email. Verify its one-use hash on this
      // server to obtain a standard GoTrue access/refresh pair for the exact ID.
      const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email });
      if (error || data.user.id !== user.id || !data.properties.hashed_token) throw new Error('Identity unavailable');
      const isolated = createClient(url, publicKey, options);
      const result = await isolated.auth.verifyOtp({ type: 'magiclink', token_hash: data.properties.hashed_token });
      if (result.error || !result.data.session || result.data.user?.id !== user.id) throw new Error('Recovery failed');
      return result.data.session;
    },
    async deleteAccount(token) {
      const owner = createClient(url, publicKey, { ...options, global: { headers: { Authorization: `Bearer ${token}` } } });
      const { error } = await owner.rpc('delete_my_account');
      if (error) throw new Error('Account deletion failed');
    },
    async ipHash(input) {
      // This hosted gateway rewrites XFF with the stable client first; the
      // rightmost hop is a rotating proxy. Spoof/suffix probes are recorded
      // in docs/41-backend-setup.md. Reverify if the ingress changes.
      const peer = trustedClientAddress(input.headers.get('x-forwarded-for'));
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(serviceKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`sumore-account-access:${peer}`));
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    },
  })(request);
});
