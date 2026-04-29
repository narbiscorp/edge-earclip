/**
 * Centered moving-average smoother. O(N) total via cumulative-sum trick —
 * cost is independent of window size N. Edge samples use the available
 * partial window so the output array is the same length as the input.
 *
 * Used by the streaming charts to reduce visual jitter without dropping
 * samples (decimation) or distorting timing (which causal filters do).
 * For typical PPG at 50 Hz, N=3 takes the edge off without softening
 * peaks; N=7 visibly smooths breath-modulated noise; N=15 is heavy.
 */
export function movingAverage(arr: readonly number[], n: number): number[] {
  if (n <= 1 || arr.length === 0) return arr.slice();
  const len = arr.length;
  const cum = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) {
    cum[i + 1] = cum[i] + arr[i];
  }
  const out = new Array<number>(len);
  const half = Math.floor(n / 2);
  for (let i = 0; i < len; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(len, i + half + 1);
    out[i] = (cum[hi] - cum[lo]) / (hi - lo);
  }
  return out;
}

/**
 * Holds a Y-axis range and decides when to recompute it.
 *
 * Without this, Plotly's `autorange: true` re-fits the axis on every
 * redraw — which makes the chart visibly jitter as new peaks come in.
 * Locking the range is too rigid (the signal eventually drifts off
 * screen). RescaleLatch is the middle ground: hold the current range
 * for `intervalMs`, then re-fit from the live data.
 *
 * Pass intervalMs = 0 (or negative) to disable latching — `compute()`
 * always returns a fresh range, which the chart can pass to Plotly with
 * `autorange: false` for a stable visual feel that still tracks data.
 */
export class RescaleLatch {
  private range: [number, number] | null = null;
  private lastUpdateMs = 0;

  /**
   * Returns the cached range, recomputing from `values` if the latch
   * has expired or there's no cached range yet. `padFrac` adds a small
   * margin around the data extents (5% is a sensible default).
   */
  compute(values: readonly number[], intervalMs: number, padFrac = 0.05): [number, number] | null {
    if (values.length === 0) return this.range;
    const now = performance.now();
    const expired = intervalMs <= 0 || now - this.lastUpdateMs >= intervalMs || this.range === null;
    if (!expired) return this.range;
    let lo = values[0];
    let hi = values[0];
    for (let i = 1; i < values.length; i++) {
      const v = values[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === hi) {
      // Flat trace — give it a tiny window so Plotly doesn't collapse the axis.
      const eps = Math.max(1, Math.abs(lo) * 0.001);
      lo -= eps;
      hi += eps;
    } else {
      const pad = (hi - lo) * padFrac;
      lo -= pad;
      hi += pad;
    }
    this.range = [lo, hi];
    this.lastUpdateMs = now;
    return this.range;
  }

  /** Force the next compute() call to recompute, regardless of interval. */
  invalidate(): void {
    this.range = null;
    this.lastUpdateMs = 0;
  }
}
