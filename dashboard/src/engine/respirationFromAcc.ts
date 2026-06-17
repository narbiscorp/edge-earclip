/*
 * respirationFromAcc.ts — Mode B verification: independent respiration channel from the
 * H10 accelerometer. Immune to the Mayer-wave confound that corrupts RSA-peak readback
 * off-resonance. Motion-artifact sensitive → reliable seated/still; the confidence gates it.
 *
 * Faithful port of Swift `RespirationFromACC`. Single-threaded, NSLock dropped.
 */
import type { CoherenceTunables } from './tunables';
import { cubicResample, periodogram } from './dsp';

export interface RespEstimate {
  bpm: number;
  confidence: number;
}

export class RespirationFromACC {
  private readonly t: CoherenceTunables;
  private buf: Array<{ s: number; mag: number }> = [];

  constructor(t: CoherenceTunables) {
    this.t = t;
  }

  push(x: number, y: number, z: number, nowS: number): void {
    this.buf.push({ s: nowS, mag: Math.sqrt(x * x + y * y + z * z) });
    const cutoff = nowS - this.t.respWindowS;
    while (this.buf.length > 0 && this.buf[0].s < cutoff) this.buf.shift();
  }

  reset(): void {
    this.buf = [];
  }

  /** Snapshot of the buffered ACC vector-magnitude window as parallel arrays (absolute seconds /
   * magnitude), for the cross-spectral breath–heart coherence (Mode A γ²). Same epoch as the H10
   * beat times, so the two can be aligned on absolute time. Empty arrays when nothing is buffered. */
  magnitudeWindow(): { s: number[]; mag: number[] } {
    return { s: this.buf.map((e) => e.s), mag: this.buf.map((e) => e.mag) };
  }

  estimate(): RespEstimate | null {
    const snap = this.buf;
    if (snap.length < 16) return null;
    const xs = snap.map((e) => e.s);
    const ys = snap.map((e) => e.mag);
    const rs = cubicResample(xs, ys, this.t.accSampleHz);
    if (!rs) return null;
    const pg = periodogram(rs.v, this.t.accSampleHz);
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

    // Sub-bin parabolic interpolation (N7): a 3-point quadratic fit on log-magnitude
    // recovers the true peak to ~0.01 BPM on a steady tone (raw bin is ~0.73 BPM coarse).
    const df = pg.freqs.length > 1 ? pg.freqs[1] - pg.freqs[0] : 0;
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
