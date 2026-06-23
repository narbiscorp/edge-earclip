// Read-only re-render of a historic session using the same metric cards
// and Plotly charts as the live SessionSummaryModal.
//
// We could refactor to share rendering with the live modal, but the data
// shapes differ enough (the live modal works off NarbisBeatEvent[] + raw
// timestamps, this works off the persisted SessionRow with int arrays)
// that a separate, simpler component is clearer.

import { useEffect, useRef, useState } from 'react';
import Plotly from 'plotly.js-dist-min';
import type { Shape } from 'plotly.js';
import { darkLayout } from '../charts/chartTheme';
import { pacerOverlay } from '../charts/pacerOverlay';
import { useSessionDetail } from './useSessions';
import { deleteSession, updateSessionNotes } from './saveSession';
import type { SessionRow } from './types';

function fmt(n: number | null | undefined, decimals = 0): string {
  if (n == null) return '—';
  return n.toFixed(decimals);
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function StatCard({
  label, value, unit, colorClass = 'text-slate-100', help,
  label2, value2, unit2, colorClass2 = 'text-slate-100',
}: {
  label: string; value: string; unit?: string; colorClass?: string; help?: string;
  // Optional second metric rendered side-by-side in the same box (e.g. RMSSD + SDNN).
  label2?: string; value2?: string; unit2?: string; colorClass2?: string;
}) {
  const one = (lbl: string, val: string, u: string | undefined, cc: string, big: boolean) => (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">{lbl}</div>
      <div className="flex items-baseline gap-1">
        <span className={`${big ? 'text-xl' : 'text-lg'} font-semibold tabular-nums ${cc}`}>{val}</span>
        {u && <span className="text-xs text-slate-500">{u}</span>}
      </div>
    </div>
  );
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-3" title={help}>
      {label2 != null && value2 != null ? (
        <div className="grid grid-cols-2 gap-2">
          {one(label, value, unit, colorClass, false)}
          {one(label2, value2, unit2, colorClass2, false)}
        </div>
      ) : (
        one(label, value, unit, colorClass, true)
      )}
    </div>
  );
}

export default function SessionDetailModal({
  id, onClose, onDeleted,
}: {
  id: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const detail = useSessionDetail(id);

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-slate-950/90 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto mx-4 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        {detail.status === 'loading' && <div className="text-center text-slate-500 py-12">Loading…</div>}
        {detail.status === 'error' && (
          <div className="text-center text-rose-400 py-12">{detail.error}</div>
        )}
        {detail.status === 'ready' && detail.row && (
          <DetailBody row={detail.row} onClose={onClose} onDeleted={onDeleted} />
        )}
      </div>
    </div>
  );
}

