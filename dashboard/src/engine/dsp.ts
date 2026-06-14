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
