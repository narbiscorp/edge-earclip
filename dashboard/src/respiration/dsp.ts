/*
 * dsp.ts — display-time signal conditioning for the Respiration Analysis app.
 *
 * Everything here is pure and operates on plain number arrays, so the same call
 * chain runs for the live plot and for the CSV export preview. Filters are
 * ZERO-PHASE where it matters: a tachogram peak that shifts in time is worse
 * than a noisy one when you are lining a breath up against an RR trough.
 *
 * The pipeline a trace goes through is always: resample → filter → decimate.
 * Resampling first means a filter's "N samples" means a fixed amount of TIME
 * once a resample rate is set, which is what you want when comparing a 50 Hz
 * accelerometer axis against a ~1 Hz tachogram.
 */

/** Centered moving average (box filter). Edges use the partial window, so the
 * output is the same length as the input and no samples are invented. */
export function movingAverage(y: readonly number[], n: number): number[] {
  const len = y.length;
  if (n <= 1 || len === 0) return y.slice();
  const half = Math.floor(n / 2);
  // Cumulative sum in f64 — cost is independent of window size.
  const cum = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) cum[i + 1] = cum[i] + y[i];
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(len, i + half + 1);
    out[i] = (cum[hi] - cum[lo]) / (hi - lo);
  }
  return out;
}

/** Centered median filter. The one filter that removes an isolated ectopic beat
 * outright instead of smearing it across its neighbours. */
export function medianFilter(y: readonly number[], n: number): number[] {
  const len = y.length;
  if (n <= 1 || len === 0) return y.slice();
  const half = Math.floor(n / 2);
  const out = new Array<number>(len);
  const scratch: number[] = [];
  for (let i = 0; i < len; i++) {
    scratch.length = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(len, i + half + 1);
    for (let j = lo; j < hi; j++) scratch.push(y[j]);
    scratch.sort((a, b) => a - b);
    const m = scratch.length >> 1;
    out[i] = scratch.length % 2 ? scratch[m] : (scratch[m - 1] + scratch[m]) / 2;
  }
  return out;
}

/** Exponential moving average run forward then backward. The reverse pass
 * cancels the forward pass's group delay, so features stay put in time — a
 * single-pass EWMA would drag every RR trough later than the breath that
 * caused it. `alpha` is per-sample: smaller = heavier smoothing. */
export function ewmaZeroPhase(y: readonly number[], alpha: number): number[] {
  const len = y.length;
  if (len === 0) return [];
  const a = Math.max(0, Math.min(1, alpha));
  if (a >= 1) return y.slice();
  if (a <= 0) return y.slice();
  const fwd = new Array<number>(len);
  let acc = y[0];
  for (let i = 0; i < len; i++) {
    acc = a * y[i] + (1 - a) * acc;
    fwd[i] = acc;
  }
  const out = new Array<number>(len);
  acc = fwd[len - 1];
  for (let i = len - 1; i >= 0; i--) {
    acc = a * fwd[i] + (1 - a) * acc;
    out[i] = acc;
  }
  return out;
}

/** Solve A·x = b in place for a small dense system (Gaussian elimination with
 * partial pivoting). Returns null if the system is singular. */
function solveDense(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) return null;
    if (pivot !== col) {
      const tr = A[pivot];
      A[pivot] = A[col];
      A[col] = tr;
      const tb = b[pivot];
      b[pivot] = b[col];
      b[col] = tb;
    }
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

/**
 * Savitzky–Golay convolution weights for a window of `2·half+1` samples fitting
 * a polynomial of `order`, evaluated at offset `t` from the window centre.
 *
 * The fit is c = (AᵀA)⁻¹Aᵀy with A[k][p] = kᵖ, and the output is p(t) = v(t)ᵀc
 * where v(t) = [1, t, t², …]. Since AᵀA is symmetric, that collapses to a plain
 * dot product against y: solve (AᵀA)g = v(t) once, then weight_k = Σ g_p·kᵖ.
 *
 * `t = 0` gives the usual centre-of-window kernel used across the interior.
 * Non-zero `t` is how the edges are handled — see savitzkyGolay.
 */
