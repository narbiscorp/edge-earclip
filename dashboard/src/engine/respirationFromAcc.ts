/*
 * respirationFromAcc.ts — Mode B/C verification: independent respiration channel from the
 * H10 accelerometer. Immune to the Mayer-wave confound that corrupts RSA-peak readback
 * off-resonance. Motion-artifact sensitive → reliable seated/still; the confidence gates it.
 *
 * Faithful port of Swift `RespirationFromACC`, with one correction: the rate is estimated by
 * COMBINING the three axes' spectra, NOT from the vector magnitude √(x²+y²+z²). The magnitude
 * frequency-DOUBLES a chest oscillation — with gravity as a large DC on one axis, the squaring
 * nonlinearity injects a strong 2× component, so a real ~4–5 br/min breath reads ~9 br/min and
 * fails verification (observed on real H10 data: magnitude → steady 9.34 br/min while every axis
 * read 4–5 br/min). Each axis is linear in the breathing motion, so we keep the raw samples and
 * sum the per-axis periodograms (a linear power combination; the periodogram linear-detrends each
 * segment, removing the gravity DC). Robust to the dominant breathing axis changing with posture.
 *
 * Single-threaded, NSLock dropped.
 */
import type { CoherenceTunables } from './tunables';
import { cubicResample, periodogram } from './dsp';

export interface RespEstimate {
  bpm: number;
  confidence: number;
}

/** Octave guard: when the prominence picker lands on a harmonic, step down to a peak near peakHz/k
 * only if that lower peak carries at least this fraction of the picked peak's power. Conservative —
 * genuine higher-rate breathing has no real sub-harmonic peak, so it is never pulled down. */
const OCTAVE_SUBHARMONIC_MIN_FRAC = 0.5;
/** Step down at most this many octaves (catches a 2× or 4× harmonic). */
const OCTAVE_MAX_STEPS = 2;

export class RespirationFromACC {
  private readonly t: CoherenceTunables;
  private buf: Array<{ s: number; x: number; y: number; z: number }> = [];

  constructor(t: CoherenceTunables) {
    this.t = t;
  }

  push(x: number, y: number, z: number, nowS: number): void {
    this.buf.push({ s: nowS, x, y, z });
    const cutoff = nowS - this.t.respWindowS;
    while (this.buf.length > 0 && this.buf[0].s < cutoff) this.buf.shift();
  }

  reset(): void {
    this.buf = [];
  }

  /** Index of the buffered axis with the largest variance (the dominant breathing motion). */
  private principalAxis(): 'x' | 'y' | 'z' {
    let mx = -1;
    let best: 'x' | 'y' | 'z' = 'z';
    for (const k of ['x', 'y', 'z'] as const) {
      const vals = this.buf.map((e) => e[k]);
      const m = vals.reduce((s, v) => s + v, 0) / vals.length;
      const v = vals.reduce((s, val) => s + (val - m) * (val - m), 0) / Math.max(1, vals.length);
      if (v > mx) { mx = v; best = k; }
    }
    return best;
  }

  /** Snapshot of the buffered respiration signal as parallel arrays (absolute seconds / value), for
   * the cross-spectral breath–heart coherence (Mode A γ²). Returns the DE-MEANED principal (max-
   * variance) axis — NOT the vector magnitude, which frequency-doubles the breath (see file header).
   * Same epoch as the H10 beat times, so the two can be aligned on absolute time. Field name kept as
   * `mag` for the consumer. Empty arrays when nothing is buffered. */
  magnitudeWindow(): { s: number[]; mag: number[] } {
    const ax = this.principalAxis();
    const vals = this.buf.map((e) => e[ax]);
    const mean = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    return { s: this.buf.map((e) => e.s), mag: vals.map((v) => v - mean) };
  }

