import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import { getActiveBuffers, useDashboardStore } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import { movingAverage, RescaleLatch } from '../charts/smoothing';
import ChartControls, { type LineShape } from '../charts/ChartControls';

interface BeatChartProps {
  /** Initial smoothing window (samples). Defaults to 0 (off). */
  defaultSmoothN?: number;
  /** Initial line shape. Defaults to 'spline'. */
  defaultShape?: LineShape;
  /** When true, hides the chart-controls bar in the header. Used by
   * Basic mode where the user shouldn't fiddle with window/smooth/shape. */
  compact?: boolean;
}

export default function BeatChart({
  defaultSmoothN = 0,
  defaultShape = 'spline',
  compact = false,
}: BeatChartProps = {}) {
  const windowSec = useDashboardStore((s) => s.windowSec);
  const setWindowSec = useDashboardStore((s) => s.setWindowSec);
  /* Live respiration peak from the glasses' 0xF2 coherence packet, in
   * milli-Hz. This is the value that feeds the adaptive-pacer ring on
   * the glasses, so it doubles as a sanity readout: with Programs 2 / 4
   * adaptive ON, the lens-cycle BPM should track whatever this shows.
   * Updates at 1 Hz (firmware coherence_task rate). */
  const lastEdgeCoh = useDashboardStore((s) => s.lastEdgeCoherence);
  const respBpm = lastEdgeCoh != null && lastEdgeCoh.respMhz > 0
    ? (lastEdgeCoh.respMhz * 60) / 1000
    : null;
  const [smoothN, setSmoothN] = useState(defaultSmoothN);
  const [rescaleSec, setRescaleSec] = useState(0);
  const [shape, setShape] = useState<LineShape>(defaultShape);

  const windowSecRef = useRef(windowSec);
  windowSecRef.current = windowSec;
  const smoothNRef = useRef(smoothN);
  smoothNRef.current = smoothN;
  const rescaleSecRef = useRef(rescaleSec);
  rescaleSecRef.current = rescaleSec;
  const shapeRef = useRef(shape);
  shapeRef.current = shape;

  const yLatch = useMemo(() => new RescaleLatch(), []);

  useEffect(() => {
    yLatch.invalidate();
  }, [windowSec, yLatch]);

  const onWindowChange = (sec: number) => setWindowSec(sec);
  const onSmoothChange = (n: number) => {
    setSmoothN(n);
    yLatch.invalidate();
  };
  const onRescaleChange = (sec: number) => {
    setRescaleSec(sec);
    yLatch.invalidate();
  };

  const yaxisStyle: Partial<Layout['yaxis']> = useMemo(
    () => ({
      gridcolor: '#334155',
      zerolinecolor: '#475569',
      linecolor: '#475569',
      title: { text: 'IBI (ms)' },
    }),
    [],
  );

  const divRef = useLivePlot({
    id: 'beat',
    // 15 Hz refresh — beat data itself arrives ~1 Hz, but the higher
    // refresh keeps the X-axis sliding smoothly under follow-window mode.
    refreshHz: 15,
    followWindowSec: () => windowSecRef.current,
    baseLayout: darkLayout({
      xaxis: {
        gridcolor: '#334155',
        zerolinecolor: '#475569',
        linecolor: '#475569',
        type: 'date',
      },
      // Y autoranges to whatever IBIs Plotly sees in the window. Lets a
      // 1500–2000 ms IBI from a Kalman lock-on or missed beat actually be
      // visible instead of off-screen above the old 400–1400 cap.
      yaxis: { ...yaxisStyle, autorange: true },
      showlegend: true,
    }),
    pull: () => {
      const bufs = getActiveBuffers();
      // Combined seq across the two beat sources — useLivePlot redraws
      // when either buffer ticks. Polar's seq is offset so they don't
      // collide on identical counts.
      const seq = bufs.narbisBeats.seq + bufs.polarBeats.seq * 0x10000;

      const ecX: number[] = [];
      const ecY: number[] = [];
      // Filter ONLY on physiological plausibility, not on the artifact
      // flag. Reasoning: when elgendi misses one beat, the next beat's
      // IBI is ~2× normal (e.g. 1500 ms at HR 80). beat_validator's
      // delta-from-median check flags that as ARTIFACT, but the IBI
      // itself is perfectly plottable — dropping it cascades one
      // elgendi miss into two missing tach points (the missed beat AND
      // the spans-it beat). The HARD bounds catch the real outliers
      // (state-reset spans of 4-6 s); leave the rest to render.
      const HARD_MIN_MS = 200;
      const HARD_MAX_MS = 2500;
      bufs.narbisBeats.forEachInWindow(windowSecRef.current, (ts, v) => {
        if (v.ibi_ms <= 0) return;
        if (v.ibi_ms < HARD_MIN_MS || v.ibi_ms > HARD_MAX_MS) return;
        ecX.push(ts);
        ecY.push(v.ibi_ms);
      });

      const polarX: number[] = [];
      const polarY: number[] = [];
      bufs.polarBeats.forEachInWindow(windowSecRef.current, (ts, v) => {
        const rrs = v.rr;
        if (!rrs || rrs.length === 0) return;
        let totalRemaining = 0;
        for (let i = rrs.length - 1; i >= 0; i--) totalRemaining += rrs[i];
        let acc = 0;
        for (let i = 0; i < rrs.length; i++) {
          const t = ts - (totalRemaining - acc);
          polarX.push(t);
          polarY.push(rrs[i]);
          acc += rrs[i];
        }
      });

      // Smoothing applies to the accepted Earclip and Polar beat series
      // (a running mean over the last N IBIs). Artifacts are NOT smoothed —
      // they're displayed as discrete markers.
      const n = smoothNRef.current;
      const ecYOut = n > 1 ? movingAverage(ecY, n) : ecY;
      const polarYOut = n > 1 ? movingAverage(polarY, n) : polarY;

      // Rescale Y from valid IBIs (skip artifacts so a single bad beat
      // can't blow up the axis).
      const layoutPatch: Partial<Layout> = {};
      if (rescaleSecRef.current > 0) {
        const combined = ecYOut.concat(polarYOut);
        if (combined.length > 0) {
          const range = yLatch.compute(combined, rescaleSecRef.current * 1000);
          if (range) {
            layoutPatch.yaxis = { ...yaxisStyle, range, autorange: false };
          }
        }
      }

      // IBI series are sparse (one point per beat), so spline is always
      // cheap here — no point-count fallback needed.
      const lineShape: LineShape = shapeRef.current;
      const traceType: 'scattergl' | 'scatter' = lineShape === 'linear' ? 'scattergl' : 'scatter';

      const traces: Data[] = [
        {
          x: ecX,
          y: ecYOut,
          type: traceType,
          mode: 'lines+markers',
          name: 'Earclip',
          line: { color: CHART_COLORS.earclip, width: 1, shape: lineShape },
          marker: { color: CHART_COLORS.earclip, size: 4 },
        },
        {
          x: polarX,
          y: polarYOut,
          type: traceType,
          mode: 'lines+markers',
          name: 'Polar H10',
          line: { color: CHART_COLORS.polar, width: 1, shape: lineShape },
          marker: { color: CHART_COLORS.polar, size: 4 },
        },
        // Artifact trace removed — outliers/artifact beats are dropped
        // entirely upstream so the autorange isn't pulled by them.
      ];
      return { traces, layoutPatch, seq };
    },
  });

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[220px]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">
          IBI tachogram ({formatWindow(windowSec)})
          <span
            className={`ml-3 tabular-nums ${
              respBpm != null ? 'text-pink-300' : 'text-slate-500'
            }`}
          >
            Resp:{' '}
            {respBpm != null
              ? `${respBpm.toFixed(2)} BPM`
              : lastEdgeCoh == null
                ? '— (no 0xF2 yet)'
                : '— (waiting for resonance peak)'}
          </span>
          {lastEdgeCoh != null && lastEdgeCoh.pacerBpm > 0 && (
            <span className="ml-3 tabular-nums text-amber-300">
              Pacer: {lastEdgeCoh.pacerBpm} BPM
            </span>
          )}
        </span>
        {!compact && (
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
            <span className="text-[10px] text-slate-500 ml-2">earclip + Polar H10</span>
          </ChartControls>
        )}
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
