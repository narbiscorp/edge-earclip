// Hook: fetches the signed-in user's sessions from Supabase.
//
// Two flavors:
//   • useSessionList()  — lean fetch (no big arrays) for the history list
//                         and trends charts. Pulls only summary columns.
//   • useSessionDetail(id) — one row including ibi_log + coherence_log,
//                            used by SessionDetailModal.

import { useEffect, useState } from 'react';
import { supabase, SUPABASE_CONFIGURED } from '../lib/supabase';
import { useAuthStore } from '../auth/authStore';
import type { SessionRow } from './types';

export type SessionListRow = Omit<SessionRow, 'ibi_log' | 'coherence_log_t_ms' | 'coherence_log_value'>;

const LIST_COLUMNS = [
  'id', 'schema_version',
  'started_at', 'ended_at', 'session_local_date', 'duration_seconds',
  'beat_count', 'avg_hr_bpm', 'avg_ibi_ms', 'ibi_min_ms', 'ibi_max_ms',
  'ibi_sd_ms', 'ibi_cv_pct', 'ibi_change_pct', 'rmssd_ms',
  'avg_coherence', 'peak_coherence',
  'high_coh_time_pct', 'med_coh_time_pct', 'low_coh_time_pct',
  'coh_change_pct',
  'notes', 'device_info',
  'saved_via',
].join(', ');

interface ListState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  rows: SessionListRow[];
  error?: string;
  refresh: () => void;
}

export function useSessionList(): ListState {
  const authStatus = useAuthStore((s) => s.status);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Omit<ListState, 'refresh'>>({
    status: SUPABASE_CONFIGURED ? 'loading' : 'idle',
    rows: [],
  });

  useEffect(() => {
    if (!SUPABASE_CONFIGURED) { setState({ status: 'idle', rows: [] }); return; }
    if (authStatus !== 'signed_in') { setState({ status: 'idle', rows: [] }); return; }

    let cancelled = false;
    setState((s) => ({ ...s, status: 'loading' }));
    void (async () => {
      const { data, error } = await supabase
        .from('sessions')
        .select(LIST_COLUMNS)
        .order('started_at', { ascending: false })
        .limit(500);
      if (cancelled) return;
      if (error) {
        setState({ status: 'error', rows: [], error: error.message });
      } else {
        setState({ status: 'ready', rows: (data as unknown as SessionListRow[]) ?? [] });
      }
    })();
    return () => { cancelled = true; };
  }, [authStatus, tick]);

  return { ...state, refresh: () => setTick((t) => t + 1) };
}

interface DetailState {
  status: 'loading' | 'ready' | 'error';
  row: SessionRow | null;
  error?: string;
}

export function useSessionDetail(id: string | null): DetailState {
  const authStatus = useAuthStore((s) => s.status);
  const [state, setState] = useState<DetailState>({ status: 'loading', row: null });

  useEffect(() => {
    if (!id || !SUPABASE_CONFIGURED || authStatus !== 'signed_in') {
      setState({ status: 'loading', row: null });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', row: null });
    void (async () => {
      const { data, error } = await supabase
        .from('sessions')
        .select('*')
        .eq('id', id)
        .single();
      if (cancelled) return;
      if (error) {
        setState({ status: 'error', row: null, error: error.message });
      } else {
        setState({ status: 'ready', row: data as SessionRow });
      }
    })();
    return () => { cancelled = true; };
  }, [id, authStatus]);

  return state;
}