  estimate(): RespEstimate | null {
    const snap = this.buf;
    if (snap.length < 16) return null;
    const xs = snap.map((e) => e.s);
    // Combine the three axes' spectra instead of the vector magnitude (which frequency-doubles —
    // see file header). Each axis resamples onto the SAME grid (cubicResample coalesces on time
    // only), so the periodograms share one freq axis and sum bin-for-bin. The periodogram linear-
    // detrends each segment, so the gravity DC drops out without an explicit high-pass.
    let pg: { freqs: number[]; psd: number[] } | null = null;
    for (const k of ['x', 'y', 'z'] as const) {
      const rs = cubicResample(xs, snap.map((e) => e[k]), this.t.accSampleHz);
      if (!rs) continue;
      const axisPg = periodogram(rs.v, this.t.accSampleHz);
      if (!axisPg) continue;
      if (pg === null) pg = { freqs: axisPg.freqs, psd: axisPg.psd.slice() };
      else for (let i = 0; i < pg.psd.length && i < axisPg.psd.length; i++) pg.psd[i] += axisPg.psd[i];
    }
    if (!pg) return null;

    // In-band power stats. band-mean is the prominence reference; firstBand/lastBand bound
    // the in-band loops below.
    let bandSum = 0.0;
    let bandCount = 0;
    let firstBand = -1;
    let lastBand = -1;
    for (let i = 0; i < pg.freqs.length; i++) {
      const f = pg.freqs[i];
      if (f >= this.t.respBandLo && f <= this.t.respBandHi) {
        bandSum += pg.psd[i];
        bandCount += 1;
        if (firstBand < 0) firstBand = i;
        lastBand = i;
      }
    }
    if (firstBand < 0 || bandSum <= 1e-12) return null;
    const bandMean = bandSum / bandCount;

    // Pick the breathing peak by PROMINENCE, not raw power: score = (bin height / band mean)
    // × a low-frequency weight. A broad postural-sway hump (height ≈ band mean) and peaks
    // below respMinHz lose to a sharp breathing peak even when the sway carries more total
    // power — the bug that made the verifier latch onto ~0.065 Hz body sway (≈3.9 br/min).
    const lowW = (f: number): number =>
      f >= this.t.respMinHz
        ? 1.0
        : Math.max(0, (f - this.t.respBandLo) / Math.max(1e-9, this.t.respMinHz - this.t.respBandLo));
    let peakIdx = -1;
    let bestScore = -1.0;
    for (let i = firstBand; i <= lastBand; i++) {
      if (i > firstBand && pg.psd[i] < pg.psd[i - 1]) continue; // local maxima only
      if (i < lastBand && pg.psd[i] < pg.psd[i + 1]) continue;
      const score = (pg.psd[i] / bandMean) * lowW(pg.freqs[i]);
      if (score > bestScore) {
        bestScore = score;
        peakIdx = i;
      }
    }
    if (peakIdx < 0) {
      // Monotonic band (no interior local max) → fall back to the strongest in-band bin.
      let mx = -1.0;
      for (let i = firstBand; i <= lastBand; i++) {
        if (pg.psd[i] > mx) { mx = pg.psd[i]; peakIdx = i; }
      }
    }
    if (peakIdx < 0) return null;

    const df = pg.freqs.length > 1 ? pg.freqs[1] - pg.freqs[0] : 0;

    // Octave guard (sub-harmonic preference). A non-sinusoidal breath has strong 2×/3× harmonics,
    // and the prominence picker can latch onto one — e.g. read 10.4 br/min when the breath is really
    // 5.2. That is the exact failure that makes Mode B/C reject on-rate breathing as "couldn't
    // confirm" (the measured rate lands ~2× the paced rate, far outside respVerifyToleranceBPM). If a
    // clear local-max peak sits near peakHz/2 — still inside the breathing band, above the postural-
    // sway floor (respMinHz), and at least OCTAVE_SUBHARMONIC_MIN_FRAC of the picked peak's power —
    // that lower peak is the true fundamental, so step down to it (repeat to catch a 4× harmonic).
    const subTol = Math.max(df, this.t.respNearPeakHz);
    for (let step = 0; step < OCTAVE_MAX_STEPS; step++) {
      const subF = pg.freqs[peakIdx] / 2;
      if (subF < this.t.respMinHz) break; // a half-rate fundamental would fall into the sway floor
      let subIdx = -1;
      let subPsd = -1;
      for (let i = firstBand; i <= lastBand; i++) {
        if (Math.abs(pg.freqs[i] - subF) > subTol) continue;
        if (i > firstBand && pg.psd[i] < pg.psd[i - 1]) continue; // local maxima only
        if (i < lastBand && pg.psd[i] < pg.psd[i + 1]) continue;
        if (pg.psd[i] > subPsd) { subPsd = pg.psd[i]; subIdx = i; }
      }
      if (subIdx < 0 || subPsd < OCTAVE_SUBHARMONIC_MIN_FRAC * pg.psd[peakIdx]) break;
      peakIdx = subIdx; // octave error — the harmonic's fundamental is real; use it
    }

    // Sub-bin parabolic interpolation (N7): a 3-point quadratic fit on log-magnitude
    // recovers the true peak to ~0.01 BPM on a steady tone (raw bin is ~0.73 BPM coarse).
    let peakHz = pg.freqs[peakIdx];
    if (peakIdx >= 1 && peakIdx + 1 < pg.psd.length && df > 0) {
      const p0 = pg.psd[peakIdx - 1];
      const p1 = pg.psd[peakIdx];
      const p2 = pg.psd[peakIdx + 1];
      if (p0 > 0 && p1 > 0 && p2 > 0) {
        const a = Math.log(p0);
        const b = Math.log(p1);
        const c = Math.log(p2);
        const denom = a - 2 * b + c;
        if (denom < -1e-12) {
          // concave ⇒ genuine local max
          const delta = (0.5 * (a - c)) / denom; // sub-bin offset ∈ [-0.5, 0.5]
          if (Math.abs(delta) <= 0.5) peakHz = pg.freqs[peakIdx] + delta * df;
        }
      }
    }

    // Confidence = power within ±respNearPeakHz of the peak / power in the FUNDAMENTAL band
    // only (exclude ≥ respHarmonicExcludeMult × peak so a non-sinusoidal breath's 2×/3×
    // harmonics don't deflate the score). Sub-peak sway still counts — it's real contamination.
    const harmonicCut = this.t.respHarmonicExcludeMult * peakHz;
    let nearPeak = 0.0;
    let fundSum = 0.0;
    for (let i = firstBand; i <= lastBand; i++) {
      const f = pg.freqs[i];
      if (f < harmonicCut) fundSum += pg.psd[i];
      if (Math.abs(f - peakHz) <= this.t.respNearPeakHz) nearPeak += pg.psd[i];
    }
    const confidence = fundSum > 1e-12 ? Math.min(1.0, nearPeak / fundSum) : 0.0;
    return { bpm: peakHz * 60.0, confidence };
  }
}
