import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import { useDashboardStore } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import { ecgBuffer, rPeakBuffer, startPttEcg, stopPttEcg } from '../state/pttState';
import { polarH10 } from '../ble/polarH10';
import { recentMedian } from '../metrics/ptt';

/*
 * H10EcgChart — the Polar H10's raw ECG lead with the R-peaks found in it (metrics/ecgRpeak.ts):
 * the beat times pulse arrival time is measured from (PttChart). Opt-in: "Start ECG".
 * Display only takes the baseline wander out (a 1.2 s centred mean); the R-peaks are placed on
 * the raw lead.
 */

const BASELINE_HALF_MS = 600;

export default function H10EcgChart() {
  const windowSec = useDashboardStore((s) => s.windowSec);
  const windowSecRef = useRef(windowSec);
  windowSecRef.current = windowSec;
  const polarState = useDashboardStore((s) => s.connection.polar.state);
  const [streaming, setStreaming] = useState(polarH10.isEcgStreaming);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hr, setHr] = useState<number | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => {
      setStreaming(polarH10.isEcgStreaming);
      const rr = rPeakBuffer.getWindow(15).map((p) => p.value.rr).filter((v): v is number => v !== null);
      const m = recentMedian(rr, 5);
      setHr(m ? 60000 / m : null);
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const yaxis: Partial<Layout['yaxis']> = useMemo(
    () => ({ gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569', title: { text: 'µV' } }),
    [],
  );

  const divRef = useLivePlot({
    id: 'ecg',
    refreshHz: 15,
    followWindowSec: () => Math.min(windowSecRef.current, 60),
    baseLayout: darkLayout({
      xaxis: { gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569', type: 'date' },
      yaxis,
      showlegend: false,
    }),
    pull: () => {
      const win = Math.min(windowSecRef.current, 60);
      const x: number[] = [];
      const raw: number[] = [];
      ecgBuffer.forEachInWindow(win + 2, (t, v) => {
        x.push(t);
        raw.push(v);
      });
      // Centred mean via prefix sums: baseline wander out, QRS untouched.
      const pre = new Float64Array(raw.length + 1);
      for (let i = 0; i < raw.length; i++) pre[i + 1] = pre[i] + raw[i];
      const y = new Array<number>(raw.length);
      let lo = 0, hi = 0;
      for (let i = 0; i < raw.length; i++) {
        while (x[lo] < x[i] - BASELINE_HALF_MS) lo++;
        while (hi < raw.length && x[hi] <= x[i] + BASELINE_HALF_MS) hi++;
        y[i] = raw[i] - (pre[hi] - pre[lo]) / (hi - lo);
      }
      const rx: number[] = [];
      const ry: number[] = [];
      let j = 0;
      rPeakBuffer.forEachInWindow(win + 2, (t) => {
        while (j + 1 < x.length && x[j + 1] <= t) j++;
        if (x.length > 0) {
          rx.push(t);
          ry.push(y[Math.abs(x[j] - t) < Math.abs((x[j + 1] ?? Infinity) - t) ? j : j + 1]);
        }
      });
      const traces: Data[] = [
        { x, y, type: 'scattergl', mode: 'lines', name: 'ECG', line: { color: CHART_COLORS.polar, width: 1 } },
        { x: rx, y: ry, type: 'scattergl', mode: 'markers', name: 'R', marker: { color: '#fde047', size: 6, symbol: 'triangle-down' } },
      ];
      return { traces, seq: ecgBuffer.seq + rPeakBuffer.seq };
    },
  });

  const toggle = async () => {
    setBusy(true);
    setError(null);
    if (streaming) {
      await stopPttEcg();
    } else {
      const err = await startPttEcg();
      if (err) setError(err);
    }
    setStreaming(polarH10.isEcgStreaming);
    setBusy(false);
  };

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[180px]">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300" title="The H10's raw ECG lead (130 Hz). R-peaks (yellow) are found here, not taken from the H10's 1-a-second heart-rate packets, whose timing jitters by up to a second.">
          H10 ECG · R-peaks
          <span className="ml-1.5 text-[10px] font-normal text-slate-500">window ≤ 1 min</span>
        </span>
        <div className="flex items-center gap-3 text-[11px] text-slate-400">
          {error ? <span className="text-rose-400 max-w-[420px] truncate" title={error}>{error}</span> : null}
          <span className="tabular-nums">{hr ? `ECG HR ${hr.toFixed(0)} bpm` : streaming ? 'finding R-peaks…' : ''}</span>
          <button
            type="button"
            disabled={busy || polarState !== 'connected'}
            onClick={() => void toggle()}
            className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-40"
          >
            {streaming ? 'Stop ECG' : 'Start ECG'}
          </button>
        </div>
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
    </div>
  );
}
