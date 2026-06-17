/*
 * dsp.ts — self-contained DSP utilities for the Coherence Engine.
 *
 * Faithful port of the Swift `DSP` enum (FFT, cubic-spline resample, linear detrend,
 * Hann window, Welch/periodogram PSD). Used by RespirationFromACC; the LS core has
 * its own direct periodogram. Pure functions, no platform deps.
 */

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place iterative radix-2 FFT. `re`/`im` must be a power-of-2 length. */
export function fft(re: number[], im: number[]): void {
  const n = re.length;
  if (n <= 1 || (n & (n - 1)) !== 0) return;
  let j = 0;
  for (let i = 1; i < n; i++) {
    // bit-reversal permutation
    let bit = n >> 1;
    while ((j & bit) !== 0) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  let len = 2;
  while (len <= n) {
    const ang = (-2.0 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1.0;
      let wIm = 0.0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const vRe = re[b] * wRe - im[b] * wIm;
        const vIm = re[b] * wIm + im[b] * wRe;
        const uRe = re[a];
        const uIm = im[a];
        re[a] = uRe + vRe;
        im[a] = uIm + vIm;
        re[b] = uRe - vRe;
        im[b] = uIm - vIm;
        const nwRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nwRe;
      }
    }
    len <<= 1;
  }
}

export interface Resampled {
  t: number[];
  v: number[];
}

/**
 * Natural cubic-spline resample of irregular (x,y) onto a uniform grid at `fs` Hz.
 * `x` is coalesced to strictly-increasing first (a duplicate/backward tick would NaN
 * the whole spline). Returns null if fewer than 3 usable points.
 */
export function cubicResample(xin: number[], yin: number[], fs: number): Resampled | null {
  if (fs <= 0) return null;
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < xin.length; i++) {
    if (x.length > 0 && xin[i] <= x[x.length - 1]) continue;
    x.push(xin[i]);
    y.push(yin[i]);
  }
  const n = x.length;
  if (n < 3) return null;

  const y2 = new Array<number>(n).fill(0); // second derivatives (Numerical Recipes)
  const u = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const sig = (x[i] - x[i - 1]) / (x[i + 1] - x[i - 1]);
    const p = sig * y2[i - 1] + 2.0;
    y2[i] = (sig - 1.0) / p;
    let ui = (y[i + 1] - y[i]) / (x[i + 1] - x[i]) - (y[i] - y[i - 1]) / (x[i] - x[i - 1]);
    ui = (6.0 * ui) / (x[i + 1] - x[i - 1]);
    u[i] = (ui - sig * u[i - 1]) / p;
  }
  for (let k = n - 2; k >= 0; k--) y2[k] = y2[k] * y2[k + 1] + u[k];

  const x0 = x[0];
  const x1 = x[n - 1];
  const dt = 1.0 / fs;
  const t: number[] = [];
  const v: number[] = [];
  let xi = x0;
  let klo = 0;
  while (xi <= x1 + 1e-9) {
    while (klo < n - 2 && x[klo + 1] < xi) klo += 1;
    const khi = klo + 1;
    const h = x[khi] - x[klo];
    if (h <= 0) {
      xi += dt;
      continue;
    }
    const a = (x[khi] - xi) / h;
    const b = (xi - x[klo]) / h;
    const val =
      a * y[klo] +
      b * y[khi] +
      (((a * a * a - a) * y2[klo] + (b * b * b - b) * y2[khi]) * (h * h)) / 6.0;
    t.push(xi);
    v.push(val);
    xi += dt;
  }
  return { t, v };
}

export function linearDetrend(y: number[]): number[] {
  const n = y.length;
  if (n <= 1) return y.slice();
  const my = y.reduce((s, v) => s + v, 0) / n;
  const mx = (n - 1) / 2.0;
  let sxx = 0.0;
  let sxy = 0.0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx;
    sxx += dx * dx;
    sxy += dx * (y[i] - my);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  return y.map((_, i) => y[i] - (slope * i + intercept));
}

/**
 * Smoothness-priors detrend (Tarvainen 2002 / Kubios). Removes the slow trend from a series treated
 * as evenly spaced by index: `detrended = z − trend`, where trend solves
 *   (I + λ²·D₂ᵀD₂)·trend = z
 * with D₂ the (N−2)×N second-difference operator (rows [1,−2,1]). M = I + λ²·D₂ᵀD₂ is symmetric-
 * positive-definite PENTADIAGONAL, solved BANDED in O(N) via LDLᵀ (half-bandwidth 2) — no dense
 * solve. λ sets the trend cutoff (≈0.035 Hz on an RR tachogram at λ=500). The trend absorbs DC, so
 * the result is already ~zero-mean (do not re-subtract the mean).
 */
