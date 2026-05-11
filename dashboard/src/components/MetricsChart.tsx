import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import {
  metricsBuffers,
  edgeCoherenceBuffers,
  type MetricsSnapshot,
  type EdgeCoherenceSnapshot,
} from '../state/metricsBuffer';
import { useDashboardStore } from '../state/store';
import { movingAverage, RescaleLatch } from '../charts/smoothing';
import ChartControls, { type LineShape } from '../charts/ChartControls';

interface Series {
  x: number[];
  y: number[];
}

function emptySeries(): Series {
  return { x: [], y: [] };
}

export default function MetricsChart() {
  const windowSec = useDashboardStore((s) => s.windowSec);
  const setWindowSec = useDashboardStore((s) => s.setWindowSec);
  const [smoothN, setSmoothN] = useState(0);
  const [rescaleSec, setRescaleSec] = useState(0);
  const [shape, setShape] = useState<LineShape>('spline');

  const windowSecRef = useRef(windowSec);
  windowSecRef.current = windowSec;
  const smoothNRef = useRef(smoothN);
  smoothNRef.current = smoothN;
  const rescaleSecRef = useRef(rescaleSec);
  rescaleSecRef.current = rescaleSec;
  const shapeRef = useRef(shape);
  shapeRef.current = shape;

  const yLatch = useMemo(() => new RescaleLatch(), []);
  const y2Latch = useMemo(() => new RescaleLatch(), []);

  // User-overridden trace visibility. Plotly.react() rewrites every trace
  // property each refresh (10 Hz), so without this the legendonly default
  // gets re-applied every frame and a legend click gets undone in <100 ms
  // — the trace flickers on, then off. We listen to plotly_legendclick
  // and remember the user's choice; pull() consults this map and only
  // emits the default `visible` if the user hasn't toggled that trace.
  const userVisibilityRef = useRef<Map<string, boolean | 'legendonly'>>(new Map());

  useEffect(() => {
    yLatch.invalidate();
    y2Latch.invalidate();
  }, [windowSec, yLatch, y2Latch]);

  const onWindowChange = (sec: number) => setWindowSec(sec);
  const onSmoothChange = (n: number) => {
    setSmoothN(n);
    yLatch.invalidate();
    y2Latch.invalidate();
  };
  const onRescaleChange = (sec: number) => {
    setRescaleSec(sec);
    yLatch.invalidate();
    y2Latch.invalidate();
  };

  const yaxisStyle: Partial<Layout['yaxis']> = useMemo(
    () => ({
      gridcolor: '#334155',
      zerolinecolor: '#475569',
      linecolor: '#475569',
      title: { text: 'ms / bpm' },
    }),
    [],
  );
  const yaxis2Style: Partial<Layout['yaxis2']> = useMemo(
    () => ({
      overlaying: 'y',
      side: 'right',
      title: { text: 'ratio / coherence' },
      gridcolor: 'transparent',
      zerolinecolor: 'transparent',
      linecolor: '#475569',
    }),
    [],
  );

  const divRef = useLivePlot({
    id: 'metrics',
    refreshHz: 10,
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
      const source = useDashboardStore.getState().dataSource;
      const buf = source === 'replay' ? metricsBuffers.replay : metricsBuffers.live;
      const edgeBuf = source === 'replay' ? edgeCoherenceBuffers.replay : edgeCoherenceBuffers.live;
      /* Compose a refresh sequence across both buffers — the firmware
       * coherence trace is fed from edgeBuf independently of the metrics
       * runner, so we have to react to either source advancing. */
      const seq = buf.seq * 10000 + (edgeBuf.seq & 0xffff);
      const rmssd = emptySeries();
      const sdnn = emptySeries();
      const hr = emptySeries();
      const lf = emptySeries();
      const hf = emptySeries();
      const lfhf = emptySeries();
      const hm = emptySeries();
      const resonance = emptySeries();
      /* Dashboard-local firmware-mirror coherence — same algorithm the
       * glasses run on the same beats. Scaled ÷10 to share the existing
       * 0..10 coherence y2 axis with the resonance/HM traces. */
      const firmwareCoh = emptySeries();
      buf.forEachInWindow(windowSecRef.current, (ts, v: MetricsSnapshot) => {
        rmssd.x.push(ts); rmssd.y.push(v.rmssd);
        sdnn.x.push(ts); sdnn.y.push(v.sdnn);
        hr.x.push(ts); hr.y.push(v.meanHr);
        lf.x.push(ts); lf.y.push(v.lf);
        hf.x.push(ts); hf.y.push(v.hf);
        lfhf.x.push(ts); lfhf.y.push(v.lfHfRatio);
        hm.x.push(ts); hm.y.push(v.hmCoherence);
        resonance.x.push(ts); resonance.y.push(v.resonanceCoherence);
        if (v.firmwareCoherence !== null) {
          firmwareCoh.x.push(ts);
          firmwareCoh.y.push(v.firmwareCoherence / 10);
        }
      });
      /* On-glasses firmware coherence — separate buffer because it arrives
       * via BLE 0xF2 independently of the dashboard's beat stream. Lets
       * the user visually verify the dashboard's local port matches what
       * the firmware is actually computing on the same beats. */
      const edgeCoh = emptySeries();
      edgeBuf.forEachInWindow(windowSecRef.current, (ts, v: EdgeCoherenceSnapshot) => {
        edgeCoh.x.push(ts);
        edgeCoh.y.push(v.coh / 10);
      });

      const n = smoothNRef.current;
      const smooth = (vals: number[]): number[] => (n > 1 ? movingAverage(vals, n) : vals);
      const hrY = smooth(hr.y);
      const rmssdY = smooth(rmssd.y);
      const sdnnY = smooth(sdnn.y);
      const lfY = smooth(lf.y);
      const hfY = smooth(hf.y);
      const lfhfY = smooth(lfhf.y);
      const resonanceY = smooth(resonance.y);
      const hmY = smooth(hm.y);
      const firmwareCohY = smooth(firmwareCoh.y);
      const edgeCohY = smooth(edgeCoh.y);

      // Two y-axes: y holds ms/bpm scale (HR, rMSSD, SDNN, LF, HF),
      // y2 holds ratio/coherence (LF/HF, both coherence traces).
      const layoutPatch: Partial<Layout> = {};
      if (rescaleSecRef.current > 0) {
        const yVals = hrY.concat(rmssdY, sdnnY, lfY, hfY);
        const y2Vals = lfhfY.concat(resonanceY, hmY, firmwareCohY, edgeCohY);
        if (yVals.length > 0) {
          const yRange = yLatch.compute(yVals, rescaleSecRef.current * 1000);
          if (yRange) layoutPatch.yaxis = { ...yaxisStyle, range: yRange, autorange: false };
        }
        if (y2Vals.length > 0) {
          const y2Range = y2Latch.compute(y2Vals, rescaleSecRef.current * 1000);
          if (y2Range) layoutPatch.yaxis2 = { ...yaxis2Style, range: y2Range, autorange: false };
        }
      }

      // HRV trace data is low-rate (one snapshot per second or so), so
      // spline is essentially free even at long windows.
      const lineShape: LineShape = shapeRef.current;
      const traceType: 'scattergl' | 'scatter' = lineShape === 'linear' ? 'scattergl' : 'scatter';

      // Resolve a trace's visible flag: user override (from legend click)
      // wins over the per-trace default. Returns one of true / 'legendonly'.
      const vis = (name: string, deflt: boolean | 'legendonly'): boolean | 'legendonly' => {
        const override = userVisibilityRef.current.get(name);
        return override !== undefined ? override : deflt;
      };

      const traces: Data[] = [
        {
          x: hr.x, y: hrY, name: 'mean HR',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.hr, width: 1.5, shape: lineShape },
          yaxis: 'y',
          // HR dwarfs HRV-band traces (60–80 bpm vs 10–60 ms) and forces
          // a Y-axis split that hides rMSSD detail. Off by default; click
          // the legend to bring it back when you want a side-by-side.
          visible: vis('mean HR', 'legendonly'),
        },
        {
          x: rmssd.x, y: rmssdY, name: 'rMSSD',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.rmssd, width: 1.5, shape: lineShape },
          yaxis: 'y',
          visible: vis('rMSSD', true),
        },
        {
          x: sdnn.x, y: sdnnY, name: 'SDNN',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.sdnn, width: 1.5, shape: lineShape },
          yaxis: 'y',
          visible: vis('SDNN', 'legendonly'),
        },
        {
          x: lf.x, y: lfY, name: 'LF',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.lf, width: 1.5, shape: lineShape },
          yaxis: 'y',
          visible: vis('LF', 'legendonly'),
        },
        {
          x: hf.x, y: hfY, name: 'HF',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.hf, width: 1.5, shape: lineShape },
          yaxis: 'y',
          visible: vis('HF', 'legendonly'),
        },
        {
          x: lfhf.x, y: lfhfY, name: 'LF/HF',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.lfhf, width: 1.5, shape: lineShape },
          yaxis: 'y2',
          visible: vis('LF/HF', 'legendonly'),
        },
        {
          x: resonance.x, y: resonanceY, name: 'Coherence (resonance)',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.resonance, width: 2, shape: lineShape },
          yaxis: 'y2',
          visible: vis('Coherence (resonance)', true),
        },
        {
          x: hm.x, y: hmY, name: 'Coherence (HeartMath)',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.hm, width: 1.5, shape: lineShape, dash: 'dot' },
          yaxis: 'y2',
          visible: vis('Coherence (HeartMath)', 'legendonly'),
        },
        /* Dashboard's local port of the firmware coherence_task. Same
         * 4 Hz × 256 FFT pipeline, same band bins, on the same beats the
         * Lomb-Scargle traces use. Plotted ÷10 so the 0..100 firmware
         * scale lines up with the 0..10 HM/resonance scale. */
        {
          x: firmwareCoh.x, y: firmwareCohY, name: 'Coherence (firmware-port ÷10)',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.firmwareCoh, width: 2, shape: lineShape },
          yaxis: 'y2',
          visible: vis('Coherence (firmware-port ÷10)', true),
        },
        /* On-glasses firmware coherence — what the lens is actually
         * reacting to. Should overlay the local port within float
         * rounding when both have the same beat input; divergence
         * indicates either a port bug or a different beat source. */
        {
          x: edgeCoh.x, y: edgeCohY, name: 'Coherence (glasses ÷10)',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.edgeCoh, width: 1.5, shape: lineShape, dash: 'dash' },
          yaxis: 'y2',
          visible: vis('Coherence (glasses ÷10)', true),
        },
      ];
      return { traces, layoutPatch, seq };
    },
  });

  // Attach a Plotly legend-click listener so we capture user toggles and
  // respect them in pull() instead of re-applying the default visibility
  // every refresh. Runs after useLivePlot's effect (which calls
  // Plotly.newPlot and attaches `.on()` to the div).
  useEffect(() => {
    const div = divRef.current as
      | (HTMLDivElement & { on?: (event: string, cb: (data: unknown) => void) => void })
      | null;
    if (!div || typeof div.on !== 'function') return;
    const onLegendClick = (data: unknown): void => {
      const d = data as { label?: string; visible?: boolean | 'legendonly' };
      if (typeof d.label !== 'string') return;
      // Plotly's default legendclick toggles visible ↔ 'legendonly'. The
      // `visible` field on the event is the state BEFORE the toggle, so
      // we record the inverse as the user's intent.
      const next: boolean | 'legendonly' = d.visible === true ? 'legendonly' : true;
      userVisibilityRef.current.set(d.label, next);
    };
    div.on('plotly_legendclick', onLegendClick);
    // useLivePlot's Plotly.purge on unmount tears down all listeners.
  }, [divRef]);

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[220px]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">
          HRV metrics ({formatWindow(windowSec)})
        </span>
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
          <span className="text-[10px] text-slate-500 ml-2">click legend to toggle traces</span>
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
