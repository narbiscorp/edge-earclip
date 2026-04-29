import { useMemo, useRef, useState } from 'react';
import type { Data, Layout } from 'plotly.js';
import { getActiveBuffers } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import { movingAverage, RescaleLatch } from '../charts/smoothing';
import ChartControls from '../charts/ChartControls';

export default function SignalChart() {
  const [paused, setPaused] = useState(false);
  const [windowSec, setWindowSec] = useState(30);
  const [smoothN, setSmoothN] = useState(0);
  const [rescaleSec, setRescaleSec] = useState(0);

  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const windowSecRef = useRef(windowSec);
  windowSecRef.current = windowSec;
  const smoothNRef = useRef(smoothN);
  smoothNRef.current = smoothN;
  const rescaleSecRef = useRef(rescaleSec);
  rescaleSecRef.current = rescaleSec;

  // Two latches, one per overlaid Y-axis. Memoized so they survive across
  // renders; we manually invalidate them when the user changes window or
  // smoothing so the axis re-fits immediately rather than waiting out the
  // current rescale interval.
  const redLatch = useMemo(() => new RescaleLatch(), []);
  const irLatch = useMemo(() => new RescaleLatch(), []);

  const onWindowChange = (sec: number) => {
    setWindowSec(sec);
    redLatch.invalidate();
    irLatch.invalidate();
  };
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
  const yaxisStyle: Partial<Layout['yaxis']> = useMemo(
    () => ({
      gridcolor: '#334155',
      zerolinecolor: '#475569',
      linecolor: '#475569',
      title: { text: 'Red' },
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
    }),
    [],
  );

  const divRef = useLivePlot({
    id: 'signal',
    pausedRef,
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
      const samples = buf.getWindow(windowSecRef.current);
      const x = new Array<number>(samples.length);
      const red = new Array<number>(samples.length);
      const ir = new Array<number>(samples.length);
      for (let i = 0; i < samples.length; i++) {
        x[i] = samples[i].timestamp;
        red[i] = samples[i].value.red;
        ir[i] = samples[i].value.ir;
      }
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

      const traces: Data[] = [
        {
          x,
          y: redOut,
          type: 'scattergl',
          mode: 'lines',
          name: 'Red',
          line: { color: CHART_COLORS.red, width: 1 },
          yaxis: 'y',
        },
        {
          x,
          y: irOut,
          type: 'scattergl',
          mode: 'lines',
          name: 'IR',
          line: { color: CHART_COLORS.ir, width: 1 },
          yaxis: 'y2',
        },
      ];
      return { traces, layoutPatch };
    },
  });

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[220px]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">Raw PPG ({windowSec} s)</span>
        <ChartControls
          windowSec={windowSec}
          onWindowChange={onWindowChange}
          smoothN={smoothN}
          onSmoothChange={onSmoothChange}
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
