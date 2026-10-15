/*
 * ecgRpeak.ts — R-peaks from the Polar H10's raw ECG (130 Hz, µV), for pulse arrival time
 * (metrics/ptt.ts). The H10's own RR intervals arrive in ~1 s heart-rate packets whose timing
 * jitters by up to a second, so beat TIMES have to come from the raw lead.
 *
 * Detection (Pan–Tompkins style, streaming):
 *   1. each sample less the level at the (re)start, band-passed 5–25 Hz (QRS energy; drops the
 *      baseline wander, P and T waves);
 *   2. squared and integrated over 100 ms;
 *   3. a beat is that energy rising through 30 % of its recent peak (which decays to half in
 *      2 s), at least REFRACTORY_MS after the last R;
 *   4. LOOKAHEAD_MS later the R is placed on the raw lead: the largest deflection of the beat's
 *      polarity (learned over the first beats: a chest lead can show R up or down) within
 *      SEARCH_MS of the trigger, less the window's mean, refined by a parabola through the
 *      three samples around it (7.7 ms samples → ~1 ms).
 * The R time is read off the RAW lead, so the band-pass's delay does not bias it.
 */
import { PpgFilter } from '../ble/v2/ppgFilter';

export interface RPeak {
  /** Time of the R peak, on the clock the samples came in on (ms). */
  t: number;
  /** R amplitude above the window mean, µV (signed: the lead's polarity). */
  amp: number;
  /** Interval from the previous R (ms); null for the first after a (re)start. */
  rr: number | null;
}

const REFRACTORY_MS = 250;
const LOOKAHEAD_MS = 150;
const SEARCH_MS = 120;
const INTEGRATE_MS = 100;
const THRESHOLD_FRAC = 0.3;
const PEAK_HALF_LIFE_MS = 2000;
const WARMUP_MS = 1000;
const POLARITY_VOTES = 8;
const RING_MS = 1500;
const MAX_RR_MS = 2500;

export class RPeakDetector {
  private fs = 0;
  private filt = new PpgFilter();
  private base = 0;
  private started = false;
  private sinceStart = 0;
  private integ: number[] = [];
  private integSum = 0;
  private envPeak = 0;
  private decay = 1;
  private above = false;
  private lastRt = -Infinity;
  private pendingAt: number | null = null; // trigger time awaiting its lookahead
  private ringT: number[] = [];
  private ringV: number[] = [];
  private votes = 0; // >0 = R points up
  private nVotes = 0;
  private lastT = -Infinity;

  reset(): void {
    this.filt.reset();
    this.started = false;
    this.sinceStart = 0;
    this.integ = [];
    this.integSum = 0;
    this.envPeak = 0;
    this.above = false;
    this.lastRt = -Infinity;
    this.pendingAt = null;
    this.ringT = [];
    this.ringV = [];
    this.lastT = -Infinity;
  }

  /** Feed one sample (time ms, µV) in time order; returns the R-peaks that became final. */
  push(t: number, v: number, fs: number): RPeak[] {
    if (fs !== this.fs) {
      this.fs = fs;
      this.filt = new PpgFilter({ sampleRate: fs, hpFc: 5, bpLo: 5, bpHi: 25, mainsHz: 0, invert: false });
      this.decay = Math.pow(0.5, 1000 / fs / PEAK_HALF_LIFE_MS);
      this.reset();
    } else if (t < this.lastT || t - this.lastT > MAX_RR_MS) {
      this.reset();
    }
    this.lastT = t;
    if (!this.started) {
      this.started = true;
      this.base = v;
    }
    this.sinceStart++;
    this.ringT.push(t);
    this.ringV.push(v);
    const keep = Math.ceil((RING_MS * fs) / 1000);
    if (this.ringT.length > keep) {
      this.ringT.splice(0, this.ringT.length - keep);
      this.ringV.splice(0, this.ringV.length - keep);
    }

    const b = this.filt.push(v - this.base);
    const e = b * b;
    const win = Math.max(1, Math.round((INTEGRATE_MS * fs) / 1000));
    this.integ.push(e);
    this.integSum += e;
    if (this.integ.length > win) this.integSum -= this.integ.shift() as number;
    const m = this.integSum / this.integ.length;
    this.envPeak = Math.max(m, this.envPeak * this.decay);

    const out: RPeak[] = [];
    if (this.pendingAt !== null && t - this.pendingAt >= LOOKAHEAD_MS) {
      const p = this.locate(this.pendingAt);
      this.pendingAt = null;
      if (p) out.push(p);
    }
    if ((this.sinceStart * 1000) / fs < WARMUP_MS) return out;
    const thr = THRESHOLD_FRAC * this.envPeak;
    if (!this.above && m > thr && thr > 0) {
      this.above = true;
      if (t - this.lastRt >= REFRACTORY_MS && this.pendingAt === null) this.pendingAt = t;
    } else if (this.above && m < thr * 0.8) {
      this.above = false;
    }
    return out;
  }

  /** Place the R on the raw lead around a trigger. */
  private locate(at: number): RPeak | null {
    const T = this.ringT, V = this.ringV;
    let i0 = 0;
    while (i0 < T.length && T[i0] < at - SEARCH_MS) i0++;
    let i1 = i0;
    while (i1 < T.length && T[i1] <= at + SEARCH_MS) i1++;
    if (i1 - i0 < 5) return null;
    let mean = 0;
    for (let i = i0; i < i1; i++) mean += V[i];
    mean /= i1 - i0;
    let iMax = i0, iMin = i0;
    for (let i = i0; i < i1; i++) {
      if (V[i] > V[iMax]) iMax = i;
      if (V[i] < V[iMin]) iMin = i;
    }
    const up = V[iMax] - mean, down = mean - V[iMin];
    if (this.nVotes < POLARITY_VOTES) {
      this.votes += up >= down ? 1 : -1;
      this.nVotes++;
    }
    const pointsUp = this.nVotes < POLARITY_VOTES ? up >= down : this.votes > 0;
    const k = pointsUp ? iMax : iMin;
    let tk = T[k];
    if (k > i0 && k < i1 - 1) {
      const y0 = V[k - 1], y1 = V[k], y2 = V[k + 1];
      const den = y0 - 2 * y1 + y2;
      if (den !== 0) {
        const delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
        tk += delta * ((T[k + 1] - T[k - 1]) / 2);
      }
    }
    if (tk - this.lastRt < REFRACTORY_MS) return null;
    const rr = Number.isFinite(this.lastRt) && tk - this.lastRt <= MAX_RR_MS ? tk - this.lastRt : null;
    this.lastRt = tk;
    return { t: tk, amp: V[k] - mean, rr };
  }
}