function savgolWeights(half: number, order: number, t: number): number[] | null {
  const m = 2 * half + 1;
  const nc = Math.min(order, m - 1) + 1;
  const ata: number[][] = [];
  for (let i = 0; i < nc; i++) ata.push(new Array<number>(nc).fill(0));
  for (let k = -half; k <= half; k++) {
    const pows = new Array<number>(nc);
    pows[0] = 1;
    for (let p = 1; p < nc; p++) pows[p] = pows[p - 1] * k;
    for (let i = 0; i < nc; i++) {
      for (let j = 0; j < nc; j++) ata[i][j] += pows[i] * pows[j];
    }
  }
  const rhs = new Array<number>(nc);
  rhs[0] = 1;
  for (let p = 1; p < nc; p++) rhs[p] = rhs[p - 1] * t;
  const g = solveDense(ata, rhs);
  if (!g) return null;
  const w = new Array<number>(m);
  for (let k = -half; k <= half; k++) {
    let s = 0;
    let pk = 1;
    for (let p = 0; p < nc; p++) {
      s += g[p] * pk;
      pk *= k;
    }
    w[k + half] = s;
  }
  return w;
}

/**
 * Savitzky–Golay filter: local least-squares polynomial fit. Unlike a box or
 * EWMA filter it preserves peak HEIGHT and WIDTH, which is why it is the usual
 * choice for respiratory and pulse waveforms where the amplitude is itself the
 * measurement.
 *
 * Edges are handled by fitting the first/last full window and evaluating that
 * polynomial at the edge positions, rather than by padding. Padding is what
 * most implementations do and it is wrong for anything with a trend: mirroring
 * a rising line about its first sample produces a V, and the filter then bends
 * the start of the signal downward. Fitting the edge window instead reproduces
 * any polynomial up to `order` exactly, everywhere — which is the property the
 * filter is chosen for in the first place.
 */
export function savitzkyGolay(y: readonly number[], n: number, order: number): number[] {
  const len = y.length;
  if (n <= 1 || len === 0) return y.slice();
  const half = Math.max(1, Math.floor(n / 2));
  const m = 2 * half + 1;
  if (len < m) return movingAverage(y, n);
  const deg = Math.max(1, order);
  const centre = savgolWeights(half, deg, 0);
  if (!centre) return movingAverage(y, n);

  const out = new Array<number>(len);
  // Interior: one shared kernel, centered on each sample.
  for (let i = half; i < len - half; i++) {
    let s = 0;
    for (let k = 0; k < m; k++) s += centre[k] * y[i - half + k];
    out[i] = s;
  }
  // Leading edge: the polynomial fitted to y[0..m-1], evaluated at offset i-half.
  for (let i = 0; i < half; i++) {
    const w = savgolWeights(half, deg, i - half) ?? centre;
    let s = 0;
    for (let k = 0; k < m; k++) s += w[k] * y[k];
    out[i] = s;
  }
  // Trailing edge: the polynomial fitted to the last m samples.
  const lastCentre = len - 1 - half;
  for (let i = len - half; i < len; i++) {
    const w = savgolWeights(half, deg, i - lastCentre) ?? centre;
    let s = 0;
    for (let k = 0; k < m; k++) s += w[k] * y[len - m + k];
    out[i] = s;
  }
  return out;
}

/** Monotone cubic Hermite (PCHIP) interpolation onto a uniform grid.
 *
 * Plain cubic splines overshoot: run one through a tachogram and it invents RR
 * values below the shortest measured beat, which then propagate straight into
 * RMSSD. The Fritsch–Carlson slope limiter makes the interpolant monotone on
 * every interval, so the curve stays inside the data it was built from.
 *
 * `x` must be strictly increasing (ms). Returns an empty result if there is
 * not enough data or the requested rate is not positive. */
