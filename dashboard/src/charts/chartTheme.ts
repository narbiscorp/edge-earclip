import type { Layout } from 'plotly.js';

export const CHART_COLORS = {
  red: '#f87171',
  ir: '#a78bfa',
  filtered: '#38bdf8',
  peakAccept: '#34d399',
  peakReject: '#fb923c',
  earclip: '#22d3ee',
  polar: '#f472b6',
  artifact: '#fb7185',
  rmssd: '#34d399',
  sdnn: '#a78bfa',
  hr: '#f87171',
  lf: '#38bdf8',
  hf: '#facc15',
  lfhf: '#fb923c',
  resonance: '#22d3ee',
  hm: '#f472b6',
  /* Dashboard-side firmware-mirror coherence — port of coh_compute. */
  firmwareCoh: '#a3e635',
  /* On-glasses firmware coherence, decoded from the 0xF2 status frame. */
  edgeCoh: '#fde047',
};

export function darkLayout(extra: Partial<Layout> = {}): Partial<Layout> {
  return {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#e2e8f0', size: 11 },
    margin: { l: 56, r: 16, t: 8, b: 32 },
    xaxis: {
      gridcolor: '#334155',
      zerolinecolor: '#475569',
      linecolor: '#475569',
      ...(extra.xaxis ?? {}),
    },
    yaxis: {
      gridcolor: '#334155',
      zerolinecolor: '#475569',
      linecolor: '#475569',
      ...(extra.yaxis ?? {}),
    },
    legend: {
      orientation: 'h',
      y: 1.1,
      x: 0,
      bgcolor: 'transparent',
      font: { color: '#e2e8f0', size: 10 },
    },
    hovermode: 'x',
    ...extra,
  };
}
