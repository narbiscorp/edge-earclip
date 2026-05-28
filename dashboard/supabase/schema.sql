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
