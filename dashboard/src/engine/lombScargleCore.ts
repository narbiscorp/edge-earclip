/*
 * lombScargleCore.ts — consumer live path: Mode A coherence (CR) + resonance readback.
 *
 * Faithful port of Swift `LombScargleCore`, `computeCoherenceRatio`, `coherencePercent`.
 * Runs the variance-normalized Lomb–Scargle periodogram directly on the irregular RR
 * samples (no resampling), then takes the field-standard coherence ratio
 *   CR = peak window power / (total − peak window power)
 * (McCraty & Childre 2010 / NCT02426476), and a Narbis-designed bounded squash for the lens.
 */
import type { CoherenceTunables } from './tunables';
import type { IBIEntry } from './ibiIngest';
import { smoothnessPriorsDetrend } from './dsp';

export interface CoherenceRatio {
  cr: number;
  peakHz: number;
  peakWindowPower: number;
  totalPower: number;
}

/** Field-standard coherence ratio: max peak in 0.04–0.26 Hz, integrate ±0.015 Hz, divide by (total − window). */
export function computeCoherenceRatio(
  freqs: number[],
  psd: number[],
  t: CoherenceTunables,
): CoherenceRatio {
  let total = 0.0;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    if (f >= t.lsFreqLo && f <= t.lsFreqHi) total += psd[i];
  }

  let peakIdx = -1;
  let peakVal = -1.0;
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    if (f >= t.peakSearchLo && f <= t.peakSearchHi && psd[i] > peakVal) {
      peakVal = psd[i];
      peakIdx = i;
    }
  }
  const peakHz = peakIdx >= 0 ? freqs[peakIdx] : 0;

  let win = 0.0;
  for (let i = 0; i < freqs.length; i++) {
    if (Math.abs(freqs[i] - peakHz) <= t.resonanceHz) win += psd[i];
  }

  const denom = total - win;
  const cr = denom > 1e-12 ? win / denom : 0;
  return { cr, peakHz, peakWindowPower: win, totalPower: total };
}

/** Narbis-designed bounded squash for driving the lens. NOT a HeartMath formula. */
export function coherencePercent(cr: number, k: number): number {
  const p = (100.0 * cr) / (cr + k);
  return Math.min(100.0, Math.max(0.0, p));
}

export interface LSResult {
  cr: number;
  cohPercent: number; // bounded lens drive 0..100
  respPeakHz: number; // LF-only (0.04–0.15) peak — feeds the pacer, NOT the CR search peak
  respPeakMhz: number; // for the pacer (millihertz)
  lfhf: number;
  lfnu: number;
  hfnu: number;
  nBeats: number;
}

export class LombScargleCore {
  private readonly t: CoherenceTunables;
  readonly freqs: number[];

  constructor(t: CoherenceTunables) {
    this.t = t;
    const f: number[] = [];
    let x = t.lsFreqLo;
    while (x <= t.lsFreqHi + 1e-12) {
      f.push(x);
      x += t.lsDf;
    }
    this.freqs = f;
  }

  compute(beats: IBIEntry[]): LSResult | null {
    if (beats.length < 20) return null;
    const tt = beats.map((b) => b.beatTimeS);
    const rr = beats.map((b) => b.rrMs);
    const n = rr.length;
    const mean = rr.reduce((s, v) => s + v, 0) / n;
    // #1 Smoothness-priors (Tarvainen/Kubios) detrend of the RR series, treated as evenly spaced by
    // beat index, removing slow drift/VLF that would otherwise inflate the CR `total` term and depress
    // CR. Applied ONCE to the full window (then segmented for #2). The detrended values are fed at
    // their ORIGINAL irregular beat times — the single-signal path is never resampled (that is why
    // Mode A uses Lomb–Scargle). Falls back to mean removal when disabled.
    const y = this.t.detrendEnabled
      ? smoothnessPriorsDetrend(rr, this.t.detrendLambda)
      : rr.map((v) => v - mean);
    const variance = y.reduce((s, v) => s + v * v, 0) / (n - 1);
    if (variance <= 1e-9) return null;

    const freqs = this.freqs;
    // #2 Variance-reduced spectrum: average the LS periodogram over `spectralSegments` overlapping
    // TIME sub-windows (Welch). Averaging cuts run-to-run variance ~1/S, but each sub-window spans
    // ~1/S the duration → coarser intrinsic resolution; we keep the SAME oversampled `freqs` grid so
    // peak localization is unchanged and only CR stability improves. S<2 (or any sub-window below the
    // 20-beat minimum) → the single full-window periodogram. Don't push S past ~4 or the 0.04 Hz LF
    // band under-resolves within a sub-window.
    let psd: number[] | null = null;
    if (this.t.spectralSegments >= 2) {
      psd = this.welchAveragedLS(tt, y, Math.round(this.t.spectralSegments), this.t.spectralOverlapPct / 100);
    }
    if (!psd) psd = this.periodogramLS(tt, y);

    const cr = computeCoherenceRatio(freqs, psd, this.t);

    // Pacer readback: argmax over the LF band ONLY (0.04–0.15), distinct from the CR
    // peak search (0.04–0.26) — a fast self-selected breather must not feed the pacer.
    let rbHz = 0.0;
    let rbVal = -1.0;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      if (f >= this.t.lfReadbackLo && f <= this.t.lfReadbackHi && psd[i] > rbVal) {
        rbVal = psd[i];
        rbHz = f;
      }
    }

