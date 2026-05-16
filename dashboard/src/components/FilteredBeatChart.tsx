import { useMemo, useRef } from 'react';
import type { Data } from 'plotly.js';
import { useDashboardStore, getActiveBuffers } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';

interface FilteredBeatChartProps {
  compact?: boolean;
  /** When provided, overrides the global store windowSec and hides controls. */
  windowSec?: number;
}

export default function FilteredBeatChart({
  compact: _compact = false,
  windowSec: windowSecProp,
}: FilteredBeatChartProps = {}) {
  const storeWindowSec = useDashboardStore((s) => s.windowSec);
  const effectiveWindowSec = windowSecProp ?? storeWindowSec;

  const windowSecRef = useRef(effectiveWindowSec);
  windowSecRef.current = effectiveWindowSec;

  const yaxisStyle = useMemo(
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
    id: 'filteredbeat',
    refreshHz: 20,
    followWindowSec: () => windowSecRef.current,
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
      const bufs = getActiveBuffers();
      const buf = bufs.filtered;
      // Combine seqs so any new beat marker or filtered sample triggers a redraw.
      const seq = buf.seq + bufs.narbisBeats.seq * 100000;

      const fX: number[] = [];
      const fY: number[] = [];
      const acceptX: number[] = [];
      const acceptY: number[] = [];
      const rejectX: number[] = [];
      const rejectY: number[] = [];

      buf.forEachInWindow(windowSecRef.current, (_ts, v) => {
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
      });

      const tooMany = fX.length > 1500;
      const traces: Data[] = [
        {
          x: fX,
          y: fY,
          type: tooMany ? 'scattergl' : 'scatter',
          mode: 'lines',
          name: 'Filtered',
          line: { color: CHART_COLORS.filtered, width: 1, shape: 'linear' },
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
      return { traces, seq };
    },
  });

  const filteredCount = useDashboardStore((s) => {
    const bufs = s.dataSource === 'replay' ? s.replayBuffers : s.buffers;
    return bufs.filtered.size();
  });

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[180px] relative">
      <div className="px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">Filtered signal + peaks</span>
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
      {filteredCount === 0 ? (
        <div className="absolute inset-0 top-8 flex items-center justify-center pointer-events-none text-xs text-slate-500">
          enable POST_FILTER in diagnostics_mask to see filtered signal
        </div>
      ) : null}
    </div>
  );
}