export function smoothnessPriorsDetrend(z: number[], lambda: number): number[] {
  const n = z.length;
  if (n === 0) return [];
  // D₂ needs ≥3 points and the closed-form boundary rows below are exact only for N≥4. Smaller N or
  // a non-positive/non-finite λ → mean removal (no trend model to fit).
  if (n <= 3 || !(lambda > 0) || !Number.isFinite(lambda)) {
    const mean = z.reduce((s, v) => s + v, 0) / n;
    return z.map((v) => v - mean);
  }
  const l = lambda * lambda;

  // Bands of M = I + λ²·D₂ᵀD₂ (symmetric, half-bandwidth 2). d = main diagonal, e[i] = M[i][i+1],
  // f[i] = M[i][i+2] = λ² (constant). D₂ᵀD₂ is the Tarvainen Gram matrix; its boundary rows
  // {0,1,N−2,N−1} differ from the interior 6/−4/1 stencil (verified by direct expansion for N=4,6).
  const d = new Float64Array(n);
  const e = new Float64Array(n); // e[i] = M[i][i+1], valid 0..n-2
  const f = new Float64Array(n); // f[i] = M[i][i+2] = l, valid 0..n-3
  for (let i = 0; i < n; i++) {
    const aii = i === 0 || i === n - 1 ? 1 : i === 1 || i === n - 2 ? 5 : 6;
    d[i] = 1 + l * aii;
  }
  for (let i = 0; i < n - 1; i++) e[i] = l * (i === 0 || i === n - 2 ? -2 : -4);
  for (let i = 0; i < n - 2; i++) f[i] = l;

  // Symmetric pentadiagonal LDLᵀ: M = L·diag(Dg)·Lᵀ, L unit-lower with l1[i]=L[i][i-1], l2[i]=L[i][i-2].
  const Dg = new Float64Array(n);
  const l1 = new Float64Array(n);
  const l2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const mi1 = i >= 1 ? e[i - 1] : 0; // M[i][i-1]
    const mi2 = i >= 2 ? f[i - 2] : 0; // M[i][i-2]
    if (i >= 2) l2[i] = mi2 / Dg[i - 2];
    if (i >= 1) l1[i] = (mi1 - (i >= 2 ? l2[i] * Dg[i - 2] * l1[i - 1] : 0)) / Dg[i - 1];
    Dg[i] =
      d[i] -
      (i >= 1 ? l1[i] * l1[i] * Dg[i - 1] : 0) -
      (i >= 2 ? l2[i] * l2[i] * Dg[i - 2] : 0);
    // SPD ⇒ every pivot > 0; a non-positive pivot is only reachable on NaN/Inf input → fall back.
    if (!(Dg[i] > 0)) return linearDetrend(z);
  }

  // Solve M·trend = z in three O(N) sweeps: forward (L·w=z), diagonal (Dg·u=w), back (Lᵀ·trend=u).
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = z[i] - (i >= 1 ? l1[i] * w[i - 1] : 0) - (i >= 2 ? l2[i] * w[i - 2] : 0);
  }
  const u = new Float64Array(n);
  for (let i = 0; i < n; i++) u[i] = w[i] / Dg[i];
  const trend = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    trend[i] =
      u[i] -
      (i + 1 < n ? l1[i + 1] * trend[i + 1] : 0) -
      (i + 2 < n ? l2[i + 2] * trend[i + 2] : 0);
  }

  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = z[i] - trend[i];
  return out;
}

export function hann(n: number): number[] {
  if (n <= 1) return new Array<number>(Math.max(n, 0)).fill(1);
  const w = new Array<number>(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2.0 * Math.PI * i) / (n - 1));
  return w;
}

export interface PSD {
  freqs: number[];
  psd: number[];
}

/** One-sided PSD via Welch averaging. PSD is in (input units)²/Hz. */
export function welchPSD(signal: number[], fs: number, segLen: number, overlap: number): PSD | null {
  const n = signal.length;
  if (n < 8) return null;
  const seg = segLen >= 8 && segLen <= n ? segLen : n;
  const nfft = nextPow2(seg);
  const win = hann(seg);
  const winPow = win.reduce((s, v) => s + v * v, 0); // Σ w²
  const step = Math.max(1, Math.floor(seg * (1.0 - overlap)));
  const acc = new Array<number>(nfft / 2 + 1).fill(0);
  let count = 0;
  let start = 0;
  while (start + seg <= n) {
    const s = linearDetrend(signal.slice(start, start + seg));
    for (let i = 0; i < seg; i++) s[i] *= win[i];
    const re = s.concat(new Array<number>(nfft - seg).fill(0));
    const im = new Array<number>(nfft).fill(0);
    fft(re, im);
    for (let k = 0; k <= nfft / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      const oneSided = k === 0 || k === nfft / 2 ? 1.0 : 2.0;
      acc[k] += (oneSided * p) / (fs * winPow);
    }
    count += 1;
    start += step;
  }
  if (count === 0) return null;
  const psd = acc.map((v) => v / count);
  const df = fs / nfft;
  const freqs = acc.map((_, k) => k * df);
  return { freqs, psd };
}

