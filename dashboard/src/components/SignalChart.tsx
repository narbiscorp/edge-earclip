import { useRef, useState } from 'react';
import type { Data } from 'plotly.js';
import { useDashboardStore } from '../state/store';
import { useLivePlot } from '../charts/useLivePlot';
import { CHART_COLORS, darkLayout } from '../charts/chartTheme';

const WINDOW_SEC = 30;

export default function SignalChart() {
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

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
      yaxis: {
        gridcolor: '#334155',
        zerolinecolor: '#475569',
        linecolor: '#475569',
        title: { text: 'Red' },
      },
      yaxis2: {
        overlaying: 'y',
        side: 'right',
        title: { text: 'IR' },
        gridcolor: 'transparent',
        zerolinecolor: 'transparent',
        linecolor: '#475569',
      },
      showlegend: true,
    }),
    pull: () => {
      const buf = useDashboardStore.getState().buffers.rawPpg;
      const samples = buf.getWindow(WINDOW_SEC);
      const x = new Array<number>(samples.length);
      const red = new Array<number>(samples.length);
      const ir = new Array<number>(samples.length);
      for (let i = 0; i < samples.length; i++) {
        x[i] = samples[i].timestamp;
        red[i] = samples[i].value.red;
        ir[i] = samples[i].value.ir;
      }
      const traces: Data[] = [
        {
          x,
          y: red,
          type: 'scattergl',
          mode: 'lines',
          name: 'Red',
          line: { color: CHART_COLORS.red, width: 1 },
          yaxis: 'y',
        },
        {
          x,
          y: ir,
          type: 'scattergl',
          mode: 'lines',
          name: 'IR',
          line: { color: CHART_COLORS.ir, width: 1 },
          yaxis: 'y2',
        },
      ];
      return { traces };
    },
  });

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 flex flex-col min-h-[220px]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-800">
        <span className="text-xs font-medium text-slate-300">Raw PPG (30 s)</span>
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          className="text-xs px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>
      <div ref={divRef} className="flex-1 min-h-0" />
    </div>
  );
}
