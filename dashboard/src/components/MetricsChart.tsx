import type { Data } from 'plotly.js';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';
import { metricsBuffers, type MetricsSnapshot } from '../state/metricsBuffer';
import { useDashboardStore } from '../state/store';

const WINDOW_SEC = 600;

interface Series {
  x: number[];
  y: number[];
}

function emptySeries(): Series {
  return { x: [], y: [] };
}

export default function MetricsChart() {
  const divRef = useLivePlot({
    id: 'metrics',
    refreshHz: 2,
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
        title: { text: 'ms / bpm' },
      },
      yaxis2: {
        overlaying: 'y',
        side: 'right',
        title: { text: 'ratio / coherence' },
        gridcolor: 'transparent',
        zerolinecolor: 'transparent',
        linecolor: '#475569',
      },
      showlegend: true,
    }),
    pull: () => {
      const source = useDashboardStore.getState().dataSource;
      const samples = (source === 'replay' ? metricsBuffers.replay : metricsBuffers.live).getWindow(WINDOW_SEC);
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

      const traces: Data[] = [
        {
          x: hr.x, y: hr.y, name: 'mean HR',
          type: 'scattergl', mode: 'lines',
          line: { color: CHART_COLORS.hr, width: 1.5 },
          yaxis: 'y',
        },
        {
          x: rmssd.x, y: rmssd.y, name: 'rMSSD',
          type: 'scattergl', mode: 'lines',
          line: { color: CHART_COLORS.rmssd, width: 1.5 },
          yaxis: 'y',
        },
        {
          x: sdnn.x, y: sdnn.y, name: 'SDNN',
          type: 'scattergl', mode: 'lines',
          line: { color: CHART_COLORS.sdnn, width: 1.5 },
          yaxis: 'y',
          visible: 'legendonly',
        },
        {
          x: lf.x, y: lf.y, name: 'LF',
          type: 'scattergl', mode: 'lines',
          line: { color: CHART_COLORS.lf, width: 1.5 },
          yaxis: 'y',
          visible: 'legendonly',
        },
        {
          x: hf.x, y: hf.y, name: 'HF',
          type: 'scattergl', mode: 'lines',
          line: { color: CHART_COLORS.hf, width: 1.5 },
          yaxis: 'y',
          visible: 'legendonly',
        },
        {
          x: lfhf.x, y: lfhf.y, name: 'LF/HF',
          type: 'scattergl', mode: 'lines',
          line: { color: CHART_COLORS.lfhf, width: 1.5 },
          yaxis: 'y2',
          visible: 'legendonly',
        },
        {
          x: resonance.x, y: resonance.y, name: 'Coherence (resonance)',
          type: 'scattergl', mode: 'lines',
          line: { color: CHART_COLORS.resonance, width: 2 },
          yaxis: 'y2',
        },
        {
          x: hm.x, y: hm.y, name: 'Coherence (HeartMath)',
          type: 'scattergl', mode: 'lines',
          line: { color: CHART_COLORS.hm, width: 1.5, dash: 'dot' },
          yaxis: 'y2',
          visible: 'legendonly',
        },
      ];
      return { traces };
    },
  });

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[220px]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">HRV metrics (10 min)</span>
        <span className="text-[10px] text-slate-500">click legend to toggle traces</span>
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
    </div>
  );
}
