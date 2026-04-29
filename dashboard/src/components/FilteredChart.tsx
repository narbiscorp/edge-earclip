import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import { useDashboardStore, getActiveBuffers } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import { movingAverage, RescaleLatch } from '../charts/smoothing';
import ChartControls, { type LineShape } from '../charts/ChartControls';

export default function FilteredChart() {
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

  // Shared axis style — see SignalChart for why this matters with
  // useLivePlot's shallow layout merge.
  const yaxisStyle: Partial<Layout['yaxis']> = useMemo(
    () => ({
      gridcolor: '#334155',
      zerolinecolor: '#475569',
      linecolor: '#475569',
      title: { text: 'Filtered' },
      tickformat: '.4s',
    }),
    [],
  );

  const divRef = useLivePlot({
    id: 'filtered',
    baseLayout: darkLayout({
      xaxis: {
        gridcolor: '#334155',
        zerolinecolor: '#475569',
        linecolor: '#475569',
        type: 'date',
      },
      yaxis: yaxisStyle,
      showlegend: true,
    }),
    pull: () => {
      const buf = getActiveBuffers().filtered;
      const samples = buf.getWindow(windowSecRef.current);

      const fX: number[] = [];
      const fY: number[] = [];
      const acceptX: number[] = [];
      const acceptY: number[] = [];
      const rejectX: number[] = [];
      const rejectY: number[] = [];

      for (const s of samples) {
        const v = s.value;
        if (v.kind === 'filtered') {
          fX.push(v.timestamp);
          fY.push(v.value);
        } else if (v.kind === 'peak') {
          if (v.rejected) {
            rejectX.push(v.timestamp);
            rejectY.push(v.amplitude);
          } else {
            acceptX.push(v.timestamp);
            acceptY.push(v.amplitude);
          }
        }
      }

      // Smooth the continuous filtered trace; peak markers stay at their
      // true amplitudes (smoothing them would move the dots off the line).
      const n = smoothNRef.current;
      const fYOut = n > 1 ? movingAverage(fY, n) : fY;

      // Rescale Y from the filtered series + peak amplitudes combined,
      // so the markers stay on-screen even after the filtered trace moves.
      const layoutPatch: Partial<Layout> = {};
      if (rescaleSecRef.current > 0) {
        const all = fYOut.length + acceptY.length + rejectY.length;
        if (all > 0) {
          const combined = new Array<number>(all);
          let idx = 0;
          for (const v of fYOut) combined[idx++] = v;
          for (const v of acceptY) combined[idx++] = v;
          for (const v of rejectY) combined[idx++] = v;
          const range = yLatch.compute(combined, rescaleSecRef.current * 1000);
          if (range) {
            layoutPatch.yaxis = { ...yaxisStyle, range, autorange: false };
          }
        }
      }

      const desired = shapeRef.current;
      const tooMany = fYOut.length > 3000;
      const filteredShape: LineShape = tooMany ? 'linear' : desired;
      const filteredType: 'scattergl' | 'scatter' = filteredShape === 'linear' ? 'scattergl' : 'scatter';

      const traces: Data[] = [
        {
          x: fX,
          y: fYOut,
          type: filteredType,
          mode: 'lines',
          name: 'Filtered',
          line: { color: CHART_COLORS.filtered, width: 1, shape: filteredShape },
        },
        {
          x: acceptX,
          y: acceptY,
          type: 'scattergl',
          mode: 'markers',
          name: 'Peak',
          marker: { color: CHART_COLORS.peakAccept, size: 8, symbol: 'triangle-up' },
        },
        {
          x: rejectX,
          y: rejectY,
          type: 'scattergl',
          mode: 'markers',
          name: 'Rejected',
          marker: { color: CHART_COLORS.peakReject, size: 8, symbol: 'x' },
        },
      ];
      return { traces, layoutPatch };
    },
  });

  const filteredCount = useDashboardStore((s) => {
    const bufs = s.dataSource === 'replay' ? s.replayBuffers : s.buffers;
    return bufs.filtered.size();
  });

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[220px] relative">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">
          Filtered signal + peaks ({formatWindow(windowSec)})
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
          <span className="text-[10px] text-slate-500 ml-2">diagnostic stream</span>
        </ChartControls>
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
      {filteredCount === 0 ? (
        <div className="absolute inset-0 top-8 flex items-center justify-center pointer-events-none text-xs text-slate-500">
          awaiting diagnostic stream — enable POST_FILTER bit in diagnostics_mask
        </div>
      ) : null}
    </div>
  );
}

function formatWindow(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const min = sec / 60;
  return min >= 60 ? `${min / 60} h` : `${min} min`;
}
