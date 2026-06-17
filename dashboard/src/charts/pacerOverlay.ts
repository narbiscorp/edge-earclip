// Secondary-axis "paced breathing rate" overlay for the session report charts.
//
// In Mode B/C the engine sweeps through candidate breathing rates while it searches for resonance.
// Overlaying the paced br/min (a stepped amber line on a right-hand axis) on the IBI tachogram and the
// coherence-over-time chart lets you correlate which breathing rate drove the biggest HRV swings and
// the highest coherence. Shared by the live SessionSummaryModal and the historic SessionDetailModal.
import type { Data, LayoutAxis } from 'plotly.js';

export interface PacerOverlay {
  trace: Data;
  yaxis2: Partial<LayoutAxis>;
}

/**
 * Build the paced-rate overlay (a `y2` trace + the right-hand axis) from time-aligned arrays:
 * `offsetSec[i]` is seconds-since-start and `pacerBpm[i]` the commanded breathing rate there. Returns
 * null when there's nothing meaningful to show (no samples, or every rate is 0 — e.g. a non-paced run).
 */
export function pacerOverlay(offsetSec: number[], pacerBpm: number[]): PacerOverlay | null {
  const n = Math.min(offsetSec.length, pacerBpm.length);
  if (n === 0) return null;
  const valid = pacerBpm.slice(0, n).filter((v) => v > 0);
  if (valid.length === 0) return null;
  const lo = Math.max(0, Math.floor(Math.min(...valid) - 1));
  const hi = Math.ceil(Math.max(...valid) + 1);
  const trace = {
    x: offsetSec.slice(0, n),
    y: pacerBpm.slice(0, n),
    type: 'scatter',
    mode: 'lines',
    name: 'Paced br/min',
    line: { color: '#fbbf24', width: 1.5, shape: 'hv' }, // amber, stepped — distinct from IBI/coherence
    yaxis: 'y2',
    hovertemplate: 'paced %{y:.1f} br/min<extra></extra>',
  } as Data;
  const yaxis2: Partial<LayoutAxis> = {
    title: { text: 'Paced (br/min)' },
    overlaying: 'y',
    side: 'right',
    showgrid: false,
    zeroline: false,
    range: [lo, hi],
    color: '#fbbf24',
  };
  return { trace, yaxis2 };
}
