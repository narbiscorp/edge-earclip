/*
 * firmwareCoherence.ts — direct port of the Edge glasses' coherence_task.
 *
 * Mirrors EDGE/EDGE FIRMWARE/main/main.c::coh_compute (the block around
 * lines 5169..5471 in v4.14.38) line-by-line, using the same constants and
 * band-index bins, so the dashboard can compute the SAME coherence value
 * the glasses are computing — locally, on either earclip beats or H10
 * beats, with no algorithm divergence.
 *
 * Pipeline:
 *   1. Take last COH_WINDOW_S of beats (must have ≥ COH_MIN_IBIS).
 *   2. Linear-interpolate the irregular (beat_ms, ibi_ms) onto a uniform
 *      4 Hz × 256-point grid starting at the first beat in the window.
 *   3. Subtract mean.
 *   4. Multiply by precomputed Hanning window.
 *   5. 256-point radix-2 Cooley-Tukey FFT.
 *   6. One-sided PSD = re² + im² for bins 0..N/2-1.
 *   7. Band integration on bin indices (df = COH_GRID_HZ / COH_GRID_N
 *      = 0.015625 Hz/bin, Task Force 1996 bands):
 *        VLF bins [1..2]   → 0.016..0.047 Hz (skip DC)
 *        LF  bins [3..9]   → 0.047..0.141 Hz
 *        HF  bins [10..25] → 0.156..0.391 Hz
 *      total = vlf + lf + hf.
 *   8. peak_bin = argmax(psd[3..9]); peak_pow = psd[peak_bin].
 *   9. coherence = clamp(peak_pow / total × 100, 0..100).
 *
 * Match-points with firmware (do NOT diverge):
 *   - COH_GRID_HZ = 4, COH_GRID_N = 256, COH_WINDOW_S = 64
 *   - COH_MIN_IBIS = 20
 *   - LF peak search window is the literal LF band [3..9], single-bin
 *     numerator (firmware v4.13.7 fix, v4.14.26 confirmed).
 *   - Coherence multiplier is 100, not 250 (firmware v4.14.31 fix).
 *   - Resonance peak frequency: peak_bin × COH_GRID_HZ / COH_GRID_N × 1000
 *     reported as millihertz.
 *
 * This module is purely functional — caller passes a snapshot of the
 * IBI ring, gets back the coh_state-shaped result. It's safe to run
 * in a Web Worker. Test against firmware 0xF2 packets for parity.
 */

export const COH_GRID_HZ = 4;
export const COH_GRID_N = 256;
export const COH_WINDOW_S = 64;
export const COH_MIN_IBIS = 20;

import {
  NARBIS_COH_PARAMS_DEFAULTS,
  type NarbisCoherenceParams,
} from '../../../protocol/narbis_protocol';

export interface FirmwareCoherenceInput {
  /** Absolute timestamps in ms, sorted ascending. Length must equal ibi_ms. */
  beat_ms: ArrayLike<number>;
  /** R-R intervals in ms aligned with beat_ms (the IBI ending at each beat). */
  ibi_ms: ArrayLike<number>;
  /** Runtime-tunable algorithm params. When omitted, defaults match the
   * firmware's compile-time defaults — useful as a static reference but
   * the parity check against the glasses' 0xF2 stream only holds when
   * BOTH ends use the same params (i.e. pass the same values the dashboard
   * pushed via 0xE0 most recently). */
  params?: NarbisCoherenceParams;
}

export interface FirmwareCoherenceResult {
  /** Coherence score 0..100, matching coh_state.coherence (u8 in firmware). */
  coherence: number;
  /** Respiration peak frequency in millihertz (coh_state.resp_peak_mhz). */
  resp_peak_mhz: number;
  /** Raw band powers — unscaled (firmware applies a u16 fit scale post-hoc;
   * we return the raw float values so callers can scale however they want). */
  vlf_power: number;
  lf_power: number;
  hf_power: number;
  total_power: number;
  /** LF / (LF+HF) × 100 (firmware coh_state.lf_norm). */
  lf_norm: number;
  hf_norm: number;
  /** LF/HF ratio as a float (firmware emits this as fp8.8 in coh_state.lf_hf_fp88). */
  lf_hf_ratio: number;
  /** Number of beats actually used in the window (firmware coh_state.n_ibis_used). */
  n_ibis_used: number;
}

