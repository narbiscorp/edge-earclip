/*
 * TPS charts — IBI (always shown), Temperature, Skin conductance and the combined Protocol chart.
 * Same useLivePlot scaffolding as the rest of the dashboard; the x axis is epoch ms and follows
 * the shared window length.
 */
import { useRef } from 'react';
import type { Data, Layout } from 'plotly.js';
import { useDashboardStore } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import type { ChartId } from '../charts/chartSync';
import { tpsBuffers, useTpsStore } from './tpsStore';

const AXIS = { gridcolor: '#334155', zerolinecolor: '#475569', linecolor: '#475569' };

function useWindowRef(): React.MutableRefObject<number> {
  const windowSec = useDashboardStore((s) => s.windowSec);
  const ref = useRef(windowSec);
  ref.current = windowSec;
  return ref;
}

function Frame({ title, readout, children, divRef, empty }: {
  title: string;
  readout?: string;
  children?: React.ReactNode;
  divRef: React.RefObject<HTMLDivElement | null>;
  empty?: string | null;
}) {
  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[170px] relative">
      <div className="px-3 py-1.5 border-b border-slate-800 flex items-center gap-3">
        <span className="text-xs font-medium text-slate-300">{title}</span>
        {readout ? <span className="text-sm font-mono text-slate-100 ml-auto">{readout}</span> : null}
        {children}
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
      {empty ? (
        <div className="absolute inset-0 top-8 flex items-center justify-center pointer-events-none text-xs text-slate-500 text-center px-6">
          {empty}
        </div>
      ) : null}
    </div>
  );
}

function baseLayout(yTitle: string, extra: Partial<Layout> = {}): Partial<Layout> {
  return darkLayout({
    xaxis: { ...AXIS, type: 'date' },
    yaxis: { ...AXIS, title: { text: yTitle }, autorange: true },
    showlegend: false,
    ...extra,
  });
}

/** Heart rhythm: IBI per beat, heart rate on the right axis. */
export function TpsIbiChart() {
  const windowRef = useWindowRef();
  const ibi = useTpsStore((s) => s.latest.ibiMs);
  const hr = useTpsStore((s) => s.latest.hr);
  const running = useTpsStore((s) => s.sourceRunning);
  const divRef = useLivePlot({
    id: 'tpsIbi' as ChartId,
    refreshHz: 10,
    followWindowSec: () => windowRef.current,
    baseLayout: baseLayout('IBI ms', {
      yaxis2: { ...AXIS, title: { text: 'HR bpm' }, overlaying: 'y', side: 'right', autorange: true, showgrid: false },
      showlegend: true,
    }),
    pull: () => {
      const seq = tpsBuffers.ibi.seq + tpsBuffers.hr.seq;
      const xs: number[] = []; const ys: number[] = [];
      tpsBuffers.ibi.forEachInWindow(windowRef.current, (ts, v) => { xs.push(ts); ys.push(v); });
      const hx: number[] = []; const hy: number[] = [];
      tpsBuffers.hr.forEachInWindow(windowRef.current, (ts, v) => { hx.push(ts); hy.push(v); });
      const traces: Data[] = [
        { x: xs, y: ys, type: 'scattergl', mode: 'lines+markers', name: 'IBI', line: { color: CHART_COLORS.tpsIbi, width: 1.5, shape: 'spline' }, marker: { size: 4 } },
        { x: hx, y: hy, type: 'scattergl', mode: 'lines', name: 'HR', yaxis: 'y2', line: { color: CHART_COLORS.hr, width: 1, dash: 'dot' } },
      ];
      return { traces, seq };
    },
  });
  const readout = ibi !== null ? `${Math.round(ibi)} ms${hr !== null ? ` · ${Math.round(hr)} bpm` : ''}` : undefined;
  return <Frame title="Heart rhythm · IBI" readout={readout} divRef={divRef} empty={running ? null : 'Start a source to see the heart rhythm'} />;
}

function baselineShape(y: number | null | undefined, color: string): Partial<Layout> {
  if (y === null || y === undefined) return {};
  return {
    shapes: [{ type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: y, y1: y, line: { color, width: 1, dash: 'dash' } }],
  };
}

