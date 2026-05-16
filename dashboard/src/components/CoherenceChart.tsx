import { useMemo, useRef } from 'react';
import type { Data, Layout, Shape } from 'plotly.js';
import { useDashboardStore } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { darkLayout } from '../charts/chartTheme';
import { edgeCoherenceBuffers, type EdgeCoherenceSnapshot } from '../state/metricsBuffer';

interface CoherenceChartProps {
  compact?: boolean;
  /** When provided, overrides the global store windowSec and hides the window control. */
  windowSec?: number;
}

// Static background bands — low / moderate / high coherence zones.
const BAND_SHAPES: Partial<Shape>[] = [
  { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 0,  y1: 40,  fillcolor: 'rgba(239,68,68,0.07)',   line: { width: 0 } },
  { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 40, y1: 70,  fillcolor: 'rgba(251,191,36,0.07)',  line: { width: 0 } },
  { type: 'rect', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: 70, y1: 100, fillcolor: 'rgba(52,211,153,0.07)',  line: { width: 0 } },
];

export default function CoherenceChart({
  compact: _compact = false,
  windowSec: windowSecProp,
}: CoherenceChartProps = {}) {
  const storeWindowSec = useDashboardStore((s) => s.windowSec);
  const effectiveWindowSec = windowSecProp ?? storeWindowSec;

  const windowSecRef = useRef(effectiveWindowSec);
  windowSecRef.current = effectiveWindowSec;

  const yaxisStyle: Partial<Layout['yaxis']> = useMemo(
    () => ({
      gridcolor: '#334155',
      zerolinecolor: '#475569',
      linecolor: '#475569',
      title: { text: 'Coherence' },
      range: [0, 100],
    }),
    [],
  );

  const divRef = useLivePlot({
    id: 'coherence',
    // Coherence updates at ~1 Hz; 5 Hz keeps the sliding window smooth
    // without wasting CPU on frames where nothing changed.
    refreshHz: 5,
    followWindowSec: () => windowSecRef.current,
    baseLayout: darkLayout({
      xaxis: {
        gridcolor: '#334155',
        zerolinecolor: '#475569',
        linecolor: '#475569',
        type: 'date',
      },
      yaxis: yaxisStyle,
      shapes: BAND_SHAPES as Shape[],
      showlegend: false,
    }),
    pull: () => {
      const source = useDashboardStore.getState().dataSource;
      const buf = source === 'replay' ? edgeCoherenceBuffers.replay : edgeCoherenceBuffers.live;
      const seq = buf.seq;

      const x: number[] = [];
      const y: number[] = [];
      buf.forEachInWindow(windowSecRef.current, (ts, v: EdgeCoherenceSnapshot) => {
        x.push(ts);
        y.push(v.coh);
      });

      const traces: Data[] = [
        {
          x,
          y,
          type: 'scatter',
          mode: 'lines+markers',
          name: 'Coherence',
          line: { color: '#34d399', width: 2, shape: 'spline' },
          marker: { color: '#34d399', size: 5 },
        },
      ];
      return { traces, seq };
    },
  });

  // Use lastEdgeCoherence as a reactive proxy for whether any 0xF2 data
  // has ever arrived. For replay mode the placeholder may stay up briefly
  // but the chart will show data once replay reaches a coherence frame.
  const hasData = useDashboardStore((s) => s.lastEdgeCoherence !== null);

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[160px] relative">
      <div className="px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">Coherence score (per beat)</span>
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
      {!hasData ? (
        <div className="absolute inset-0 top-8 flex items-center justify-center pointer-events-none text-xs text-slate-500">
          connect glasses to see coherence score
        </div>
      ) : null}
    </div>
  );
}
