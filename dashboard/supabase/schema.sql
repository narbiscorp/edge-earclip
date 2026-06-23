-- Narbis dashboard — Supabase schema
--
-- Run this once in the Supabase SQL editor for a fresh project. The dashboard
-- writes rows to `sessions` via the anon key; row-level security restricts
-- each authenticated user to their own rows.
--
-- Schema design notes:
--   • Single table — JSONB lives in TOAST and is not loaded unless selected,
--     so the previously-considered `session_raw_data` sibling table buys
--     nothing but a join.
--   • `ibi_log` is `int[]` not JSONB — ~2× more compact in storage, and the
--     timestamps can be reconstructed at read time from `started_at` plus
--     the cumulative sum of intervals.
--   • Coherence stored as two parallel arrays (offsets + values) — same
--     compactness argument.
--   • `schema_version` lets us add metrics later without ambiguous NULLs.
--   • `session_local_date` is the client's wall-clock date — for "sessions
--     per day" streaks that don't break across UTC midnight in PT.
--   • RMSSD column from day one even though the live modal currently shows
--     IBI SD — backfilling later means recomputing from `ibi_log`.

create extension if not exists "uuid-ossp";

create table if not exists sessions (
  id                   uuid primary key,
  user_id              uuid not null default auth.uid()
                            references auth.users on delete cascade,
  schema_version       int  not null default 1,

  started_at           timestamptz not null,
  ended_at             timestamptz not null,
  session_local_date   date        not null,
  duration_seconds     int         not null,

  beat_count           int  not null,
  avg_hr_bpm           real,
  avg_ibi_ms           real,
  ibi_min_ms           int,
  ibi_max_ms           int,
  ibi_sd_ms            real,
  ibi_cv_pct           real,
  ibi_change_pct       real,
  rmssd_ms             real,

  avg_coherence        real,
  peak_coherence       real,
  high_coh_time_pct    real,
  med_coh_time_pct     real,
  low_coh_time_pct     real,
  coh_change_pct       real,

  notes                text,
  device_info          jsonb,

  ibi_log              int[]    not null,
  coherence_log_t_ms   int[],
  coherence_log_value  smallint[],

  saved_via            text not null check (saved_via in ('auto', 'manual')),
  created_at           timestamptz not null default now(),

  check (array_length(ibi_log, 1) < 50000),
  check (
    (coherence_log_t_ms is null and coherence_log_value is null) or
    (coherence_log_t_ms is not null and coherence_log_value is not null
     and array_length(coherence_log_t_ms, 1) = array_length(coherence_log_value, 1))
  )
);

create index if not exists sessions_user_started_idx
  on sessions (user_id, started_at desc);

create index if not exists sessions_user_local_date_idx
  on sessions (user_id, session_local_date desc);

-- ─── Row-level security ────────────────────────────────────────────────────

alter table sessions enable row level security;

drop policy if exists "select own"  on sessions;
drop policy if exists "insert own"  on sessions;
drop policy if exists "update own"  on sessions;
drop policy if exists "delete own"  on sessions;

create policy "select own" on sessions
  for select to authenticated
  using (auth.uid() = user_id);

create policy "insert own" on sessions
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy "update own" on sessions
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "delete own" on sessions
  for delete to authenticated
  using (auth.uid() = user_id);

-- ─── Clinician portal: clients ─────────────────────────────────────────────
--
-- A clinician is just a normal signed-in user. Each row here is one of their
-- clients. RLS is the same shape as `sessions` (owner-scoped on auth.uid()),
-- so a clinician owns all their clients and — via sessions.client_id below —
-- all their clients' sessions. There is no "role" column: a user becomes a
-- clinician in the UI simply by having ≥1 row here.
--
-- PII note: `birth_year` is year-only on purpose (enough to disambiguate two
-- same-named clients without storing a full DOB). `display_name` may be a code
-- or initials — the clinician chooses what to put there.

create table if not exists clients (
  id            uuid primary key default uuid_generate_v4(),
  clinician_id  uuid not null default auth.uid()
                     references auth.users on delete cascade,
  display_name  text not null,
  external_code text,                  -- optional MRN / chart number
  birth_year    int,                   -- optional; year-only (less PII than full DOB)
  notes         text,
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),

  check (char_length(display_name) between 1 and 120),
  check (birth_year is null or birth_year between 1900 and 2100)
);

create index if not exists clients_clinician_idx
  on clients (clinician_id, archived, display_name);

alter table clients enable row level security;

drop policy if exists "clients select own" on clients;
drop policy if exists "clients insert own" on clients;
drop policy if exists "clients update own" on clients;
drop policy if exists "clients delete own" on clients;

create policy "clients select own" on clients
  for select to authenticated
  using (auth.uid() = clinician_id);

create policy "clients insert own" on clients
  for insert to authenticated
  with check (auth.uid() = clinician_id);

create policy "clients update own" on clients
  for update to authenticated
  using (auth.uid() = clinician_id)
  with check (auth.uid() = clinician_id);

create policy "clients delete own" on clients
  for delete to authenticated
  using (auth.uid() = clinician_id);

-- ─── sessions.client_id ────────────────────────────────────────────────────
--
-- Nullable FK attributing a session to a client. Existing rows stay NULL and
-- render as "Unassigned" in the dashboard. `on delete set null` means deleting
-- a client preserves their training history (it falls back to Unassigned)
-- rather than cascading the sessions away — the clinician-facing UI prefers
-- archiving a client over hard-deleting.

alter table sessions
  add column if not exists client_id uuid
  references clients (id) on delete set null;

create index if not exists sessions_client_started_idx
  on sessions (client_id, started_at desc);

-- ─── clients.settings ──────────────────────────────────────────────────────
--
-- Per-client settings blob (currently the Mode B "Static Pacer" rate,
-- e.g. {"static_pacer_bpm": 6.0}; future per-client presets reuse this column).
-- `not null default '{}'` backfills existing rows automatically. The existing
-- "clients update own" / "clients select own" RLS policies already cover it
-- (RLS is row-level), so no new policy is needed.

alter table clients
  add column if not exists settings jsonb not null default '{}'::jsonb;