export function pchipResample(
  x: readonly number[],
  y: readonly number[],
  hz: number,
): { x: number[]; y: number[] } {
  const n = Math.min(x.length, y.length);
  if (n < 2 || hz <= 0) return { x: x.slice(0, n), y: y.slice(0, n) };

  // Interval widths and secant slopes.
  const h = new Array<number>(n - 1);
  const delta = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = x[i + 1] - x[i];
    if (h[i] <= 0) return { x: x.slice(0, n), y: y.slice(0, n) }; // not sorted — bail rather than lie
    delta[i] = (y[i + 1] - y[i]) / h[i];
  }

  // Fritsch–Carlson tangents: zero at local extrema, weighted harmonic mean elsewhere.
  const d = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      d[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  // One-sided ends, clamped so the endpoint tangent cannot overshoot its interval.
  d[0] = endpointSlope(h[0], h[1] ?? h[0], delta[0], delta[1] ?? delta[0]);
  d[n - 1] = endpointSlope(
    h[n - 2],
    h[n - 3] ?? h[n - 2],
    delta[n - 2],
    delta[n - 3] ?? delta[n - 2],
  );

  const stepMs = 1000 / hz;
  const outX: number[] = [];
  const outY: number[] = [];
  const first = Math.ceil(x[0] / stepMs) * stepMs;
  let seg = 0;
  for (let t = first; t <= x[n - 1]; t += stepMs) {
    while (seg < n - 2 && t > x[seg + 1]) seg++;
    const s = t - x[seg];
    const hh = h[seg];
    const t1 = s / hh;
    const t2 = t1 * t1;
    const t3 = t2 * t1;
    // Hermite basis.
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t1;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    outX.push(t);
    outY.push(h00 * y[seg] + h10 * hh * d[seg] + h01 * y[seg + 1] + h11 * hh * d[seg + 1]);
  }
  return { x: outX, y: outY };
}

/** Three-point one-sided endpoint slope with the standard shape-preserving clamp. */
function endpointSlope(h0: number, h1: number, d0: number, d1: number): number {
  const s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (s * d0 <= 0) return 0;
  if (d0 * d1 <= 0 && Math.abs(s) > Math.abs(3 * d0)) return 3 * d0;
  return s;
}

/**
 * Largest-Triangle-Three-Buckets downsampling for display only.
 *
 * A 50 Hz accelerometer axis over a 10 minute window is 30 000 points per
 * trace; drawing them all costs more than it shows. Plain stride-decimation
 * would drop the peaks — LTTB keeps whichever sample in each bucket preserves
 * the most visual area, so the envelope of a breathing waveform survives.
 * The recorded log is never decimated; this only affects what is drawn.
 */
export function decimateLTTB(
  x: readonly number[],
  y: readonly number[],
  threshold: number,
): { x: number[]; y: number[] } {
  const n = Math.min(x.length, y.length);
  if (threshold <= 2 || n <= threshold) return { x: x.slice(0, n), y: y.slice(0, n) };

  const outX: number[] = [x[0]];
  const outY: number[] = [y[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;

  for (let i = 0; i < threshold - 2; i++) {
    // Mean of the NEXT bucket — the third triangle vertex.
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    const avgN = Math.max(1, avgEnd - avgStart);
    for (let j = avgStart; j < avgEnd; j++) {
      avgX += x[j];
      avgY += y[j];
    }
    avgX /= avgN;
    avgY /= avgN;

    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.min(Math.floor((i + 1) * every) + 1, n);
    const ax = x[a];
    const ay = y[a];
    let best = -1;
    let bestArea = -1;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs((ax - avgX) * (y[j] - ay) - (ax - x[j]) * (avgY - ay));
      if (area > bestArea) {
        bestArea = area;
        best = j;
      }
    }
    if (best < 0) best = rangeStart;
    outX.push(x[best]);
    outY.push(y[best]);
    a = best;
  }

  outX.push(x[n - 1]);
  outY.push(y[n - 1]);
  return { x: outX, y: outY };
}

/**
 * Remove the slow baseline from a signal — the auto-gain half of "make the small movements
 * visible".
 *
 * On a chest accelerometer, gravity puts whichever axis points down at roughly ±1000 mG while
 * the breathing excursion is a few mG riding on top. Plotted raw, the breathing is invisible:
 * it is a 0.3% wiggle on a huge DC offset. Subtracting a slow moving average leaves only the
 * movement, which then fills the panel once the axis autoranges.
 *
 * The baseline is a CENTRED moving average, so it is zero-phase — a causal high-pass would slide
 * every breath later in time than the accelerometer sample that produced it, which matters when
 * the whole point is lining the breath up against the tachogram.
 *
 * `windowSec` sets what counts as "slow": the baseline follows anything slower than roughly
 * 1/windowSec Hz and is subtracted away. 12 s passes normal breathing (0.1-0.5 Hz) while
 * removing gravity and posture drift. Returns a copy unchanged when windowSec <= 0.
 */
export function removeBaseline(
  x: readonly number[],
  y: readonly number[],
  windowSec: number,
): number[] {
  const n = Math.min(x.length, y.length);
  if (windowSec <= 0 || n < 3) return y.slice(0, n);
  // Sample spacing from the span rather than adjacent diffs, so one duplicated
  // timestamp cannot blow up the window length.
  const spanMs = x[n - 1] - x[0];
  if (!(spanMs > 0)) return y.slice(0, n);
  const dtMs = spanMs / (n - 1);
  let win = Math.round((windowSec * 1000) / dtMs);
  if (win % 2 === 0) win += 1; // odd, so the average is truly centred
  if (win < 3) return y.slice(0, n);
  // A baseline window longer than the data has no slow component to estimate; fall back to
  // removing the mean, which is the limit of the same operation.
  if (win >= n) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += y[i];
    const mean = sum / n;
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) out[i] = y[i] - mean;
    return out;
  }
  const base = movingAverage(y.slice(0, n), win);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = y[i] - base[i];
  return out;
}

