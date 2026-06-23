// Shared types for the clinician-portal `clients` table.
//
// The shape mirrors the Postgres `clients` table 1:1 (see
// `dashboard/supabase/schema.sql`). `clinician_id`, `id`, `archived` and
// `created_at` are filled by Postgres defaults, so the client never sets them
// on insert — that's what `NewClientInput` is for.

/** Per-client persisted settings (Postgres `clients.settings` jsonb). Grows over time; every field
 * is optional so old rows (default `{}`) and future additions stay backward-compatible. */
export interface ClientSettings {
  /** Mode B "Static Pacer" rate (br/min) remembered for this client. */
  static_pacer_bpm?: number;
}

export interface ClientRow {
  id: string;                     // uuid (db default)
  clinician_id: string;           // uuid (db default auth.uid())
  display_name: string;
  external_code: string | null;   // optional MRN / chart number
  birth_year: number | null;      // optional; year only
  notes: string | null;
  archived: boolean;
  created_at: string;             // ISO timestamp
  settings: ClientSettings | null; // jsonb; `{}` for rows created before a setting was saved
}

/** Fields the clinician fills when creating or editing a client. */
export interface NewClientInput {
  display_name: string;
  external_code?: string | null;
  birth_year?: number | null;
  notes?: string | null;
}
