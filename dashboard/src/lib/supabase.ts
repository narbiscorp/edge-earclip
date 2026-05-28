// Supabase client singleton.
//
// The URL and anon key come from Vite env vars (`VITE_SUPABASE_*`) which are
// inlined at build time:
//   • Dev: `dashboard/.env.local` (gitignored)
//   • Prod: GitHub Actions secrets, see `.github/workflows/dashboard-deploy.yml`
//
// If the env vars are missing we still construct the client with empty
// strings so the rest of the app doesn't blow up — auth calls will simply
// fail and the UI shows a "Supabase not configured" banner. This keeps the
// pure local-tuning path working for contributors who haven't set up a
// Supabase project.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url     = import.meta.env.VITE_SUPABASE_URL     ?? '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export const SUPABASE_CONFIGURED = url.length > 0 && anonKey.length > 0;

if (!SUPABASE_CONFIGURED) {
  // eslint-disable-next-line no-console
  console.warn(
    '[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set — ' +
      'cloud save / history disabled. Copy dashboard/.env.example to .env.local to enable.',
  );
}

export const supabase: SupabaseClient = createClient(
  url || 'https://invalid.supabase.co',
  anonKey || 'invalid-anon-key',
  {
    auth: {
      // PKCE flow — the server sends a code in the URL query string, the
      // client exchanges it for a session. Safer than implicit flow for
      // SPAs and required for refresh tokens.
      flowType: 'pkce',
      // Auto-detect the auth code on page load (handles the magic-link
      // landing) so we don't need an explicit `/auth/callback` route.
      detectSessionInUrl: true,
      // Persist across reloads.
      persistSession: true,
      autoRefreshToken: true,
    },
  },
);
