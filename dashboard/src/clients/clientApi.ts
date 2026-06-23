// CRUD against the `clients` table. Mirrors the guard style of
// `sessions/saveSession.ts`: bail clearly when Supabase isn't configured or
// the user isn't signed in, so callers get a usable error string instead of a
// raw network throw.
//
// `clinician_id` is filled by the Postgres `default auth.uid()` and locked
// down by RLS, so we never set or trust it client-side.

import { supabase, SUPABASE_CONFIGURED } from '../lib/supabase';
import { useAuthStore } from '../auth/authStore';
import type { ClientRow, ClientSettings, NewClientInput } from './types';

export interface ClientResult {
  data: ClientRow | null;
  error?: string;
}

function notReady(): string | null {
  if (!SUPABASE_CONFIGURED) return 'Supabase not configured';
  if (useAuthStore.getState().status !== 'signed_in') return 'Not signed in';
  return null;
}

/** Normalize a form value: trim, and turn '' into null for nullable columns. */
function nullable(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export async function createClient(input: NewClientInput): Promise<ClientResult> {
  const blocked = notReady();
  if (blocked) return { data: null, error: blocked };

  const name = input.display_name.trim();
  if (!name) return { data: null, error: 'Name is required' };

  const { data, error } = await supabase
    .from('clients')
    .insert({
      display_name: name,
      external_code: nullable(input.external_code),
      birth_year: input.birth_year ?? null,
      notes: nullable(input.notes),
    })
    .select()
    .single();

  if (error) return { data: null, error: error.message };
  return { data: data as ClientRow };
}

export async function updateClient(
  id: string,
  patch: NewClientInput,
): Promise<ClientResult> {
  const blocked = notReady();
  if (blocked) return { data: null, error: blocked };

  const name = patch.display_name.trim();
  if (!name) return { data: null, error: 'Name is required' };

  const { data, error } = await supabase
    .from('clients')
    .update({
      display_name: name,
      external_code: nullable(patch.external_code),
      birth_year: patch.birth_year ?? null,
      notes: nullable(patch.notes),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) return { data: null, error: error.message };
  return { data: data as ClientRow };
}

/**
 * Merge `patch` into the client's `settings` jsonb (read-modify-write, so concurrent keys aren't
 * clobbered). Best-effort: returns an error string but callers generally fire-and-forget since the
 * dashboard also mirrors the value to localStorage. RLS restricts the row to the owning clinician.
 */
export async function updateClientSettings(
  id: string,
  patch: Partial<ClientSettings>,
): Promise<{ error?: string }> {
  const blocked = notReady();
  if (blocked) return { error: blocked };
  const { data, error: readErr } = await supabase
    .from('clients')
    .select('settings')
    .eq('id', id)
    .single();
  if (readErr) return { error: readErr.message };
  const merged: ClientSettings = { ...((data?.settings as ClientSettings | null) ?? {}), ...patch };
  const { error } = await supabase.from('clients').update({ settings: merged }).eq('id', id);
  return error ? { error: error.message } : {};
}

/** Soft-remove: hides the client from the active picker but keeps their data. */
export async function archiveClient(id: string, archived = true): Promise<{ error?: string }> {
  const blocked = notReady();
  if (blocked) return { error: blocked };
  const { error } = await supabase.from('clients').update({ archived }).eq('id', id);
  return error ? { error: error.message } : {};
}

/**
 * Hard delete. The `sessions.client_id` FK is `on delete set null`, so the
 * client's saved sessions are preserved and fall back to "Unassigned" — they
 * are NOT cascaded away. Prefer `archiveClient` in the UI.
 */
export async function deleteClient(id: string): Promise<boolean> {
  const blocked = notReady();
  if (blocked) return false;
  const { error } = await supabase.from('clients').delete().eq('id', id);
  if (error) {
    console.warn('[clientApi] delete failed', error.message);
    return false;
  }
  return true;
}