const HANN = (() => {
  const w = new Float64Array(COH_GRID_N);
  for (let i = 0; i < COH_GRID_N; i++) {
    w[i] = 0.5 * (1.0 - Math.cos((2 * Math.PI * i) / (COH_GRID_N - 1)));
  }
  return w;
})();

/**
 * In-place radix-2 Cooley-Tukey FFT. N must be a power of 2.
 * Direct port of main.c::coh_fft. Output is the same arrays after
 * frequency-domain rewriting.
 */
function fftInPlace(re: Float64Array, im: Float64Array, N: number): void {
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  // Butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlen_re = Math.cos(ang);
    const wlen_im = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < N; i += len) {
      let w_re = 1.0;
      let w_im = 0.0;
      for (let k = 0; k < half; k++) {
        const u_re = re[i + k];
        const u_im = im[i + k];
        const v_re = re[i + k + half] * w_re - im[i + k + half] * w_im;
        const v_im = re[i + k + half] * w_im + im[i + k + half] * w_re;
        re[i + k] = u_re + v_re;
        im[i + k] = u_im + v_im;
        re[i + k + half] = u_re - v_re;
        im[i + k + half] = u_im - v_im;
        const new_w_re = w_re * wlen_re - w_im * wlen_im;
        w_im = w_re * wlen_im + w_im * wlen_re;
        w_re = new_w_re;
      }
    }
  }
}

/**
 * Linear-interpolate the irregular (beat_ms, ibi_ms) onto the firmware's
 * uniform 4 Hz × 256-point grid starting at beat_ms[0]. Mirrors
 * main.c::coh_resample exactly — same binary search, same clamp at the
 * extremes, same linear formula.
 */
function resampleOntoGrid(
  beat_ms: ArrayLike<number>,
  ibi_ms: ArrayLike<number>,
  n_beats: number,
  outGrid: Float64Array,
): void {
  const t0 = beat_ms[0];
  for (let i = 0; i < COH_GRID_N; i++) {
    const t_s = i / COH_GRID_HZ;
    const abs_ms = t0 + Math.floor(t_s * 1000);
    if (abs_ms <= beat_ms[0]) {
      outGrid[i] = ibi_ms[0];
      continue;
    }
    if (abs_ms >= beat_ms[n_beats - 1]) {
      outGrid[i] = ibi_ms[n_beats - 1];
      continue;
    }
    // Binary search for the bracketing pair [lo, hi]
    let lo = 0;
    let hi = n_beats - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (beat_ms[mid] <= abs_ms) lo = mid; else hi = mid;
    }
    const dt = beat_ms[hi] - beat_ms[lo];
    const frac = dt > 0 ? (abs_ms - beat_ms[lo]) / dt : 0;
    outGrid[i] = ibi_ms[lo] + frac * (ibi_ms[hi] - ibi_ms[lo]);
  }
}

/**
 * Compute coherence on a snapshot of the IBI ring. Returns null when
 * there are fewer than COH_MIN_IBIS beats in the trailing COH_WINDOW_S
 * window — same condition the firmware uses to skip the publish step
 * inside coh_compute.
 */