/** Single-segment one-sided PSD (used for the ACC respiration periodogram). */
export function periodogram(signal: number[], fs: number): PSD | null {
  return welchPSD(signal, fs, signal.length, 0);
}

export interface CoherenceSpectrum {
  freqs: number[];
  gammaSq: number[]; // magnitude-squared coherence γ²(f) ∈ [0,1]
  phaseDeg: number[]; // cross-spectrum phase ∠Sxy in degrees; +ve = x leads y
}

/**
 * Welch magnitude-squared coherence γ²(f) and phase between two equal-rate signals. For each Hann-
 * windowed, linearly-detrended segment, accumulate Sxx=|X|², Syy=|Y|², Sxy=X·conj(Y); then
 *   γ²(f) = |Sxy|² / (Sxx·Syy) ∈ [0,1],   phase(f) = ∠Sxy   (+ve ⇒ x leads y).
 * ⚠ γ² is identically 1 for a SINGLE segment (|Sxy|²≡Sxx·Syy), so we require ≥2 segments and return
 * null otherwise — a degenerate 1.0 would be worse than reporting "can't assess". Mirrors welchPSD's
 * segmenting/windowing; the one-sided 2× factor is omitted since it cancels in γ² and the phase.
 */
export function welchCoherence(
  x: number[],
  y: number[],
  fs: number,
  segLen: number,
  overlap: number,
): CoherenceSpectrum | null {
  const n = Math.min(x.length, y.length);
  if (n < 8) return null;
  const seg = segLen >= 8 && segLen <= n ? segLen : n;
  const nfft = nextPow2(seg);
  const win = hann(seg);
  const half = nfft / 2;
  const step = Math.max(1, Math.floor(seg * (1.0 - overlap)));
  const sxx = new Array<number>(half + 1).fill(0);
  const syy = new Array<number>(half + 1).fill(0);
  const sxyRe = new Array<number>(half + 1).fill(0);
  const sxyIm = new Array<number>(half + 1).fill(0);
  let count = 0;
  let start = 0;
  while (start + seg <= n) {
    const xs = linearDetrend(x.slice(start, start + seg));
    const ys = linearDetrend(y.slice(start, start + seg));
    for (let i = 0; i < seg; i++) {
      xs[i] *= win[i];
      ys[i] *= win[i];
    }
    const xr = xs.concat(new Array<number>(nfft - seg).fill(0));
    const xi = new Array<number>(nfft).fill(0);
    const yr = ys.concat(new Array<number>(nfft - seg).fill(0));
    const yi = new Array<number>(nfft).fill(0);
    fft(xr, xi);
    fft(yr, yi);
    for (let k = 0; k <= half; k++) {
      sxx[k] += xr[k] * xr[k] + xi[k] * xi[k];
      syy[k] += yr[k] * yr[k] + yi[k] * yi[k];
      sxyRe[k] += xr[k] * yr[k] + xi[k] * yi[k]; // Re(X·conj(Y))
      sxyIm[k] += xi[k] * yr[k] - xr[k] * yi[k]; // Im(X·conj(Y))
    }
    count += 1;
    start += step;
  }
  if (count < 2) return null; // ⚠ see note above — never return a degenerate single-segment γ²=1
  const gammaSq = new Array<number>(half + 1);
  const phaseDeg = new Array<number>(half + 1);
  for (let k = 0; k <= half; k++) {
    const num = sxyRe[k] * sxyRe[k] + sxyIm[k] * sxyIm[k];
    const den = sxx[k] * syy[k];
    gammaSq[k] = den > 1e-20 ? Math.min(1, num / den) : 0; // clamp float overshoot
    phaseDeg[k] = (Math.atan2(sxyIm[k], sxyRe[k]) * 180) / Math.PI;
  }
  const df = fs / nfft;
  const freqs = new Array<number>(half + 1);
  for (let k = 0; k <= half; k++) freqs[k] = k * df;
  return { freqs, gammaSq, phaseDeg };
}
