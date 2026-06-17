// Progress trends across sessions.
//
// Three things:
//   1. KPI strip — adherence (session count + total minutes this month).
//   2. RMSSD per session line chart with weekly rolling average overlay
//      (the trend line is what users care about; session-to-session HRV
//      is noisy).
//   3. Time-in-zone stacked bar chart — red/yellow/green coherence
//      proportions per session. Single chart for the quality story.

import { useEffect, useMemo, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';
import { darkLayout } from '../charts/chartTheme';
import { useSessionList, type SessionListRow } from './useSessions';

function kpiThisMonth(rows: SessionListRow[]): { count: number; minutes: number } {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  let count = 0, sec = 0;
  for (const r of rows) {
    const d = new Date(r.started_at);
    if (d.getFullYear() === y && d.getMonth() === m) {
      count += 1;
      sec += r.duration_seconds;
    }
  }
  return { count, minutes: Math.round(sec / 60) };
}

/** Weekly rolling average (window = 7 sessions). */
function rolling(values: (number | null)[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    const lo = Math.max(0, i - window + 1);
    let sum = 0, n = 0;
    for (let j = lo; j <= i; j++) {
      const v = values[j];
      if (v != null) { sum += v; n += 1; }
    }
    out.push(n > 0 ? sum / n : null);
  }
  return out;
}

export default function TrendsView({ clientId }: { clientId?: string } = {}) {
  const list = useSessionList(clientId ? { clientId } : undefined);
  const rmssdRef = useRef<HTMLDivElement | null>(null);
  const zoneRef  = useRef<HTMLDivElement | null>(null);

  // Sessions are returned newest-first; chart wants oldest-first.
  const chronological = useMemo(() => {
    return [...list.rows].reverse();
  }, [list.rows]);

  const kpi = useMemo(() => kpiThisMonth(list.rows), [list.rows]);

  // RMSSD line + rolling average
  useEffect(() => {
    const div = rmssdRef.current;
    if (!div) return;
    if (chronological.length === 0) { void Plotly.purge(div); return; }
    const xs = chronological.map((r) => r.session_local_date);
    const ys = chronological.map((r) => r.rmssd_ms);
    const roll = rolling(ys, 7);
    void Plotly.newPlot(div, [
      {
        x: xs, y: ys, type: 'scatter', mode: 'markers',
        name: 'RMSSD',
        marker: { color: '#22d3ee', size: 6 },
      },
      {
        x: xs, y: roll, type: 'scatter', mode: 'lines',
        name: '7-session avg',
        line: { color: '#34d399', width: 2 },
      },
    ], darkLayout({
      xaxis: { title: { text: 'Session date' }, gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569' },
      yaxis: { title: { text: 'RMSSD (ms)' }, gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569', rangemode: 'tozero' },
      legend: { orientation: 'h', x: 0, y: 1.1 },
      margin: { l: 56, r: 16, t: 8, b: 40 },
    }), { responsive: true, displayModeBar: false });
    return () => { void Plotly.purge(div); };
  }, [chronological]);

  // Time-in-zone stacked bars
  useEffect(() => {
    const div = zoneRef.current;
    if (!div) return;
    const withCoh = chronological.filter((r) => r.avg_coherence != null);
    if (withCoh.length === 0) { void Plotly.purge(div); return; }
    const xs = withCoh.map((r) => r.session_local_date);
    void Plotly.newPlot(div, [
      { x: xs, y: withCoh.map((r) => r.low_coh_time_pct ?? 0), name: 'Low',  type: 'bar', marker: { color: 'rgba(239,68,68,0.7)' } },
      { x: xs, y: withCoh.map((r) => r.med_coh_time_pct ?? 0), name: 'Med',  type: 'bar', marker: { color: 'rgba(251,191,36,0.7)' } },
      { x: xs, y: withCoh.map((r) => r.high_coh_time_pct ?? 0), name: 'High', type: 'bar', marker: { color: 'rgba(52,211,153,0.85)' } },
    ], darkLayout({
      barmode: 'stack',
      xaxis: { title: { text: 'Session date' }, gridcolor: '#334155', linecolor: '#475569' },
      yaxis: { title: { text: '% of session' }, range: [0, 100], gridcolor: '#334155', linecolor: '#475569' },
      legend: { orientation: 'h', x: 0, y: 1.1 },
      margin: { l: 56, r: 16, t: 8, b: 40 },
    }), { responsive: true, displayModeBar: false });
    return () => { void Plotly.purge(div); };
  }, [chronological]);

  if (list.status === 'idle') {
    return <div className="p-8 text-center text-slate-500 text-sm">Sign in to see trends.</div>;
  }
  if (list.status === 'loading') {
    return <div className="p-8 text-center text-slate-500 text-sm">Loading…</div>;
  }
  if (list.status === 'error') {
    return <div className="p-8 text-center text-rose-400 text-sm">Couldn't load: {list.error}</div>;
  }
  if (list.rows.length === 0) {
    return <div className="p-8 text-center text-slate-500 text-sm">No saved sessions yet.</div>;
  }

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Kpi label="Sessions (this month)" value={kpi.count.toString()} />
        <Kpi label="Training time (this month)" value={`${Math.floor(kpi.minutes / 60)}h ${kpi.minutes % 60}m`} />
        <Kpi label="Total saved sessions" value={list.rows.length.toString()} />
      </div>

      <div className="space-y-1">
        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">RMSSD per session</div>
        <div ref={rmssdRef} className="h-64 rounded border border-slate-800" />
      </div>

      <div className="space-y-1">
        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">Time in coherence zones</div>
        <div ref={zoneRef} className="h-64 rounded border border-slate-800" />
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      <div className="text-2xl font-semibold tabular-nums text-slate-100">{value}</div>
    </div>
  );
}