    const band = (lo: number, hi: number): number => {
      let s = 0.0;
      for (let i = 0; i < freqs.length; i++) {
        const f = freqs[i];
        if (f >= lo && f < hi) s += psd[i];
      }
      return s;
    };
    const lf = band(this.t.lfBandLo, this.t.lfBandHi);
    const hf = band(this.t.hfBandLo, this.t.hfBandHi);
    const lfhf = hf > 1e-12 ? lf / hf : 0;
    const lfnu = lf + hf > 1e-12 ? (lf / (lf + hf)) * 100 : 0;
    const hfnu = lf + hf > 1e-12 ? (hf / (lf + hf)) * 100 : 0;

    return {
      cr: cr.cr,
      cohPercent: coherencePercent(cr.cr, this.t.cohSquashK),
      respPeakHz: rbHz,
      respPeakMhz: Math.max(0, Math.min(65535, Math.round(rbHz * 1000))),
      lfhf,
      lfnu,
      hfnu,
      nBeats: n,
    };
  }

  /** Variance-normalized Lomb–Scargle periodogram of `values` at irregular `times`, evaluated over
   * `this.freqs`. `values` are assumed already detrended/centered by the caller. Returns an all-zero
   * spectrum for a ~flat segment. This is the single-segment estimator that #2 averages. */
  private periodogramLS(times: number[], values: number[]): number[] {
    const freqs = this.freqs;
    const psd = new Array<number>(freqs.length).fill(0);
    const n = times.length;
    const variance = n > 1 ? values.reduce((s, v) => s + v * v, 0) / (n - 1) : 0;
    if (variance <= 1e-9) return psd;
    for (let k = 0; k < freqs.length; k++) {
      const w = 2.0 * Math.PI * freqs[k];
      let s2 = 0.0;
      let c2 = 0.0;
      for (let i = 0; i < n; i++) {
        s2 += Math.sin(2 * w * times[i]);
        c2 += Math.cos(2 * w * times[i]);
      }
      const tau = Math.atan2(s2, c2) / (2 * w);
      let yc = 0.0;
      let ys = 0.0;
      let cc = 0.0;
      let ss = 0.0;
      for (let i = 0; i < n; i++) {
        const a = w * (times[i] - tau);
        const c = Math.cos(a);
        const sn = Math.sin(a);
        yc += values[i] * c;
        ys += values[i] * sn;
        cc += c * c;
        ss += sn * sn;
      }
      const pc = cc > 1e-12 ? (yc * yc) / cc : 0;
      const ps = ss > 1e-12 ? (ys * ys) / ss : 0;
      psd[k] = (0.5 * (pc + ps)) / variance; // variance-normalized (cancels in CR)
    }
    return psd;
  }

  /** #2 — average the LS periodogram over `S` overlapping TIME sub-windows of the (already-detrended)
   * window, reducing spectral variance. Returns null if any sub-window holds fewer than the 20-beat
   * minimum, so `compute` cleanly falls back to the single full-window periodogram. */
  private welchAveragedLS(tt: number[], y: number[], S: number, ov: number): number[] | null {
    if (S < 2 || tt.length === 0) return null;
    const t0 = tt[0];
    const t1 = tt[tt.length - 1];
    const span = t1 - t0;
    if (span <= 0) return null;
    const o = Math.max(0, Math.min(0.95, ov));
    // Tile [t0,t1] with S equal sub-windows of length L at fractional overlap o:
    //   span = L·(1 + (S−1)·(1−o)),  step = L·(1−o).
    const L = span / (1 + (S - 1) * (1 - o));
    const step = L * (1 - o);
    const acc = new Array<number>(this.freqs.length).fill(0);
    let count = 0;
    for (let s = 0; s < S; s++) {
      const a = t0 + s * step;
      const b = a + L;
      const segT: number[] = [];
      const segY: number[] = [];
      for (let i = 0; i < tt.length; i++) {
        if (tt[i] >= a - 1e-9 && tt[i] <= b + 1e-9) {
          segT.push(tt[i]);
          segY.push(y[i]);
        }
      }
      if (segT.length < 20) return null; // too few beats in a sub-window → caller uses the single path
      const p = this.periodogramLS(segT, segY);
      for (let k = 0; k < acc.length; k++) acc[k] += p[k];
      count += 1;
    }
    return count > 0 ? acc.map((v) => v / count) : null;
  }
}
