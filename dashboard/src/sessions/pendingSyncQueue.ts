// IDB-backed offline queue for session rows that couldn't reach Supabase.
//
// Lifecycle:
//   1. saveSession() catches a network/CORS/timeout error and calls
//      `enqueue(row)`. The row is persisted to IDB; modal shows "Saved
//      (offline — will sync)".
//   2. The queue listens for window 'online' and Supabase auth-state
//      change events; either fires a drain attempt.
//   3. drain() reads every row, upserts each to Supabase, and removes
//      successful ones. Failures stay queued for the next drain.
//
// Idempotency: every row carries a client-generated `id` (uuid). Supabase
// upsert uses that as the conflict key, so retrying a partially-applied
// drain can't create duplicates.

import { getDb, STORE_PENDING_SYNC_SESSIONS } from '../state/idb';
import { supabase, SUPABASE_CONFIGURED } from '../lib/supabase';
import type { SessionRow } from './types';
import { useAuthStore } from '../auth/authStore';

let _draining = false;

async function readAll(): Promise<SessionRow[]> {
  const db = await getDb();
  return (await db.getAll(STORE_PENDING_SYNC_SESSIONS)) as SessionRow[];
}

async function remove(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_PENDING_SYNC_SESSIONS, id);
}

export async function enqueue(row: SessionRow): Promise<void> {
  const db = await getDb();
  await db.put(STORE_PENDING_SYNC_SESSIONS, row);
}

export async function pendingCount(): Promise<number> {
  const db = await getDb();
  return db.count(STORE_PENDING_SYNC_SESSIONS);
}

/** Try to push every queued row to Supabase. No-op if not signed in or offline. */
export async function drain(): Promise<{ flushed: number; remaining: number }> {
  if (_draining) return { flushed: 0, remaining: await pendingCount() };
  if (!SUPABASE_CONFIGURED) return { flushed: 0, remaining: 0 };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { flushed: 0, remaining: await pendingCount() };
  }
  const { status } = useAuthStore.getState();
  if (status !== 'signed_in') return { flushed: 0, remaining: await pendingCount() };

  _draining = true;
  let flushed = 0;
  try {
    const rows = await readAll();
    for (const row of rows) {
      const { error } = await supabase
        .from('sessions')
        .upsert(row, { onConflict: 'id' });
      if (!error) {
        await remove(row.id);
        flushed += 1;
      } else {
        // Stop on first error to avoid hammering — next drain will retry.
        console.warn('[pendingSync] drain failed for', row.id, error.message);
        break;
      }
    }
  } finally {
    _draining = false;
  }
  return { flushed, remaining: await pendingCount() };
}

// ─── Auto-drain triggers ────────────────────────────────────────────────────

if (typeof window !== 'undefined' && SUPABASE_CONFIGURED) {
  // Online event: try once when the browser regains connectivity.
  window.addEventListener('online', () => { void drain(); });

  // Auth event: drain on sign-in (or refresh that resurrected a session).
  useAuthStore.subscribe((state, prev) => {
    if (prev.status !== 'signed_in' && state.status === 'signed_in') {
      void drain();
    }
  });
}
