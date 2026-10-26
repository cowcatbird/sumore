import 'react-native-url-polyfill/auto';

import { createClient } from '@supabase/supabase-js';

import { authStorage } from '@/lib/storage';
import { networkFetch } from '@/lib/network-fetch';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '';
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';

export const isSupabaseConfigured =
  /^https:\/\/.+\.supabase\.co$/.test(supabaseUrl) &&
  supabasePublishableKey.length > 20 &&
  !supabasePublishableKey.includes('your-publishable-key');

// The local artwork playground must not restore sessions, refresh tokens,
// subscribe to realtime, or create anything in the production database.
const localArtPreview = __DEV__ && process.env.EXPO_PUBLIC_LOCAL_ART_PREVIEW === '1';
export const supabase = isSupabaseConfigured && !localArtPreview
  ? createClient(supabaseUrl, supabasePublishableKey, {
      global: { fetch: networkFetch },
      auth: {
        storage: authStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false,
      },
    })
  : null;

export function requireSupabase() {
  if (!supabase) throw new Error('Supabase is not configured. Add the two EXPO_PUBLIC_SUPABASE values.');
  return supabase;
}
