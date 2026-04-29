import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import { getActiveBuffers, useDashboardStore } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import { isArtifactBeat } from '../metrics/windowing';
import { movingAverage, RescaleLatch } from '../charts/smoothing';
import ChartControls, { type LineShape } from '../charts/ChartControls';

export default function BeatChart() {
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
    refreshHz: 5,
    baseLayout: darkLayout({
      xaxis: {
        gridcolor: '#334155',
        zerolinecolor: '#475569',
        linecolor: '#475569',
        type: 'date',
      },
      // Default Y range used only when rescale = 'live' — matches the
      // physiological resting band and avoids a single artifact peak
      // re-scaling the whole axis.
      yaxis: { ...yaxisStyle, range: [400, 1400] },
      showlegend: true,
    }),
    pull: () => {
      const bufs = getActiveBuffers();
      const earclipSamples = bufs.narbisBeats.getWindow(windowSecRef.current);
      const polarSamples = bufs.polarBeats.getWindow(windowSecRef.current);

      const ecX: number[] = [];
      const ecY: number[] = [];
      const artX: number[] = [];
      const artY: number[] = [];
      for (const s of earclipSamples) {
        if (s.value.ibi_ms <= 0) continue;
        if (isArtifactBeat(s.value)) {
          artX.push(s.timestamp);
          artY.push(s.value.ibi_ms);
        } else {
          ecX.push(s.timestamp);
          ecY.push(s.value.ibi_ms);
        }
      }

      const polarX: number[] = [];
      const polarY: number[] = [];
      for (const s of polarSamples) {
        const rrs = s.value.rr;
        if (!rrs || rrs.length === 0) continue;
        let totalRemaining = 0;
        for (let i = rrs.length - 1; i >= 0; i--) totalRemaining += rrs[i];
        let acc = 0;
        for (let i = 0; i < rrs.length; i++) {
          const t = s.timestamp - (totalRemaining - acc);
          polarX.push(t);
          polarY.push(rrs[i]);
          acc += rrs[i];
        }
      }

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
        {
          x: artX,
          y: artY,
          type: 'scattergl',
          mode: 'markers',
          name: 'Artifact',
          marker: { color: CHART_COLORS.artifact, size: 6, symbol: 'x' },
        },
      ];
      return { traces, layoutPatch };
    },
  });

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[220px]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">
          IBI tachogram ({formatWindow(windowSec)})
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
          <span className="text-[10px] text-slate-500 ml-2">earclip + Polar H10</span>
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