function DetailBody({ row, onClose, onDeleted }: { row: SessionRow; onClose: () => void; onDeleted: () => void }) {
  const ibiDivRef = useRef<HTMLDivElement | null>(null);
  const cohDivRef = useRef<HTMLDivElement | null>(null);
  const [notes, setNotes] = useState(row.notes ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Paced breathing-rate overlay (any app-side mode: A Follow / B Static Pacer / C Settle & Find) —
  // persisted in device_info, aligned 1:1 with the coherence log. Lets the report correlate the paced
  // breathing rate with the IBI tachogram + coherence graph.
  const pacerLog = row.device_info?.pacer_bpm_log ?? null;
  const em = row.device_info?.engine_mode;
  const showPacer =
    (em === 'modeA' || em === 'modeB' || em === 'modeC') && !!pacerLog && pacerLog.length > 0;
  const pacerXSec = (row.coherence_log_t_ms ?? []).map((ms) => ms / 1000);

  // Render IBI tachogram (timestamps reconstruct from cumulative sum).
  useEffect(() => {
    const div = ibiDivRef.current;
    if (!div || row.ibi_log.length === 0) return;
    let cum = 0;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const ibi of row.ibi_log) {
      cum += ibi;
      xs.push(cum / 1000);
      ys.push(ibi);
    }
    const ov = showPacer ? pacerOverlay(pacerXSec, pacerLog!) : null;
    void Plotly.newPlot(div, [{
      x: xs, y: ys, type: 'scatter', mode: 'lines+markers', name: 'IBI',
      line: { color: '#22d3ee', width: 1.5, shape: 'spline' },
      marker: { color: '#22d3ee', size: 3 },
    }, ...(ov ? [ov.trace] : [])], darkLayout({
      xaxis: { title: { text: 'Time (s)' }, gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569' },
      yaxis: { title: { text: 'IBI (ms)' }, gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569' },
      ...(ov ? { yaxis2: ov.yaxis2 } : {}),
      showlegend: false,
      margin: { l: 56, r: ov ? 52 : 16, t: 8, b: 40 },
    }), { responsive: true, displayModeBar: false });
    return () => { void Plotly.purge(div); };
  }, [row.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Render coherence-over-time.
  useEffect(() => {
    const div = cohDivRef.current;
    if (!div || !row.coherence_log_t_ms || !row.coherence_log_value || row.coherence_log_value.length === 0) return;
    const xs = row.coherence_log_t_ms.map((ms) => ms / 1000);
    const ys = row.coherence_log_value;
    const bandShapes: Partial<Shape>[] = [
      { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0,  y1: 40,  fillcolor: 'rgba(239,68,68,0.07)',  line: { width: 0 } },
      { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 40, y1: 70,  fillcolor: 'rgba(251,191,36,0.07)', line: { width: 0 } },
      { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 70, y1: 100, fillcolor: 'rgba(52,211,153,0.07)', line: { width: 0 } },
    ];
    const ov = showPacer ? pacerOverlay(xs, pacerLog!) : null;
    void Plotly.newPlot(div, [{
      x: xs, y: ys, type: 'scatter', mode: 'lines+markers', name: 'Coherence',
      line: { color: '#34d399', width: 2, shape: 'spline' },
      marker: { color: '#34d399', size: 5 },
    }, ...(ov ? [ov.trace] : [])], darkLayout({
      xaxis: { title: { text: 'Time (s)' }, gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569' },
      yaxis: { title: { text: 'Coherence' }, range: [0, 100], gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569' },
      ...(ov ? { yaxis2: ov.yaxis2 } : {}),
      shapes: bandShapes as Shape[],
      showlegend: false,
      margin: { l: 56, r: ov ? 52 : 16, t: 8, b: 40 },
    }), { responsive: true, displayModeBar: false });
    return () => { void Plotly.purge(div); };
  }, [row.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced notes sync (same pattern as live modal).
  useEffect(() => {
    if (notes === (row.notes ?? '')) return;
    const t = setTimeout(() => { void updateSessionNotes(row.id, notes); }, 800);
    return () => clearTimeout(t);
  }, [notes, row.id, row.notes]);

  async function doDelete() {
    const ok = await deleteSession(row.id);
    if (ok) onDeleted();
  }

  const hasCoh = (row.coherence_log_value?.length ?? 0) > 0;

  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Session — {new Date(row.started_at).toLocaleString()}</h2>
          <div className="text-xs text-slate-500">
            {fmtDuration(row.duration_seconds)} · {row.beat_count} beats · saved {row.saved_via === 'auto' ? 'automatically' : 'manually'}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setConfirmDelete(true)} className="px-3 py-1.5 rounded-lg border border-rose-700/40 hover:bg-rose-900/20 text-xs text-rose-300 transition">Delete</button>
          <button onClick={onClose} className="px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-sm font-medium text-slate-200 transition">Close</button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCard label="Duration" value={fmtDuration(row.duration_seconds)} />
        <StatCard label="Beats"    value={row.beat_count.toString()} />
        <StatCard label="Avg HR"   value={fmt(row.avg_hr_bpm, 0)} unit="BPM" colorClass="text-rose-300" />
        <StatCard label="Avg IBI"  value={fmt(row.avg_ibi_ms, 0)} unit="ms" />
        <StatCard label="IBI range" value={row.ibi_min_ms != null && row.ibi_max_ms != null ? `${row.ibi_min_ms}–${row.ibi_max_ms}` : '—'} unit="ms" />
        <StatCard
          label="RMSSD" value={fmt(row.rmssd_ms, 0)} unit="ms"
          label2="SDNN" value2={fmt(row.ibi_sd_ms, 0)} unit2="ms"
          help="RMSSD (beat-to-beat variability) and SDNN (overall SD of NN intervals) — the two standard time-domain HRV metrics"
        />
        <StatCard
          label="IBI change"
          value={row.ibi_change_pct != null ? `${row.ibi_change_pct > 0 ? '+' : ''}${fmt(row.ibi_change_pct, 1)}` : '—'}
          unit="%"
          colorClass={row.ibi_change_pct == null
            ? 'text-slate-500'
            : row.ibi_change_pct > 2 ? 'text-emerald-400'
            : row.ibi_change_pct < -2 ? 'text-rose-400'
            : 'text-slate-200'}
        />
        {hasCoh && (
          <>
            <StatCard
              label="Avg coherence"
              value={fmt(row.avg_coherence, 0)}
              unit="/100"
              colorClass={row.avg_coherence == null ? 'text-slate-500'
                : row.avg_coherence >= 70 ? 'text-emerald-400'
                : row.avg_coherence >= 30 ? 'text-cyan-300'
                : 'text-amber-300'}
            />
            <StatCard label="Peak coherence" value={fmt(row.peak_coherence, 0)} unit="/100" />
            <StatCard label="High coh time" value={fmt(row.high_coh_time_pct, 0)} unit="% ≥70" />
            <StatCard
              label="Coh change"
              value={row.coh_change_pct != null ? `${row.coh_change_pct > 0 ? '+' : ''}${fmt(row.coh_change_pct, 1)}` : '—'}
              unit="pts"
              colorClass={row.coh_change_pct == null ? 'text-slate-500'
                : row.coh_change_pct > 5 ? 'text-emerald-400'
                : row.coh_change_pct < -5 ? 'text-rose-400'
                : 'text-slate-200'}
            />
          </>
        )}
      </div>

      <div className="space-y-1">
        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">IBI tachogram — full session</div>
        <div ref={ibiDivRef} className="h-52 rounded border border-slate-800" />
      </div>

      {hasCoh && (
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wide">Coherence over time</div>
          <div ref={cohDivRef} className="h-48 rounded border border-slate-800" />
        </div>
      )}

      <div className="space-y-1">
        <label htmlFor={`notes-${row.id}`} className="text-xs font-medium text-slate-400 uppercase tracking-wide block">
          Notes <span className="text-emerald-500/70 normal-case ml-1">(auto-syncs)</span>
        </label>
        <textarea
          id={`notes-${row.id}`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 resize-y"
        />
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/90" onClick={() => setConfirmDelete(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 max-w-sm" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm text-slate-200 mb-3">Delete this session permanently?</div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs text-slate-200">Cancel</button>
              <button onClick={() => void doDelete()} className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-500 text-xs text-white">Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
