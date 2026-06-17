// Pure aggregation for the clinician overview dashboard.
//
// Input is the clinician's full session list (already RLS-scoped to them, so
// it spans all their clients). We group by client_id and compute a per-client
// "did they improve" delta, then average those deltas across clients.
//
// Delta definition: to de-noise session-to-session HRV, we compare the mean of
// the first N sessions against the mean of the last N, with N = max(1, min(3,
// floor(len/3))) — the same spirit as the 10%-slice trend in
// sessions/buildSessionRow.ts. A metric needs ≥2 sessions that actually carry
// that metric to produce a delta; otherwise it's null.
//
// Sessions with a null client_id ("Unassigned" / personal) are dropped — the
// roll-up is about profiled clients.

import type { SessionListRow } from '../sessions/useSessions';

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** N for the first-N / last-N window given a series length. */
function windowN(len: number): number {
  return Math.max(1, Math.min(3, Math.floor(len / 3)));
}

/** Delta = mean(last N) − mean(first N). null when fewer than 2 values. */
function endpointDelta(values: number[]): { first: number | null; last: number | null; delta: number | null } {
  if (values.length < 2) return { first: null, last: null, delta: null };
  const n = windowN(values.length);
  const first = mean(values.slice(0, n));
  const last = mean(values.slice(-n));
  return { first, last, delta: last - first };
}

export interface ClientDelta {
  clientId: string;
  sessionCount: number;
  totalMinutes: number;
  rmssdFirst: number | null;
  rmssdLast: number | null;
  rmssdDelta: number | null;
  cohFirst: number | null;
  cohLast: number | null;
  cohDelta: number | null;
  lastSessionAt: string | null;   // ISO of the most recent session
}

export interface AveragedDeltas {
  clientCount: number;        // profiled clients that have ≥1 session
  totalSessions: number;
  clientsWithDelta: number;   // clients with a computable RMSSD delta
  clientsImproved: number;    // of those, how many improved (rmssdDelta > 0)
  avgRmssdDelta: number | null;
  avgCohDelta: number | null;
}

/** Group session rows by client_id, dropping null/Unassigned rows. */
export function groupByClient(rows: SessionListRow[]): Map<string, SessionListRow[]> {
  const map = new Map<string, SessionListRow[]>();
  for (const r of rows) {
    if (!r.client_id) continue;
    const bucket = map.get(r.client_id);
    if (bucket) bucket.push(r);
    else map.set(r.client_id, [r]);
  }
  return map;
}

/** Compute the per-client delta summary for one client's sessions. */
export function clientDelta(clientId: string, rows: SessionListRow[]): ClientDelta {
  // Work chronologically regardless of input order (useSessionList is newest-first).
  const chrono = [...rows].sort((a, b) => a.started_at.localeCompare(b.started_at));

  const rmssd = chrono.map((r) => r.rmssd_ms).filter((v): v is number => v != null);
  const coh = chrono.map((r) => r.avg_coherence).filter((v): v is number => v != null);

  const r = endpointDelta(rmssd);
  const c = endpointDelta(coh);

  return {
    clientId,
    sessionCount: chrono.length,
    totalMinutes: Math.round(chrono.reduce((s, x) => s + x.duration_seconds, 0) / 60),
    rmssdFirst: r.first,
    rmssdLast: r.last,
    rmssdDelta: r.delta,
    cohFirst: c.first,
    cohLast: c.last,
    cohDelta: c.delta,
    lastSessionAt: chrono.length > 0 ? chrono[chrono.length - 1].started_at : null,
  };
}

/** Build the per-client deltas for every profiled client that has sessions. */
export function buildClientDeltas(rows: SessionListRow[]): ClientDelta[] {
  const grouped = groupByClient(rows);
  const out: ClientDelta[] = [];
  for (const [clientId, clientRows] of grouped) {
    out.push(clientDelta(clientId, clientRows));
  }
  return out;
}

/** Average the per-client deltas into a clinic-wide summary. */
export function averageDeltas(perClient: ClientDelta[]): AveragedDeltas {
  const rmssdDeltas = perClient.map((d) => d.rmssdDelta).filter((v): v is number => v != null);
  const cohDeltas = perClient.map((d) => d.cohDelta).filter((v): v is number => v != null);
  return {
    clientCount: perClient.length,
    totalSessions: perClient.reduce((s, d) => s + d.sessionCount, 0),
    clientsWithDelta: rmssdDeltas.length,
    clientsImproved: rmssdDeltas.filter((v) => v > 0).length,
    avgRmssdDelta: rmssdDeltas.length > 0 ? mean(rmssdDeltas) : null,
    avgCohDelta: cohDeltas.length > 0 ? mean(cohDeltas) : null,
  };
}
