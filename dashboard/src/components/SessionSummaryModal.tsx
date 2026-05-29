import { useEffect, useRef, useState } from 'react';
import Plotly from 'plotly.js-dist-min';
import type { Shape } from 'plotly.js';
import {
  useDashboardStore,
  getSessionBeats,
  getSessionCoherence,
  getSessionStartTs,
  getSessionId,
  getSessionPauseMarkers,
  getSessionPauseTotalMs,
  getSessionEndedAt,
} from '../state/store';
import { darkLayout } from '../charts/chartTheme';
import { useAuthStore } from '../auth/authStore';
import { SUPABASE_CONFIGURED } from '../lib/supabase';
import { buildSessionRow } from '../sessions/buildSessionRow';
import { saveSession, updateSessionNotes } from '../sessions/saveSession';
import { AUTO_SAVE_MIN_DURATION_SEC, type SaveStatus } from '../sessions/types';

// ─── helpers ────────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr: number[], m: number): number {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmt(n: number, decimals = 0): string {
  return n.toFixed(decimals);
}

// ─── sub-components ──────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  unit,
  colorClass = 'text-slate-100',
  help,
}: {
  label: string;
  value: string;
  unit?: string;
  colorClass?: string;
  help?: string;
}) {
  return (
    <div
      className="rounded-lg border border-slate-700 bg-slate-800/60 p-3"
      title={help}
    >
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={`text-xl font-semibold tabular-nums ${colorClass}`}>{value}</span>
        {unit && <span className="text-xs text-slate-500">{unit}</span>}
      </div>
    </div>
  );
}

// ─── main component ──────────────────────────────────────────────────────────

