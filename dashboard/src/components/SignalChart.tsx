import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import { getActiveBuffers, useDashboardStore } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import { movingAverage, RescaleLatch } from '../charts/smoothing';
import ChartControls, { type LineShape } from '../charts/ChartControls';

export default function SignalChart() {
  const [paused, setPaused] = useState(false);
  // Window is global — see store.ts. Smooth/shape/rescale stay local.
  const windowSec = useDashboardStore((s) => s.windowSec);
  const setWindowSec = useDashboardStore((s) => s.setWindowSec);
  const [smoothN, setSmoothN] = useState(0);
  const [rescaleSec, setRescaleSec] = useState(0);
  // Linear is the default. With sliding-window scrolling at 30 Hz the
  // chart already looks continuous, and 'linear' lets Plotly use scattergl
  // (WebGL-accelerated) instead of the SVG scatter path required by spline
  // — the SVG path becomes the dominant render cost above ~1500 points.
  const [shape, setShape] = useState<LineShape>('linear');

  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const windowSecRef = useRef(windowSec);
  windowSecRef.current = windowSec;
  const smoothNRef = useRef(smoothN);
  smoothNRef.current = smoothN;
  const rescaleSecRef = useRef(rescaleSec);
  rescaleSecRef.current = rescaleSec;
  const shapeRef = useRef(shape);
  shapeRef.current = shape;

  // Two latches, one per overlaid Y-axis. Memoized so they survive across
  // renders; we manually invalidate them when the user changes window or
  // smoothing so the axis re-fits immediately rather than waiting out the
  // current rescale interval.
  const redLatch = useMemo(() => new RescaleLatch(), []);
  const irLatch = useMemo(() => new RescaleLatch(), []);

  // Window is global — even when changed from another chart, the
  // visible range here changes. Invalidate latches so the y-axis
  // re-fits to the new window's data immediately.
  useEffect(() => {
    redLatch.invalidate();
    irLatch.invalidate();
  }, [windowSec, redLatch, irLatch]);

  const onWindowChange = (sec: number) => setWindowSec(sec);
  const onSmoothChange = (n: number) => {
    setSmoothN(n);
    redLatch.invalidate();
    irLatch.invalidate();
  };
  const onRescaleChange = (sec: number) => {
    setRescaleSec(sec);
    redLatch.invalidate();
    irLatch.invalidate();
  };

  // Axis style shared between baseLayout and the per-frame layoutPatch so
  // that re-applying a y-axis range doesn't drop grid colors / titles.
  // (Plotly.react in useLivePlot does shallow merge — `layoutPatch.yaxis`
  // would otherwise replace baseLayout.yaxis entirely.)
  // tickformat '.4s' = 4 sig figs with SI suffix (k, M). Fixes the IR
  // axis showing truncated "18" instead of "178k" — Plotly's auto-format
  // picks the shortest representation that fits, which loses precision
  // when the data range is narrow on a high baseline.
  const yaxisStyle: Partial<Layout['yaxis']> = useMemo(
    () => ({
      gridcolor: '#334155',
      zerolinecolor: '#475569',
      linecolor: '#475569',
      title: { text: 'Red' },
      tickformat: '.4s',
    }),
    [],
  );
  const yaxis2Style: Partial<Layout['yaxis2']> = useMemo(
    () => ({
      overlaying: 'y',
      side: 'right',
      title: { text: 'IR' },
      gridcolor: 'transparent',
      zerolinecolor: 'transparent',
      linecolor: '#475569',
      tickformat: '.4s',
    }),
    [],
  );

  const divRef = useLivePlot({
    id: 'signal',
    pausedRef,
    followWindowSec: () => windowSecRef.current,
    baseLayout: darkLayout({
      xaxis: {
        gridcolor: '#334155',
        zerolinecolor: '#475569',
        linecolor: '#475569',
        type: 'date',
      },
      yaxis: yaxisStyle,
      yaxis2: yaxis2Style,
      showlegend: true,
    }),
    pull: () => {
      const buf = getActiveBuffers().rawPpg;
      const seq = buf.seq;
      const x: number[] = [];
      const red: number[] = [];
      const ir: number[] = [];
      buf.forEachInWindow(windowSecRef.current, (ts, v) => {
        x.push(ts);
        red.push(v.red);
        ir.push(v.ir);
      });
      const n = smoothNRef.current;
      const redOut = n > 1 ? movingAverage(red, n) : red;
      const irOut = n > 1 ? movingAverage(ir, n) : ir;

      // Y-axis range. rescaleSec === 0 means "always autorange" — leave
      // the latch unused and let Plotly re-fit each frame. Otherwise hold
      // a computed range for that many seconds before re-fitting.
      const layoutPatch: Partial<Layout> = {};
      if (rescaleSecRef.current > 0) {
        const rMs = rescaleSecRef.current * 1000;
        const redRange = redLatch.compute(redOut, rMs);
        const irRange = irLatch.compute(irOut, rMs);
        if (redRange) {
          layoutPatch.yaxis = { ...yaxisStyle, range: redRange, autorange: false };
        }
        if (irRange) {
          layoutPatch.yaxis2 = { ...yaxis2Style, range: irRange, autorange: false };
        }
      }

      // scattergl renders 'linear' shape only — spline and step need SVG
      // 'scatter'. We pick the type based on the user's shape choice and
      // sample count: above ~1500 points SVG starts to dominate the
      // render budget at 30 Hz × 4 charts, so we fall back to
      // scattergl+linear there.
      const desired = shapeRef.current;
      const tooMany = redOut.length > 1500;
      const effectiveShape: LineShape = tooMany ? 'linear' : desired;
      const traceType: 'scattergl' | 'scatter' = effectiveShape === 'linear' ? 'scattergl' : 'scatter';

      const traces: Data[] = [
        {
          x,
          y: redOut,
          type: traceType,
          mode: 'lines',
          name: 'Red',
          line: { color: CHART_COLORS.red, width: 1, shape: effectiveShape },
          yaxis: 'y',
        },
        {
          x,
          y: irOut,
          type: traceType,
          mode: 'lines',
          name: 'IR',
          line: { color: CHART_COLORS.ir, width: 1, shape: effectiveShape },
          yaxis: 'y2',
        },
      ];
      return { traces, layoutPatch, seq };
    },
  });

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[220px]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">Raw PPG ({formatWindow(windowSec)})</span>
        <ChartControls
          windowSec={windowSec}
          onWindowChange={onWindowChange}
          smoothN={smoothN}
          onSmoothChange={onSmoothChange}
          shape={shape}
          onShapeChange={setShape}
          rescaleSec={rescaleSec}
          onRescaleChange={onRescaleChange}
        >
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="text-[11px] px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
        </ChartControls>
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
    </div>
  );
}

function formatWindow(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const min = sec / 60;
  return min >= 60 ? `${min / 60} h` : `${min} min`;
}
