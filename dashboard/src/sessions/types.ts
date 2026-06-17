// Shared types for the cloud-session persistence layer.
//
// The shape mirrors the `sessions` Postgres table 1:1; columns are nullable
// where the DB column is nullable. `user_id` is filled by the Postgres
// `default auth.uid()` so the client doesn't need to set it.

// v2 added the nullable `client_id` column (clinician portal). Rows written by
// v1 clients have no client_id and read back as NULL = "Unassigned".
export const SESSION_SCHEMA_VERSION = 2;

/** Soft cutoff (seconds) for auto-save vs manual-save in the modal. */
export const AUTO_SAVE_MIN_DURATION_SEC = 5 * 60;

export interface DeviceInfo {
  firmware_version?: string | null;
  dashboard_build_id?: string | null;
  polar_h10_used?: boolean;
  relay_used?: boolean;
  hr_source?: 'earclip' | 'h10' | null;
  /** App-engine mode this session ran. Drives the report's breathing-rate overlay (shown for B/C). */
  engine_mode?: 'firmware' | 'modeA' | 'modeB' | 'modeC' | null;
  /** Paced breathing rate (br/min) per coherence sample, aligned 1:1 with coherence_log_t_ms. Present
   * only for Mode B/C sessions — lets the report correlate the swept rates with the IBI/coherence graphs.
   * Stored in this jsonb field (not a top-level column) so it needs no DB migration. */
  pacer_bpm_log?: number[] | null;
}

export interface SessionRow {
  id: string;                              // client-generated uuid
  schema_version: number;

  // Clinician-portal attribution. NULL = "Unassigned" (personal use, or a
  // client that was later deleted — the FK is `on delete set null`). Set by
  // the save-confirmation flow when the signed-in user is acting as a clinician.
  client_id: string | null;

  started_at: string;                      // ISO timestamp
  ended_at: string;
  session_local_date: string;              // YYYY-MM-DD local
  duration_seconds: number;

  beat_count: number;
  avg_hr_bpm: number | null;
  avg_ibi_ms: number | null;
  ibi_min_ms: number | null;
  ibi_max_ms: number | null;
  ibi_sd_ms: number | null;
  ibi_cv_pct: number | null;
  ibi_change_pct: number | null;
  rmssd_ms: number | null;

  avg_coherence: number | null;
  peak_coherence: number | null;
  high_coh_time_pct: number | null;
  med_coh_time_pct: number | null;
  low_coh_time_pct: number | null;
  coh_change_pct: number | null;

  notes: string | null;
  device_info: DeviceInfo | null;

  ibi_log: number[];
  coherence_log_t_ms: number[] | null;
  coherence_log_value: number[] | null;

  saved_via: 'auto' | 'manual';
}

/** Save-progress state shown in the modal pill. */
export type SaveStatus =
  | 'idle'         // not attempted yet
  | 'saving'       // in-flight
  | 'saved'        // server confirmed
  | 'queued'       // offline / failed, sitting in IDB pending queue
  | 'error';       // unrecoverable error (e.g. RLS violation)