export default function SessionSummaryModal() {
  const setShowSessionSummary = useDashboardStore((s) => s.setShowSessionSummary);
  const clearSession = useDashboardStore((s) => s.clearSession);
  const authStatus = useAuthStore((s) => s.status);
  const setShowLogin = useAuthStore((s) => s.setShowLogin);

  const ibiDivRef = useRef<HTMLDivElement | null>(null);
  const cohDivRef = useRef<HTMLDivElement | null>(null);

  // Snapshot the session data once on mount so the modal shows a frozen
  // picture of the session, even if beats keep arriving while it's open.
  const beatsSnap = useRef(getSessionBeats().slice());
  const cohSnap   = useRef(getSessionCoherence().slice());
  const startTs   = useRef(getSessionStartTs());
  const sessionIdSnap = useRef(getSessionId());
  const pauseMarkersSnap = useRef(getSessionPauseMarkers().slice());
  const pauseTotalMsSnap = useRef(getSessionPauseTotalMs());
  const sessionEndedAtSnap = useRef(getSessionEndedAt());

  const beats   = beatsSnap.current;
  const cohData = cohSnap.current;
  const sessionStartTs = startTs.current;
  const sessionId = sessionIdSnap.current;
  const pauseMarkers = pauseMarkersSnap.current;
  const pauseTotalMs = pauseTotalMsSnap.current;
  const sessionEndedAt = sessionEndedAtSnap.current;

  // Save-flow state
  const [notes, setNotes] = useState('');
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const autoSaveAttemptedRef = useRef(false);
  const savedRowIdRef = useRef<string | null>(null);

  // ── derived metrics ────────────────────────────────────────────────────────

  const validBeats = beats.filter((b) => b.ibi_ms >= 200 && b.ibi_ms <= 2500);
  const ibis       = validBeats.map((b) => b.ibi_ms);

  const avgIbi  = mean(ibis);
  const avgHr   = avgIbi > 0 ? Math.round(60000 / avgIbi) : 0;
  const minIbi  = ibis.length > 0 ? Math.min(...ibis) : 0;
  const maxIbi  = ibis.length > 0 ? Math.max(...ibis) : 0;
  const ibiSd   = stddev(ibis, avgIbi);   // RMSSD-like spread proxy
  const ibiCv   = avgIbi > 0 ? (ibiSd / avgIbi) * 100 : 0;

  const slice10     = Math.max(3, Math.floor(ibis.length * 0.1));
  const ibiPctChange =
    ibis.length >= slice10 * 2
      ? ((mean(ibis.slice(-slice10)) - mean(ibis.slice(0, slice10))) /
          mean(ibis.slice(0, slice10))) *
        100
      : null;

  const cohValues   = cohData.map((c) => c.coh);
  const avgCoh      = mean(cohValues);
  const peakCoh     = cohValues.length > 0 ? Math.max(...cohValues) : 0;
  const highCohPct  =
    cohValues.length > 0
      ? (cohValues.filter((c) => c >= 70).length / cohValues.length) * 100
      : 0;
  const cohSlice    = Math.max(3, Math.floor(cohValues.length * 0.1));
  const cohPctChange =
    cohValues.length >= cohSlice * 2
      ? ((mean(cohValues.slice(-cohSlice)) - mean(cohValues.slice(0, cohSlice))) /
          mean(cohValues.slice(0, cohSlice))) *
        100
      : null;

  const lastBeatTs  = validBeats.length > 0 ? validBeats[validBeats.length - 1].timestamp : null;
  // Active-recording duration: anchor against sessionEndedAt when the user
  // explicitly ended (so a long pause at the end doesn't leave a stale
  // "ended somewhere mid-flow" feel), otherwise fall back to lastBeatTs.
  // pauseTotalMs is already accumulated at end-time, so subtracting it here
  // gives just the time beats were actually streaming.
  const endRefTs = sessionEndedAt ?? lastBeatTs;
  const durationMs = sessionStartTs && endRefTs
    ? Math.max(0, endRefTs - sessionStartTs - pauseTotalMs)
    : null;
  const durationSec = durationMs != null ? Math.floor(durationMs / 1000) : 0;

  // Pause markers as Plotly vertical-line shapes anchored to the same
  // "seconds since session start" x axis the charts use. Thin dashed amber
  // line spanning the chart height — visible but unobtrusive.
  const pauseShapes: Partial<Shape>[] =
    sessionStartTs != null
      ? pauseMarkers.map((m) => ({
          type: 'line' as const,
          xref: 'x' as const,
          yref: 'paper' as const,
          x0: (m.start - sessionStartTs) / 1000,
          x1: (m.start - sessionStartTs) / 1000,
          y0: 0,
          y1: 1,
          line: { color: '#facc15', width: 1.5, dash: 'dot' as const },
        }))
      : [];

  const empty = validBeats.length < 5;

  // ── save flow ──────────────────────────────────────────────────────────────

  const canSave = !empty && sessionId != null && sessionStartTs != null;
  const autoSaveEligible =
    canSave && authStatus === 'signed_in' && durationSec >= AUTO_SAVE_MIN_DURATION_SEC;
  const manualSaveAvailable =
    canSave && authStatus === 'signed_in' && durationSec < AUTO_SAVE_MIN_DURATION_SEC;
  const persisted = saveStatus === 'saved' || saveStatus === 'queued';

  async function doSaveInternal(savedVia: 'auto' | 'manual', notesAtSaveTime: string): Promise<void> {
    if (!sessionId || !sessionStartTs) return;
    setSaveStatus('saving');
    setSaveError(null);
    const row = buildSessionRow({
      sessionId,
      startTs: sessionStartTs,
      beats,
      coherence: cohData,
      notes: notesAtSaveTime,
      savedVia,
      deviceInfo: { dashboard_build_id: __BUILD_ID__ },
    });
    savedRowIdRef.current = row.id;
    const result = await saveSession(row);
    setSaveStatus(result.status);
    setSaveError(result.error ?? null);
  }

  // Auto-save once when auth + session state are ready. Guarded so it never
  // fires twice for the same modal lifecycle.
  useEffect(() => {
    if (autoSaveAttemptedRef.current) return;
    if (authStatus === 'loading') return;       // wait for getSession() to resolve
    if (!autoSaveEligible) {
      // Sessions that don't qualify (short / not signed in / empty) just
      // mark as attempted so we don't re-evaluate every render.
      if (!canSave || authStatus !== 'signed_in' || durationSec < AUTO_SAVE_MIN_DURATION_SEC) {
        autoSaveAttemptedRef.current = true;
      }
      return;
    }
    autoSaveAttemptedRef.current = true;
    void doSaveInternal('auto', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps — snapshot-based
  }, [authStatus, autoSaveEligible]);

  // Debounced notes-update once the row has been persisted server-side.
  useEffect(() => {
    if (saveStatus !== 'saved') return;
    const id = savedRowIdRef.current;
    if (!id) return;
    const t = setTimeout(() => { void updateSessionNotes(id, notes); }, 800);
    return () => clearTimeout(t);
  }, [notes, saveStatus]);

  // ── IBI tachogram (static, rendered once) ─────────────────────────────────

  useEffect(() => {
    const div = ibiDivRef.current;
    if (!div || ibis.length === 0) return;

    const offsetSec = validBeats.map((b) =>
      sessionStartTs ? (b.timestamp - sessionStartTs) / 1000 : 0,
    );

    void Plotly.newPlot(
      div,
      [
        {
          x: offsetSec,
          y: ibis,
          type: 'scatter',
          mode: 'lines+markers',
          line: { color: '#22d3ee', width: 1.5, shape: 'spline' },
          marker: { color: '#22d3ee', size: 3 },
        },
      ],
      darkLayout({
        xaxis: {
          title: { text: 'Time (s)' },
          type: 'linear' as const,
          gridcolor: '#334155',
          zerolinecolor: '#475569',
          linecolor: '#475569',
        },
        yaxis: {
          title: { text: 'IBI (ms)' },
          gridcolor: '#334155',
          zerolinecolor: '#475569',
          linecolor: '#475569',
        },
        shapes: pauseShapes as Shape[],
        showlegend: false,
        margin: { l: 56, r: 16, t: 8, b: 40 },
      }),
      { responsive: true, displayModeBar: false },
    );

    return () => {
      void Plotly.purge(div);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — snapshot at mount

  // ── coherence over time (static, rendered once) ───────────────────────────

  useEffect(() => {
    const div = cohDivRef.current;
    if (!div || cohData.length === 0) return;

    const cohOffsetSec = cohData.map((c) =>
      sessionStartTs ? (c.ts - sessionStartTs) / 1000 : 0,
    );

    const bandShapes: Partial<Shape>[] = [
      { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0,  y1: 40,  fillcolor: 'rgba(239,68,68,0.07)',  line: { width: 0 } },
      { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 40, y1: 70,  fillcolor: 'rgba(251,191,36,0.07)', line: { width: 0 } },
      { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 70, y1: 100, fillcolor: 'rgba(52,211,153,0.07)', line: { width: 0 } },
    ];

    void Plotly.newPlot(
      div,
      [
        {
          x: cohOffsetSec,
          y: cohValues,
          type: 'scatter',
          mode: 'lines+markers',
          line: { color: '#34d399', width: 2, shape: 'spline' },
          marker: { color: '#34d399', size: 5 },
        },
      ],
      darkLayout({
        xaxis: {
          title: { text: 'Time (s)' },
          type: 'linear' as const,
          gridcolor: '#334155',
          zerolinecolor: '#475569',
          linecolor: '#475569',
        },
        yaxis: {
          title: { text: 'Coherence' },
          range: [0, 100],
          gridcolor: '#334155',
          zerolinecolor: '#475569',
          linecolor: '#475569',
        },
        shapes: [...bandShapes, ...pauseShapes] as Shape[],
        showlegend: false,
        margin: { l: 56, r: 16, t: 8, b: 40 },
      }),
      { responsive: true, displayModeBar: false },
    );

    return () => {
      void Plotly.purge(div);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps — snapshot at mount

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 backdrop-blur-sm">
      <div className="relative bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto mx-4 p-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h2 className="text-lg font-semibold text-slate-100">Session Summary</h2>
          <div className="flex gap-2 items-center flex-wrap">
            <SaveStatusPill
              status={saveStatus}
              error={saveError}
              authStatus={authStatus}
              autoSaveEligible={autoSaveEligible}
              manualSaveAvailable={manualSaveAvailable}
              configured={SUPABASE_CONFIGURED}
              empty={empty}
            />

            {/* Sign-in CTA when logged out and there's something to save */}
            {!empty && SUPABASE_CONFIGURED && authStatus === 'signed_out' && (
              <button
                onClick={() => setShowLogin(true)}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-medium text-white transition"
              >
                Sign in to save
              </button>
            )}

            {/* Manual save for short sessions (or retry after queued/error) */}
            {!empty && authStatus === 'signed_in' && (manualSaveAvailable || saveStatus === 'queued' || saveStatus === 'error') && saveStatus !== 'saving' && (
              <button
                onClick={() => void doSaveInternal('manual', notes)}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium text-white transition"
                title={manualSaveAvailable ? 'Session shorter than 5 min — save anyway' : 'Retry cloud save'}
              >
                {saveStatus === 'idle' ? 'Save this session' : 'Retry save'}
              </button>
            )}

            <button
              onClick={clearSession}
              className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-medium text-white transition"
              title={persisted ? 'Saved — start a new session' : 'Discard and start a new session'}
            >
              {persisted ? 'New Session' : 'New Session'}
            </button>
            <button
              onClick={() => setShowSessionSummary(false)}
              className="px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm font-medium text-slate-200 transition"
            >
              Close
            </button>
          </div>
        </div>

        {empty ? (
          <div className="py-16 text-center text-slate-500">
            No session data yet — connect a heart-rate source and train first.
          </div>
        ) : (
          <>
            {/* Metrics grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatCard
                label="Duration"
                value={durationMs ? formatDuration(durationMs) : '—'}
              />
              <StatCard
                label="Beats"
                value={`${validBeats.length}`}
              />
              <StatCard
                label="Avg HR"
                value={avgHr > 0 ? `${avgHr}` : '—'}
                unit="BPM"
                colorClass="text-rose-300"
              />
              <StatCard
                label="Avg IBI"
                value={avgIbi > 0 ? fmt(avgIbi) : '—'}
                unit="ms"
              />
              <StatCard
                label="IBI range"
                value={minIbi > 0 ? `${fmt(minIbi)}–${fmt(maxIbi)}` : '—'}
                unit="ms"
              />
              <StatCard
                label="IBI SD"
                value={ibiSd > 0 ? fmt(ibiSd) : '—'}
                unit="ms"
                help="Standard deviation of IBI — a simple HRV spread metric"
              />
              <StatCard
                label="IBI CV"
                value={ibiCv > 0 ? fmt(ibiCv, 1) : '—'}
                unit="%"
                help="Coefficient of variation (SD / mean × 100)"
              />
              <StatCard
                label="IBI change"
                value={
                  ibiPctChange != null
                    ? `${ibiPctChange > 0 ? '+' : ''}${fmt(ibiPctChange, 1)}`
                    : '—'
                }
                unit="%"
                colorClass={
                  ibiPctChange == null
                    ? 'text-slate-500'
                    : ibiPctChange > 2
                      ? 'text-emerald-400'
                      : ibiPctChange < -2
                        ? 'text-rose-400'
                        : 'text-slate-200'
                }
                help="(last 10% − first 10%) / first 10% — positive = IBI lengthened = HRV improving"
              />
              {cohValues.length > 0 && (
                <>
                  <StatCard
                    label="Avg coherence"
                    value={avgCoh > 0 ? fmt(avgCoh) : '—'}
                    unit="/100"
                    colorClass={
                      avgCoh >= 70
                        ? 'text-emerald-400'
                        : avgCoh >= 30
                          ? 'text-cyan-300'
                          : 'text-amber-300'
                    }
                  />
                  <StatCard
                    label="Peak coherence"
                    value={peakCoh > 0 ? `${peakCoh}` : '—'}
                    unit="/100"
                    colorClass={
                      peakCoh >= 70
                        ? 'text-emerald-400'
                        : peakCoh >= 30
                          ? 'text-cyan-300'
                          : 'text-slate-200'
                    }
                  />
                  <StatCard
                    label="High coh time"
                    value={`${fmt(highCohPct)}`}
                    unit="% ≥70"
                    colorClass={
                      highCohPct >= 50
                        ? 'text-emerald-400'
                        : highCohPct >= 20
                          ? 'text-cyan-300'
                          : 'text-slate-200'
                    }
                    help="Fraction of session where coherence ≥ 70"
                  />
                  <StatCard
                    label="Coh change"
                    value={
                      cohPctChange != null
                        ? `${cohPctChange > 0 ? '+' : ''}${fmt(cohPctChange, 1)}`
                        : '—'
                    }
                    unit="%"
                    colorClass={
                      cohPctChange == null
                        ? 'text-slate-500'
                        : cohPctChange > 5
                          ? 'text-emerald-400'
                          : cohPctChange < -5
                            ? 'text-rose-400'
                            : 'text-slate-200'
                    }
                    help="(last 10% − first 10%) / first 10% — positive = coherence improved"
                  />
                </>
              )}
            </div>

            {/* IBI tachogram */}
            <div className="space-y-1">
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                IBI tachogram — full session
              </div>
              <div ref={ibiDivRef} className="h-52 rounded border border-slate-800" />
            </div>

            {/* Coherence over time */}
            {cohData.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">
                  Coherence over time
                </div>
                <div ref={cohDivRef} className="h-48 rounded border border-slate-800" />
              </div>
            )}

            {/* Notes — only shown when cloud save is configured, since
                that's the only place they get persisted. */}
            {SUPABASE_CONFIGURED && (
              <div className="space-y-1">
                <label
                  htmlFor="session-notes"
                  className="text-xs font-medium text-slate-400 uppercase tracking-wide block"
                >
                  Notes {persisted && <span className="text-emerald-500/70 normal-case ml-1">(auto-syncs)</span>}
                </label>
                <textarea
                  id="session-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="How did this session feel? Mood, posture, anything noteworthy…"
                  className="w-full rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 resize-y"
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Save-status pill ────────────────────────────────────────────────────────

function SaveStatusPill({
  status,
  error,
  authStatus,
  autoSaveEligible,
  manualSaveAvailable,
  configured,
  empty,
}: {
  status: SaveStatus;
  error: string | null;
  authStatus: 'loading' | 'signed_in' | 'signed_out';
  autoSaveEligible: boolean;
  manualSaveAvailable: boolean;
  configured: boolean;
  empty: boolean;
}) {
  if (empty || !configured) return null;
  if (authStatus !== 'signed_in') return null;

  // While we're waiting on the auto-save to fire (or after a short session
  // where the user hasn't clicked manual yet) show a quiet status hint.
  if (status === 'idle') {
    if (autoSaveEligible) return <Pill tone="info">Preparing to save…</Pill>;
    if (manualSaveAvailable) return <Pill tone="muted">&lt; 5 min — manual save</Pill>;
    return null;
  }
  if (status === 'saving') return <Pill tone="info">Saving…</Pill>;
  if (status === 'saved')  return <Pill tone="ok">Saved</Pill>;
  if (status === 'queued') return <Pill tone="warn">Saved (offline — will sync)</Pill>;
  return <Pill tone="error" title={error ?? undefined}>Save failed</Pill>;
}

function Pill({
  tone,
  title,
  children,
}: {
  tone: 'info' | 'ok' | 'warn' | 'error' | 'muted';
  title?: string;
  children: React.ReactNode;
}) {
  const cls = {
    info:  'border-indigo-600/40 bg-indigo-900/30 text-indigo-200',
    ok:    'border-emerald-600/40 bg-emerald-900/30 text-emerald-200',
    warn:  'border-amber-600/40 bg-amber-900/30 text-amber-200',
    error: 'border-rose-600/40 bg-rose-900/30 text-rose-200',
    muted: 'border-slate-700 bg-slate-800/50 text-slate-400',
  }[tone];
  return (
    <span
      title={title}
      className={`inline-flex items-center px-2 py-1 rounded border text-xs ${cls}`}
    >
      {children}
    </span>
  );
}
