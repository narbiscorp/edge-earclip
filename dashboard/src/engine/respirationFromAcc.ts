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

  estimate(): RespEstimate | null {
    const snap = this.buf;
    if (snap.length < 16) return null;
    const xs = snap.map((e) => e.s);
    const ys = snap.map((e) => e.mag);
    const rs = cubicResample(xs, ys, this.t.accSampleHz);
    if (!rs) return null;
    const pg = periodogram(rs.v, this.t.accSampleHz);
    if (!pg) return null;

    let peakIdx = -1;
    let peakVal = -1.0;
    let bandSum = 0.0;
    for (let i = 0; i < pg.freqs.length; i++) {
      const f = pg.freqs[i];
      if (f >= this.t.respBandLo && f <= this.t.respBandHi) {
        bandSum += pg.psd[i];
        if (pg.psd[i] > peakVal) {
          peakVal = pg.psd[i];
          peakIdx = i;
        }
      }
    }
    if (peakIdx < 0 || bandSum <= 1e-12) return null;

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

    // confidence = power concentrated near the peak (±0.03 Hz) / total in-band power
    let nearPeak = 0.0;
    for (let i = 0; i < pg.freqs.length; i++) {
      if (Math.abs(pg.freqs[i] - peakHz) <= 0.03) nearPeak += pg.psd[i];
    }
    return { bpm: peakHz * 60.0, confidence: Math.min(1.0, nearPeak / bandSum) };
  }
}
