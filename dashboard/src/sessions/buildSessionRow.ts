// Pure function: convert the in-memory session snapshot into a SessionRow
// that matches the Postgres schema.
//
// All metrics here are recomputed from the snapshot — we don't trust the
// modal's display values (e.g. avg HR rounded for display). This keeps the
// math in one place and means the historic detail view re-renders exactly
// what was saved.

import type { NarbisBeatEvent } from '../ble/narbisDevice';
import { SESSION_SCHEMA_VERSION, type DeviceInfo, type SessionRow } from './types';

// ─── helpers (kept simple to match SessionSummaryModal.tsx) ─────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr: number[], m: number): number {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * RMSSD — root mean square of successive IBI differences. The HRV
 * gold-standard short-term metric; this is what coherence training moves.
 */
function rmssd(ibis: number[]): number {
  if (ibis.length < 2) return 0;
  let sumSq = 0;
  for (let i = 1; i < ibis.length; i++) {
    const d = ibis[i] - ibis[i - 1];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / (ibis.length - 1));
}

function pctChange(arr: number[]): number | null {
  const slice = Math.max(3, Math.floor(arr.length * 0.1));
  if (arr.length < slice * 2) return null;
  const first = mean(arr.slice(0, slice));
  const last  = mean(arr.slice(-slice));
  if (first === 0) return null;
  return ((last - first) / first) * 100;
}

function localDateISO(ts: number): string {
  // YYYY-MM-DD in the user's local timezone (so "sessions per day" doesn't
  // break across UTC midnight).
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─── main ──────────────────────────────────────────────────────────────────

export interface BuildSessionRowInput {
  sessionId: string;
  startTs: number;
  beats: NarbisBeatEvent[];
  coherence: Array<{ ts: number; coh: number; pacerBpm: number }>;
  notes: string;
  savedVia: 'auto' | 'manual';
  deviceInfo?: DeviceInfo | null;
  /** Clinician-portal client this session is attributed to. null/undefined = Unassigned. */
  clientId?: string | null;
  /** App-engine mode this session ran — gates the paced-rate log (kept for Mode B/C only). */
  engineMode?: DeviceInfo['engine_mode'];
}

export function buildSessionRow(input: BuildSessionRowInput): SessionRow {
  const { sessionId, startTs, beats, coherence, notes, savedVia, deviceInfo, clientId, engineMode } = input;

  // Validity gate matches the live modal — guards against spurious IBIs.
  const validBeats = beats.filter((b) => b.ibi_ms >= 200 && b.ibi_ms <= 2500);
  const ibis       = validBeats.map((b) => b.ibi_ms);

  const avgIbi  = mean(ibis);
  const avgHr   = avgIbi > 0 ? 60000 / avgIbi : null;
  const minIbi  = ibis.length > 0 ? Math.min(...ibis) : null;
  const maxIbi  = ibis.length > 0 ? Math.max(...ibis) : null;
  const ibiSd   = stddev(ibis, avgIbi);
  const ibiCv   = avgIbi > 0 ? (ibiSd / avgIbi) * 100 : null;

  const cohVals = coherence.map((c) => c.coh);
  const avgCoh  = mean(cohVals);
  const peakCoh = cohVals.length > 0 ? Math.max(...cohVals) : null;
  const highPct = cohVals.length > 0
    ? (cohVals.filter((c) => c >= 70).length / cohVals.length) * 100
    : null;
  const medPct = cohVals.length > 0
    ? (cohVals.filter((c) => c >= 40 && c < 70).length / cohVals.length) * 100
    : null;
  const lowPct = cohVals.length > 0
    ? (cohVals.filter((c) => c < 40).length / cohVals.length) * 100
    : null;

  const lastBeatTs = validBeats.length > 0
    ? validBeats[validBeats.length - 1].timestamp
    : startTs;
  const durationMs = Math.max(0, lastBeatTs - startTs);

  // Paced breathing rate per coherence sample (aligned 1:1 with coherence_log_t_ms below), stashed in
  // device_info (jsonb — no DB migration) so the report can overlay the swept rates on the IBI/coherence
  // charts. Kept only for the resonance modes that actually sweep rates (Mode B/C).
  const isResonance = engineMode === 'modeB' || engineMode === 'modeC';
  const pacerLog =
    isResonance && coherence.length > 0 ? coherence.map((c) => Math.round(c.pacerBpm * 10) / 10) : null;
  const deviceInfoOut: DeviceInfo | null =
    deviceInfo || engineMode != null || pacerLog
      ? {
          ...(deviceInfo ?? {}),
          engine_mode: engineMode ?? null,
          ...(pacerLog ? { pacer_bpm_log: pacerLog } : {}),
        }
      : null;

  return {
    id: sessionId,
    schema_version: SESSION_SCHEMA_VERSION,
    client_id: clientId ?? null,
    started_at: new Date(startTs).toISOString(),
    ended_at: new Date(lastBeatTs).toISOString(),
    session_local_date: localDateISO(startTs),
    duration_seconds: Math.round(durationMs / 1000),

    beat_count: validBeats.length,
    avg_hr_bpm: avgHr,
    avg_ibi_ms: avgIbi > 0 ? avgIbi : null,
    ibi_min_ms: minIbi,
    ibi_max_ms: maxIbi,
    ibi_sd_ms: ibiSd > 0 ? ibiSd : null,
    ibi_cv_pct: ibiCv,
    ibi_change_pct: pctChange(ibis),
    rmssd_ms: rmssd(ibis) || null,

    avg_coherence: cohVals.length > 0 ? avgCoh : null,
    peak_coherence: peakCoh,
    high_coh_time_pct: highPct,
    med_coh_time_pct: medPct,
    low_coh_time_pct: lowPct,
    coh_change_pct: pctChange(cohVals),

    notes: notes.trim() ? notes.trim() : null,
    device_info: deviceInfoOut,

    ibi_log: ibis.map((v) => Math.round(v)),
    coherence_log_t_ms: cohVals.length > 0
      ? coherence.map((c) => Math.max(0, Math.round(c.ts - startTs)))
      : null,
    coherence_log_value: cohVals.length > 0
      ? cohVals.map((v) => Math.round(v))
      : null,

    saved_via: savedVia,
  };
}