export type FilterKind = 'none' | 'movavg' | 'median' | 'savgol' | 'ewma';

/** How a trace is conditioned before it is drawn. One of these per chart. */
export interface TraceShaping {
  filter: FilterKind;
  /** Window length in samples for movavg / median / savgol. */
  filterN: number;
  /** Per-sample weight for the zero-phase EWMA. Lower = smoother. */
  ewmaAlpha: number;
  /** Polynomial order for Savitzky–Golay. */
  savgolOrder: number;
  /** Uniform-grid spline resample rate in Hz. 0 disables resampling. */
  resampleHz: number;
  /** Plotly line rendering — 'spline' draws a smooth curve through the points
   * without changing them, which is a different thing from resampling. */
  shape: 'linear' | 'spline' | 'hv';
  /** Max points drawn per trace after conditioning. */
  maxPoints: number;
  /** Baseline-removal window in seconds. 0 disables it and the trace keeps its
   * absolute value. See removeBaseline. */
  detrendSec: number;
}

export const DEFAULT_SHAPING: TraceShaping = {
  filter: 'none',
  filterN: 5,
  ewmaAlpha: 0.2,
  savgolOrder: 2,
  resampleHz: 0,
  shape: 'linear',
  maxPoints: 4000,
  detrendSec: 0,
};

/** Apply the configured filter to an already-uniform series. */
export function applyFilter(y: readonly number[], s: TraceShaping): number[] {
  switch (s.filter) {
    case 'movavg':
      return movingAverage(y, s.filterN);
    case 'median':
      return medianFilter(y, s.filterN);
    case 'savgol':
      return savitzkyGolay(y, s.filterN, s.savgolOrder);
    case 'ewma':
      return ewmaZeroPhase(y, s.ewmaAlpha);
    case 'none':
    default:
      return y.slice();
  }
}

/**
 * Full conditioning chain: spline-resample onto a uniform grid (optional), remove the slow
 * baseline (optional), filter, then decimate for drawing.
 *
 * Order matters. Baseline removal runs on the full-rate series, BEFORE decimation — estimating a
 * 12-second baseline from 2500 points that have already been thinned by a peak-preserving
 * reduction would track the peaks instead of the trend, and subtract the signal along with the
 * drift.
 */
export function shapeSeries(
  x: readonly number[],
  y: readonly number[],
  s: TraceShaping,
): { x: number[]; y: number[] } {
  const n = Math.min(x.length, y.length);
  if (n === 0) return { x: [], y: [] };
  let sx: readonly number[] = x.slice(0, n);
  let sy: readonly number[] = y.slice(0, n);
  if (s.resampleHz > 0 && n >= 2) {
    const r = pchipResample(sx, sy, s.resampleHz);
    sx = r.x;
    sy = r.y;
  }
  if (sy.length === 0) return { x: [], y: [] };
  if (s.detrendSec > 0) sy = removeBaseline(sx, sy, s.detrendSec);
  const filtered = applyFilter(sy, s);
  return decimateLTTB(sx, filtered, s.maxPoints);
}
