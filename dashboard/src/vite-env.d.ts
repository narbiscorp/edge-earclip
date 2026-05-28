/// <reference types="vite/client" />

// Build-time constant injected by vite.config.ts `define`. A timestamp
// like 20260430183142 — visible in the header so the running app can
// prove which bundle it is.
declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  /** Supabase project URL (from Project Settings → API). Empty string in
   *  builds that don't ship cloud save. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon (public) key. Safe to ship to the browser — database
   *  access is enforced by row-level security. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