export function computeFirmwareCoherence(
  input: FirmwareCoherenceInput,
): FirmwareCoherenceResult | null {
  const { beat_ms, ibi_ms } = input;
  const params = input.params ?? NARBIS_COH_PARAMS_DEFAULTS;
  const total_count = beat_ms.length;
  if (total_count !== ibi_ms.length) {
    throw new Error('beat_ms and ibi_ms must be the same length');
  }
  if (total_count < params.min_ibis) return null;

  // Restrict to last COH_WINDOW_S seconds — older beats wrap the grid or
  // bias the interpolation toward stale values. Matches main.c:5343.
  const last_beat_ms = beat_ms[total_count - 1];
  const window_ms = COH_WINDOW_S * 1000;
  const window_start = last_beat_ms > window_ms ? last_beat_ms - window_ms : 0;
  let first_in_window = 0;
  while (first_in_window < total_count && beat_ms[first_in_window] < window_start) {
    first_in_window++;
  }
  const n_used = total_count - first_in_window;
  if (n_used < params.min_ibis) return null;

  // Slice the in-window beats into typed arrays. n_used is bounded by
  // the ring size (~120 in the firmware), so the copy is cheap and lets
  // the resample inner loop hit a contiguous buffer.
  const winBeatArr = new Float64Array(n_used);
  const winIbiArr = new Float64Array(n_used);
  for (let i = 0; i < n_used; i++) {
    winBeatArr[i] = beat_ms[first_in_window + i];
    winIbiArr[i] = ibi_ms[first_in_window + i];
  }

  // 1. Resample onto 4 Hz × 256 grid.
  const re = new Float64Array(COH_GRID_N);
  const im = new Float64Array(COH_GRID_N);
  resampleOntoGrid(winBeatArr, winIbiArr, n_used, re);

  // 2. Detrend (subtract mean).
  let sum = 0;
  for (let i = 0; i < COH_GRID_N; i++) sum += re[i];
  const mean = sum / COH_GRID_N;
  for (let i = 0; i < COH_GRID_N; i++) re[i] -= mean;

  // 3. Apply Hanning window.
  for (let i = 0; i < COH_GRID_N; i++) re[i] *= HANN[i];
  // im[] already zero-initialised.

  // 4. FFT.
  fftInPlace(re, im, COH_GRID_N);

  // 5. One-sided PSD. df = COH_GRID_HZ / COH_GRID_N = 0.015625 Hz/bin.
  const half = COH_GRID_N >> 1;
  const psd = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    psd[i] = re[i] * re[i] + im[i] * im[i];
  }

  // 6. Band integration (Task Force 1996 bands by default; bin ranges
  //    are runtime-tunable via the 0xE0 opcode).
  let vlf = 0;
  for (let i = params.vlf_band_lo; i <= params.vlf_band_hi; i++) vlf += psd[i];
  let lf = 0;
  for (let i = params.lf_band_lo; i <= params.lf_band_hi; i++) lf += psd[i];
  let hf = 0;
  for (let i = params.hf_band_lo; i <= params.hf_band_hi; i++) hf += psd[i];
  const total = vlf + lf + hf;

  // 7. LF peak (Lehrer/Vaschillo) — argmax in [lf_peak_lo, lf_peak_hi],
  //    then sum a ±halfwidth window around it for the numerator.
  let peak_bin = params.lf_peak_lo;
  let peak_argmax_pow = psd[params.lf_peak_lo];
  for (let i = params.lf_peak_lo + 1; i <= params.lf_peak_hi; i++) {
    if (psd[i] > peak_argmax_pow) {
      peak_argmax_pow = psd[i];
      peak_bin = i;
    }
  }
  let peak_pow: number;
  if (params.peak_halfwidth === 0) {
    peak_pow = peak_argmax_pow;
  } else {
    const lo_b = Math.max(0, peak_bin - params.peak_halfwidth);
    const hi_b = Math.min(half - 1, peak_bin + params.peak_halfwidth);
    peak_pow = 0;
    for (let i = lo_b; i <= hi_b; i++) peak_pow += psd[i];
  }

  // 8. Coherence = peak_pow / total × coh_multiplier, clamped to [0, 100].
  let coherence = 0;
  if (total > 1e-6) {
    const ratio = peak_pow / total;
    coherence = ratio * params.coh_multiplier;
    if (coherence > 100) coherence = 100;
    if (coherence < 0) coherence = 0;
  }

  // 9. Derived quantities for parity with the 0xF2 packet.
  const lf_plus_hf = lf + hf;
  const lf_norm = lf_plus_hf > 0 ? (lf / lf_plus_hf) * 100 : 0;
  const hf_norm = lf_plus_hf > 0 ? (hf / lf_plus_hf) * 100 : 0;
  const lf_hf_ratio = hf > 1.0 ? lf / hf : 0;
  const resp_peak_mhz = (peak_bin * COH_GRID_HZ * 1000) / COH_GRID_N;

  return {
    // Match firmware's u8 truncation so dashboard plots overlay the 0xF2
    // stream exactly. Float-precision raw values are easy to recover by
    // skipping this floor() — tests can use the result before truncation.
    coherence: Math.floor(coherence),
    resp_peak_mhz: Math.floor(resp_peak_mhz),
    vlf_power: vlf,
    lf_power: lf,
    hf_power: hf,
    total_power: total,
    lf_norm: Math.floor(lf_norm),
    hf_norm: Math.floor(hf_norm),
    lf_hf_ratio,
    n_ibis_used: n_used > 255 ? 255 : n_used,
  };
}

/* Re-export the params type + defaults so consumers can grab them from one
 * place rather than reaching into the protocol module. */
export { NARBIS_COH_PARAMS_DEFAULTS };
export type { NarbisCoherenceParams };

/* Test-only helpers — exported so the unit test can hit the inner stages
 * directly without re-implementing them. */
export const __internal = {
  HANN,
  fftInPlace,
  resampleOntoGrid,
};
