import { useEffect, useMemo, useRef, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import { metricsBuffers, type MetricsSnapshot } from '../state/metricsBuffer';
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
      const samples = (source === 'replay' ? metricsBuffers.replay : metricsBuffers.live).getWindow(windowSecRef.current);
      const rmssd = emptySeries();
      const sdnn = emptySeries();
      const hr = emptySeries();
      const lf = emptySeries();
      const hf = emptySeries();
      const lfhf = emptySeries();
      const hm = emptySeries();
      const resonance = emptySeries();
      for (const s of samples) {
        const v: MetricsSnapshot = s.value;
        rmssd.x.push(s.timestamp); rmssd.y.push(v.rmssd);
        sdnn.x.push(s.timestamp); sdnn.y.push(v.sdnn);
        hr.x.push(s.timestamp); hr.y.push(v.meanHr);
        lf.x.push(s.timestamp); lf.y.push(v.lf);
        hf.x.push(s.timestamp); hf.y.push(v.hf);
        lfhf.x.push(s.timestamp); lfhf.y.push(v.lfHfRatio);
        hm.x.push(s.timestamp); hm.y.push(v.hmCoherence);
        resonance.x.push(s.timestamp); resonance.y.push(v.resonanceCoherence);
      }

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

      // Two y-axes: y holds ms/bpm scale (HR, rMSSD, SDNN, LF, HF),
      // y2 holds ratio/coherence (LF/HF, both coherence traces).
      const layoutPatch: Partial<Layout> = {};
      if (rescaleSecRef.current > 0) {
        const yVals = hrY.concat(rmssdY, sdnnY, lfY, hfY);
        const y2Vals = lfhfY.concat(resonanceY, hmY);
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

      const traces: Data[] = [
        {
          x: hr.x, y: hrY, name: 'mean HR',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.hr, width: 1.5, shape: lineShape },
          yaxis: 'y',
        },
        {
          x: rmssd.x, y: rmssdY, name: 'rMSSD',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.rmssd, width: 1.5, shape: lineShape },
          yaxis: 'y',
        },
        {
          x: sdnn.x, y: sdnnY, name: 'SDNN',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.sdnn, width: 1.5, shape: lineShape },
          yaxis: 'y',
          visible: 'legendonly',
        },
        {
          x: lf.x, y: lfY, name: 'LF',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.lf, width: 1.5, shape: lineShape },
          yaxis: 'y',
          visible: 'legendonly',
        },
        {
          x: hf.x, y: hfY, name: 'HF',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.hf, width: 1.5, shape: lineShape },
          yaxis: 'y',
          visible: 'legendonly',
        },
        {
          x: lfhf.x, y: lfhfY, name: 'LF/HF',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.lfhf, width: 1.5, shape: lineShape },
          yaxis: 'y2',
          visible: 'legendonly',
        },
        {
          x: resonance.x, y: resonanceY, name: 'Coherence (resonance)',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.resonance, width: 2, shape: lineShape },
          yaxis: 'y2',
        },
        {
          x: hm.x, y: hmY, name: 'Coherence (HeartMath)',
          type: traceType, mode: 'lines',
          line: { color: CHART_COLORS.hm, width: 1.5, shape: lineShape, dash: 'dot' },
          yaxis: 'y2',
          visible: 'legendonly',
        },
      ];
      return { traces, layoutPatch };
    },
  });

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
