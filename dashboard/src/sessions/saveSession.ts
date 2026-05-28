// Save a SessionRow to Supabase, with offline fallback to IDB.
//
// Returns the final SaveStatus. The modal uses this to drive its status
// pill. Idempotent via row.id — calling twice with the same id upserts the
// same row.

import { supabase, SUPABASE_CONFIGURED } from '../lib/supabase';
import { useAuthStore } from '../auth/authStore';
import { enqueue } from './pendingSyncQueue';
import type { SaveStatus, SessionRow } from './types';

export interface SaveResult {
  status: SaveStatus;
  error?: string;
}

export async function saveSession(row: SessionRow): Promise<SaveResult> {
  if (!SUPABASE_CONFIGURED) {
    return { status: 'error', error: 'Supabase not configured' };
  }
  const { status: authStatus } = useAuthStore.getState();
  if (authStatus !== 'signed_in') {
    return { status: 'error', error: 'Not signed in' };
  }

  try {
    const { error } = await supabase
      .from('sessions')
      .upsert(row, { onConflict: 'id' });

    if (error) {
      // 401/403-ish = auth problem (token expired, RLS violation). Bubble as
      // a real error so the user sees it instead of silently queuing.
      if (error.code === 'PGRST301' || error.message.toLowerCase().includes('jwt')) {
        return { status: 'error', error: error.message };
      }
      // Otherwise treat as transient and queue.
      await enqueue(row);
      return { status: 'queued', error: error.message };
    }
    return { status: 'saved' };
  } catch (err) {
    // Network / fetch failure — queue and surface as 'queued'.
    const msg = err instanceof Error ? err.message : String(err);
    await enqueue(row);
    return { status: 'queued', error: msg };
  }
}

/** Update notes on an already-saved session. Best-effort, swallows errors. */
export async function updateSessionNotes(id: string, notes: string): Promise<void> {
  if (!SUPABASE_CONFIGURED) return;
  const { status: authStatus } = useAuthStore.getState();
  if (authStatus !== 'signed_in') return;
  try {
    await supabase.from('sessions').update({ notes: notes.trim() || null }).eq('id', id);
  } catch (err) {
    console.warn('[saveSession] notes update failed', err);
  }
}

/** Delete a saved session. Returns true on success. */
export async function deleteSession(id: string): Promise<boolean> {
  if (!SUPABASE_CONFIGURED) return false;
  const { error } = await supabase.from('sessions').delete().eq('id', id);
  if (error) {
    console.warn('[saveSession] delete failed', error.message);
    return false;
  }
  return true;
}
