import type { Data } from 'plotly.js';
import { useDashboardStore } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import { isArtifactBeat } from '../metrics/windowing';

const WINDOW_SEC = 300;

export default function BeatChart() {
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
      yaxis: {
        gridcolor: '#334155',
        zerolinecolor: '#475569',
        linecolor: '#475569',
        title: { text: 'IBI (ms)' },
        range: [400, 1400],
      },
      showlegend: true,
    }),
    pull: () => {
      const state = useDashboardStore.getState();
      const earclipSamples = state.buffers.narbisBeats.getWindow(WINDOW_SEC);
      const polarSamples = state.buffers.polarBeats.getWindow(WINDOW_SEC);

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

      const traces: Data[] = [
        {
          x: ecX,
          y: ecY,
          type: 'scattergl',
          mode: 'lines+markers',
          name: 'Earclip',
          line: { color: CHART_COLORS.earclip, width: 1 },
          marker: { color: CHART_COLORS.earclip, size: 4 },
        },
        {
          x: polarX,
          y: polarY,
          type: 'scattergl',
          mode: 'lines+markers',
          name: 'Polar H10',
          line: { color: CHART_COLORS.polar, width: 1 },
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
      return { traces };
    },
  });

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[220px]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">IBI tachogram (5 min)</span>
        <span className="text-[10px] text-slate-500">earclip + Polar H10</span>
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
    </div>
  );
}
