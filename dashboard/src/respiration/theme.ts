/*
 * theme.ts — chart chrome and the categorical series palette.
 *
 * SERIES holds the validated categorical order. Slots are assigned in order and
 * never cycled: a panel that would need a 6th series gets split instead. The
 * order itself is the colorblind-safety mechanism — it was validated with the
 * data-viz palette validator against this app's actual card surface (#1e293b),
 * dark mode, adjacent pairlist (which is the one that governs line charts):
 *
 *   worst adjacent CVD ΔE 8.4 (protan, yellow↔aqua), normal-vision ΔE 19.3,
 *   all five slots inside the dark lightness band and above 3:1 on the surface.
 *
 * Do not reorder or substitute a hue without re-running that validator — the
 * pairwise separation is a property of the ORDER, not of the individual colors.
 * Slot 6 (green #008300) is deliberately absent: it measures 2.96:1 here, below
 * the contrast floor for this surface.
 */

/** Categorical slots, in fixed assignment order. Max 5 series per panel. */
export const SERIES = {
  s1: '#3987e5', // blue
  s2: '#d95926', // orange
  s3: '#199e70', // aqua
  s4: '#c98500', // yellow
  s5: '#d55181', // magenta
} as const;

export const SERIES_ORDER = [SERIES.s1, SERIES.s2, SERIES.s3, SERIES.s4, SERIES.s5] as const;

/** Reserved status colors — never used for a plain series. `critical` marks
 * rejected beats, which is a state, not an identity. Always paired with a
 * distinct marker symbol and a legend label so it never reads by color alone. */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

/** Chart chrome. Matches the Narbis dev-hub dark palette so this page sits
 * beside the other tools rather than looking like a different product. */
export const INK = {
  page: '#0f172a',
  surface: '#1e293b',
  surface2: '#263449',
  primary: '#f1f5f9',
  secondary: '#cbd5e1',
  muted: '#94a3b8',
  grid: '#334155',
  axis: '#475569',
  accent: '#14b8a6',
} as const;

/** Base Plotly layout for every panel here. Grid and axes are solid hairlines
 * one shade off the surface — never dashed, which would read as a threshold. */
export function baseLayout(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: INK.secondary, size: 11, family: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
    margin: { l: 58, r: 16, t: 8, b: 34 },
    hovermode: 'x unified',
    hoverlabel: {
      bgcolor: INK.surface2,
      bordercolor: INK.axis,
      font: { color: INK.primary, size: 11 },
    },
    showlegend: false,
    ...extra,
  };
}

/** Shared axis styling. `axisStyle('x')` for the time axis. */
export function axisStyle(kind: 'x' | 'y', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gridcolor: INK.grid,
    zerolinecolor: INK.axis,
    linecolor: INK.axis,
    tickfont: { color: INK.muted, size: 10 },
    ...(kind === 'x' ? { type: 'date' as const } : {}),
    ...extra,
  };
}