/** Finger temperature with the session baseline as a dashed line. */
export function TpsTempChart() {
  const windowRef = useWindowRef();
  const temp = useTpsStore((s) => s.latest.tempC);
  const base = useTpsStore((s) => s.frame?.baseline.tempC ?? null);
  const divRef = useLivePlot({
    id: 'tpsTemp' as ChartId,
    refreshHz: 5,
    followWindowSec: () => windowRef.current,
    baseLayout: baseLayout('°C'),
    pull: () => {
      const xs: number[] = []; const ys: number[] = [];
      tpsBuffers.temp.forEachInWindow(windowRef.current, (ts, v) => { xs.push(ts); ys.push(v); });
      const b = tpsBuffers.frames.latest()?.value.baseline.tempC ?? null;
      const traces: Data[] = [
        { x: xs, y: ys, type: 'scattergl', mode: 'lines', name: 'temperature', line: { color: CHART_COLORS.tpsTemp, width: 2, shape: 'spline' } },
      ];
      return { traces, seq: tpsBuffers.temp.seq, layoutPatch: baselineShape(b, CHART_COLORS.tpsTemp) };
    },
  });
  const readout = temp !== null ? `${temp.toFixed(2)} °C${base !== null ? ` · base ${base.toFixed(2)}` : ''}` : undefined;
  return <Frame title="Temperature · warmer is relaxed ↑" readout={readout} divRef={divRef} />;
}

/** Skin conductance (GSR) with the session baseline as a dashed line. */
export function TpsScChart() {
  const windowRef = useWindowRef();
  const sc = useTpsStore((s) => s.latest.scUs);
  const base = useTpsStore((s) => s.frame?.baseline.scUs ?? null);
  const divRef = useLivePlot({
    id: 'tpsSc' as ChartId,
    refreshHz: 10,
    followWindowSec: () => windowRef.current,
    baseLayout: baseLayout('µS'),
    pull: () => {
      const xs: number[] = []; const ys: number[] = [];
      tpsBuffers.sc.forEachInWindow(windowRef.current, (ts, v) => { xs.push(ts); ys.push(v); });
      const b = tpsBuffers.frames.latest()?.value.baseline.scUs ?? null;
      const traces: Data[] = [
        { x: xs, y: ys, type: 'scattergl', mode: 'lines', name: 'skin conductance', line: { color: CHART_COLORS.tpsSc, width: 2 } },
      ];
      return { traces, seq: tpsBuffers.sc.seq, layoutPatch: baselineShape(b, CHART_COLORS.tpsSc) };
    },
  });
  const readout = sc !== null ? `${sc.toFixed(2)} µS${base !== null ? ` · base ${base.toFixed(2)}` : ''}` : undefined;
  return <Frame title="Skin conductance (GSR) · lower is relaxed ↓" readout={readout} divRef={divRef} />;
}

/** The protocol: three channel scores + the relaxation index on −1…+1, lens darkness on the right. */
export function TpsProtocolChart() {
  const windowRef = useWindowRef();
  const frame = useTpsStore((s) => s.frame);
  const divRef = useLivePlot({
    id: 'tpsProtocol' as ChartId,
    refreshHz: 10,
    followWindowSec: () => windowRef.current,
    baseLayout: darkLayout({
      xaxis: { ...AXIS, type: 'date' },
      yaxis: { ...AXIS, title: { text: 'score (−1 stressed … +1 relaxed)' }, range: [-1.05, 1.05], autorange: false },
      yaxis2: { ...AXIS, title: { text: 'lens darkness %' }, overlaying: 'y', side: 'right', range: [0, 100], autorange: false, showgrid: false },
      showlegend: true,
    }),
    pull: () => {
      const xs: number[] = [];
      const sT: Array<number | null> = []; const sS: Array<number | null> = []; const sH: Array<number | null> = [];
      const r: Array<number | null> = []; const duty: number[] = [];
      tpsBuffers.frames.forEachInWindow(windowRef.current, (ts, f) => {
        xs.push(ts); sT.push(f.sTemp); sS.push(f.sSc); sH.push(f.sHrv); r.push(f.r); duty.push(f.duty);
      });
      const traces: Data[] = [
        { x: xs, y: sT, type: 'scattergl', mode: 'lines', name: 'temp', line: { color: CHART_COLORS.tpsTemp, width: 1 }, connectgaps: false },
        { x: xs, y: sS, type: 'scattergl', mode: 'lines', name: 'GSR', line: { color: CHART_COLORS.tpsSc, width: 1 }, connectgaps: false },
        { x: xs, y: sH, type: 'scattergl', mode: 'lines', name: 'HRV', line: { color: CHART_COLORS.tpsHrv, width: 1 }, connectgaps: false },
        { x: xs, y: r, type: 'scattergl', mode: 'lines', name: 'relaxation R', line: { color: CHART_COLORS.tpsR, width: 2.5 }, connectgaps: false },
        { x: xs, y: duty, type: 'scattergl', mode: 'lines', name: 'lens darkness', yaxis: 'y2', line: { color: CHART_COLORS.tpsDuty, width: 2, shape: 'hv' } },
      ];
      return { traces, seq: tpsBuffers.frames.seq };
    },
  });
  const readout = frame
    ? `R ${frame.r === null ? '—' : frame.r.toFixed(2)} · lens ${frame.duty}%`
    : undefined;
  return <Frame title="Protocol · temperature + GSR + HRV → lens" readout={readout} divRef={divRef} />;
}
