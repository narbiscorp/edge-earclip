// Hook: fetches the signed-in clinician's clients from Supabase.
//
// Mirrors `sessions/useSessions.ts`. RLS scopes rows to the clinician, so no
// client-side `clinician_id` filter is needed. By default only active
// (non-archived) clients are returned — that's what the active-client picker
// wants; the portal can pass `includeArchived` to show the full roster.

import { useEffect, useState } from 'react';
import { supabase, SUPABASE_CONFIGURED } from '../lib/supabase';
import { useAuthStore } from '../auth/authStore';
import type { ClientRow } from './types';

export interface ClientListState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  rows: ClientRow[];
  error?: string;
  refresh: () => void;
}

export interface ClientListOptions {
  includeArchived?: boolean;
}

export function useClientList(opts?: ClientListOptions): ClientListState {
  const includeArchived = opts?.includeArchived ?? false;
  const authStatus = useAuthStore((s) => s.status);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Omit<ClientListState, 'refresh'>>({
    status: SUPABASE_CONFIGURED ? 'loading' : 'idle',
    rows: [],
  });

  useEffect(() => {
    if (!SUPABASE_CONFIGURED) { setState({ status: 'idle', rows: [] }); return; }
    if (authStatus !== 'signed_in') { setState({ status: 'idle', rows: [] }); return; }

    let cancelled = false;
    setState((s) => ({ ...s, status: 'loading' }));
    void (async () => {
      let query = supabase
        .from('clients')
        .select('*')
        .order('display_name', { ascending: true });
      if (!includeArchived) query = query.eq('archived', false);
      const { data, error } = await query;
      if (cancelled) return;
      if (error) {
        setState({ status: 'error', rows: [], error: error.message });
      } else {
        setState({ status: 'ready', rows: (data as ClientRow[]) ?? [] });
      }
    })();
    return () => { cancelled = true; };
  }, [authStatus, tick, includeArchived]);

  return { ...state, refresh: () => setTick((t) => t + 1) };
}
