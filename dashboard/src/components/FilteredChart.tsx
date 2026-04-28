import type { Data } from 'plotly.js';
import { useDashboardStore } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';

const WINDOW_SEC = 30;

export default function FilteredChart() {
  const divRef = useLivePlot({
    id: 'filtered',
    baseLayout: darkLayout({
      xaxis: {
        gridcolor: '#334155',
        zerolinecolor: '#475569',
        linecolor: '#475569',
        type: 'date',
      },
      yaxis: {
        gridcolor: '#334155',
        zerolinecolor: '#475569',
        linecolor: '#475569',
        title: { text: 'Filtered' },
      },
      showlegend: true,
    }),
    pull: () => {
      const buf = useDashboardStore.getState().buffers.filtered;
      const samples = buf.getWindow(WINDOW_SEC);

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

      const traces: Data[] = [
        {
          x: fX,
          y: fY,
          type: 'scattergl',
          mode: 'lines',
          name: 'Filtered',
          line: { color: CHART_COLORS.filtered, width: 1 },
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
      return { traces };
    },
  });

  const filteredCount = useDashboardStore((s) => s.buffers.filtered.size());

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[220px] relative">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">Filtered signal + peaks (30 s)</span>
        <span className="text-[10px] text-slate-500">diagnostic stream</span>
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
      {filteredCount === 0 ? (
        <div className="absolute inset-0 top-8 flex items-center justify-center pointer-events-none text-xs text-slate-500">
          awaiting diagnostic stream
        </div>
      ) : null}
    </div>
  );
}
