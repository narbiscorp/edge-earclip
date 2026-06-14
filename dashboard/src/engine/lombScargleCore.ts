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
    const y = rr.map((v) => v - mean);
    const variance = y.reduce((s, v) => s + v * v, 0) / (n - 1);
    if (variance <= 1e-9) return null;

    const freqs = this.freqs;
    const psd = new Array<number>(freqs.length).fill(0);
    for (let k = 0; k < freqs.length; k++) {
      const w = 2.0 * Math.PI * freqs[k];
      let s2 = 0.0;
      let c2 = 0.0;
      for (let i = 0; i < n; i++) {
        s2 += Math.sin(2 * w * tt[i]);
        c2 += Math.cos(2 * w * tt[i]);
      }
      const tau = Math.atan2(s2, c2) / (2 * w);
      let yc = 0.0;
      let ys = 0.0;
      let cc = 0.0;
      let ss = 0.0;
      for (let i = 0; i < n; i++) {
        const a = w * (tt[i] - tau);
        const c = Math.cos(a);
        const sn = Math.sin(a);
        yc += y[i] * c;
        ys += y[i] * sn;
        cc += c * c;
        ss += sn * sn;
      }
      const pc = cc > 1e-12 ? (yc * yc) / cc : 0;
      const ps = ss > 1e-12 ? (ys * ys) / ss : 0;
      psd[k] = (0.5 * (pc + ps)) / variance; // variance-normalized (cancels in CR)
    }

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
}
