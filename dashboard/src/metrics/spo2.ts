/*
 * spo2.ts — pulse oximetry (SpO2) from the earclip's red and IR channels, by the ratio of
 * ratios. Computed here in the dashboard, like the HRV metrics: the firmware sends raw counts.
 *
 *   R = (AC_red / DC_red) / (AC_ir / DC_ir)          SpO2 ≈ a − b·R   (textbook a = 110, b = 25)
 *
 * Over a trailing 8 s window, every 1 s:
 *   DC  the window mean of each channel's raw counts. It includes any ambient light: the stream
 *       carries no ambient channel to subtract by default (amb_stream), and on the ear it is small.
 *   AC  each channel band-passed 0.5–5 Hz (the Filtered chart's chain, [PpgFilter]). AC_red /
 *       AC_ir is the least-squares slope of red's pulse wave against IR's: noise in either channel
 *       biases it far less than a ratio of two amplitudes would.
 *
 * A window is only shown when it passes every check; otherwise `reject` says why:
 *   warming     the window is still filling: a start, a gap, a rate change, or a step. A jump of
 *               over 2 % between two samples (an LED / gain step, the clip knocked) rings the
 *               band-pass for seconds with the same shape in both channels, which correlates
 *               perfectly and reads as R ~1 (SpO2 ~85 %). So the tracker starts over at the new level;
 *   no_signal   a channel's DC is under 1 % of full scale (off the ear, red not streamed);
 *   clipped     a sample is within 2 % of the ADC rail;
 *   level_step  a channel's DC moved more than 10 % between the window's halves (an AGC step, the
 *               clip shifting). Normal drift in three guided recordings: p95 1–3 %;
 *   weak        the IR perfusion index is under 0.05 %;
 *   motion      the red and IR pulse waves correlate under 0.98. In those recordings (2026-10-12)
 *               rest windows ran 0.99–1.00. Chewing and talking took one weak-pulse subject's to
 *               0.95, and those windows read R ~0.08 high (SpO2 ~2 points low).
 *
 * UNCALIBRATED. a and b are the textbook line, not fitted to this sensor. On those recordings rest
 * R was 0.60–0.63 for all three people, which the textbook line reads as 94–95 %. Calibrate
 * against a reference pulse oximeter before reading it as more than a trend. Not a medical
 * measurement.
 */
import { PpgFilter } from '../ble/v2/ppgFilter';

export type Spo2Reject = 'warming' | 'no_signal' | 'clipped' | 'level_step' | 'weak' | 'motion';

export interface Spo2Estimate {
  /** Ratio of ratios; NaN when it could not be formed (warming, no_signal). */
  r: number;
  /** Correlation of the red and IR pulse waves over the window: ~1 when clean. */
  corr: number;
  /** Perfusion index, %: the pulse wave's 5–95 % range over the DC. */
  piIr: number;
  piRed: number;
  /** null when the window passed every check and is shown. */
  reject: Spo2Reject | null;
}

/** SpO2 = a − b·R. */
export interface Spo2Cal {
  a: number;
  b: number;
}

export const SPO2_CAL_TEXTBOOK: Spo2Cal = { a: 110, b: 25 };

/** SpO2 (%) for a ratio of ratios, clamped to 0..100. */
export function spo2FromR(r: number, cal: Spo2Cal = SPO2_CAL_TEXTBOOK): number {
  return Math.min(100, Math.max(0, cal.a - cal.b * r));
}

export interface Spo2Options {
  windowSec: number;
  hopSec: number;
  /** Filter settling after a (re)start, before samples enter the window. */
  warmupSec: number;
  /** A hole in the timestamps this long (or time going backwards) restarts the tracker. */
  gapMs: number;
  /** A sample-to-sample change over this fraction of the level restarts it too. */
  maxJump: number;
  /** ADC full scale in counts: the AFE4404's 22-bit ±2^21. */
  fullScale: number;
  minDcFrac: number;
  railFrac: number;
  maxLevelStep: number;
  minPiPct: number;
  minCorr: number;
}

export const SPO2_OPTIONS: Spo2Options = {
  windowSec: 8,
  hopSec: 1,
  warmupSec: 2,
  gapMs: 1000,
  maxJump: 0.02,
  fullScale: 2_097_152,
  minDcFrac: 0.01,
  railFrac: 0.98,
  maxLevelStep: 0.1,
  minPiPct: 0.05,
  minCorr: 0.98,
};

const WARMING: Readonly<Spo2Estimate> = Object.freeze({ r: NaN, corr: 0, piIr: 0, piRed: 0, reject: 'warming' });

/**
 * Streaming estimator: push every raw sample in time order; every hopSec of samples it returns
 * an estimate (a 'warming' one while its window fills), otherwise null.
 */
export class Spo2Tracker {
  private readonly o: Spo2Options;
  private fs = 0;
  private n = 0;
  private hop = 0;
  private warm = 0;
  private irF = new PpgFilter();
  private redF = new PpgFilter();
  private irRaw = new Float64Array(0);
  private redRaw = new Float64Array(0);
  private irAc = new Float64Array(0);
  private redAc = new Float64Array(0);
  private scratch = new Float64Array(0);
  private head = 0;
  private count = 0;
  private sinceReset = 0;
  private sinceHop = 0;
  private lastTs = -Infinity;
  private prevIr = 0;
  private prevRed = 0;
  private baseIr = 0;
  private baseRed = 0;

  constructor(opts: Partial<Spo2Options> = {}) {
    this.o = { ...SPO2_OPTIONS, ...opts };
  }

  reset(): void {
    this.irF.reset();
    this.redF.reset();
    this.head = 0;
    this.count = 0;
    this.sinceReset = 0;
    this.sinceHop = 0;
  }

  push(ts: number, ir: number, red: number, fs: number): Spo2Estimate | null {
    if (fs !== this.fs) {
      this.configure(fs);
    } else if (ts < this.lastTs || ts - this.lastTs > this.o.gapMs) {
      this.reset();
    }
    this.lastTs = ts;
    if (!Number.isFinite(ir) || !Number.isFinite(red)) return null;
    if (this.sinceReset > 0 && (this.jumped(ir, this.prevIr) || this.jumped(red, this.prevRed))) {
      this.reset();
    }
    this.prevIr = ir;
    this.prevRed = red;

    /* The filters see each channel less its level at the (re)start: started on a pedestal of
     * ~10^6 counts, they ring for seconds with the same shape in both channels (R pulled to ~1). */
    if (this.sinceReset === 0) {
      this.baseIr = ir;
      this.baseRed = red;
    }
    const irAc = this.irF.push(ir - this.baseIr);
    const redAc = this.redF.push(red - this.baseRed);
    this.sinceHop++;
    if (++this.sinceReset > this.warm) {
      this.irRaw[this.head] = ir;
      this.redRaw[this.head] = red;
      this.irAc[this.head] = irAc;
      this.redAc[this.head] = redAc;
      this.head = (this.head + 1) % this.n;
      if (this.count < this.n) this.count++;
    }
    if (this.sinceHop < this.hop) return null;
    this.sinceHop = 0;
    return this.count < this.n ? WARMING : this.evaluate();
  }

  private configure(fs: number): void {
    this.fs = fs;
    this.n = Math.max(8, Math.round(this.o.windowSec * fs));
    this.hop = Math.max(1, Math.round(this.o.hopSec * fs));
    this.warm = Math.round(this.o.warmupSec * fs);
    const cfg = { sampleRate: fs, hpFc: 0.5, bpLo: 0.5, bpHi: 5, mainsHz: 0 as const, invert: false };
    this.irF = new PpgFilter(cfg);
    this.redF = new PpgFilter(cfg);
    this.irRaw = new Float64Array(this.n);
    this.redRaw = new Float64Array(this.n);
    this.irAc = new Float64Array(this.n);
    this.redAc = new Float64Array(this.n);
    this.scratch = new Float64Array(this.n);
    this.reset();
  }

  private jumped(x: number, prev: number): boolean {
    const level = Math.max(Math.abs(prev), this.o.minDcFrac * this.o.fullScale);
    return Math.abs(x - prev) > this.o.maxJump * level;
  }

  /** The window is full, so its oldest sample sits at `head`. */
  private evaluate(): Spo2Estimate {
    const { n, o } = this;
    const half = n >> 1;
    let i1 = 0, i2 = 0, r1 = 0, r2 = 0;
    let rail = false;
    const railAt = o.railFrac * o.fullScale;
    for (let k = 0; k < n; k++) {
      const j = (this.head + k) % n;
      const ir = this.irRaw[j];
      const red = this.redRaw[j];
      if (Math.abs(ir) >= railAt || Math.abs(red) >= railAt) rail = true;
      if (k < half) { i1 += ir; r1 += red; } else { i2 += ir; r2 += red; }
    }
    const dcIr = (i1 + i2) / n;
    const dcRed = (r1 + r2) / n;
    const minDc = o.minDcFrac * o.fullScale;
    if (dcIr < minDc || dcRed < minDc) return { ...WARMING, reject: 'no_signal' };

    let sxx = 0, sxy = 0, syy = 0;
    for (let k = 0; k < n; k++) {
      const x = this.irAc[k];
      const y = this.redAc[k];
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
    }
    const corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
    const r = sxx > 0 ? (sxy / sxx) * (dcIr / dcRed) : NaN;
    const piIr = (100 * this.spread(this.irAc)) / dcIr;
    const piRed = (100 * this.spread(this.redAc)) / dcRed;
    const est = { r, corr, piIr, piRed };

    if (rail) return { ...est, reject: 'clipped' };
    const stepIr = Math.abs(i2 / (n - half) - i1 / half) / dcIr;
    const stepRed = Math.abs(r2 / (n - half) - r1 / half) / dcRed;
    if (stepIr > o.maxLevelStep || stepRed > o.maxLevelStep) return { ...est, reject: 'level_step' };
    if (!(piIr >= o.minPiPct)) return { ...est, reject: 'weak' };
    if (!(corr >= o.minCorr) || !Number.isFinite(r)) return { ...est, reject: 'motion' };
    return { ...est, reject: null };
  }

  /** 5–95 % range of a window: a peak-to-peak that one stray sample cannot set. */
  private spread(a: Float64Array): number {
    const s = this.scratch;
    s.set(a);
    s.sort();
    const last = s.length - 1;
    return s[Math.round(0.95 * last)] - s[Math.round(0.05 * last)];
  }
}

/** Sample rate (Hz) from per-sample timestamps (ms): the median spacing, so gaps don't count. */
export function sampleRateFromTimestamps(ts: ReadonlyArray<number>): number {
  const d: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1];
    if (dt > 0 && dt < 1000) d.push(dt);
  }
  if (d.length === 0) return 0;
  d.sort((a, b) => a - b);
  return 1000 / d[d.length >> 1];
}

/** Every estimate over a whole recording, as the live tracker would have made them. */
export function computeSpo2Series(
  raw: ReadonlyArray<{ timestamp: number; sample: { ir: number; red: number } }>,
  opts: Partial<Spo2Options> = {},
): Array<{ timestamp: number; value: Spo2Estimate }> {
  const fs = Math.round(sampleRateFromTimestamps(raw.map((r) => r.timestamp)));
  const out: Array<{ timestamp: number; value: Spo2Estimate }> = [];
  if (fs <= 0) return out;
  const t = new Spo2Tracker(opts);
  for (const r of raw) {
    const e = t.push(r.timestamp, r.sample.ir, r.sample.red, fs);
    if (e) out.push({ timestamp: r.timestamp, value: e });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Calibration against a reference oximeter worn at the same time      */
/* ------------------------------------------------------------------ */

/** Fewer paired seconds than this, and there is no fit. */
export const CAL_MIN_PAIRS = 30;
/** The reference must span this many SpO2 points before the slope b is fitted as well. At rest a
 * healthy reading sits within 1-3 points, which pins a well but says nothing about b. */
export const CAL_LINE_MIN_SPAN = 4;
/** A fitted slope outside this is noise, not a calibration: keep b and fit a alone. */
const CAL_B_RANGE: [number, number] = [5, 60];

export interface Spo2CalFit {
  cal: Spo2Cal;
  /** Paired seconds used. */
  n: number;
  /** 'offset': only a was fitted (the reference barely moved), b kept; 'line': a and b. */
  mode: 'offset' | 'line';
  /** RMS of (reference − fitted earclip SpO2) over the pairs, in SpO2 points. */
  rmse: number;
  refMin: number;
  refMax: number;
}

/**
 * Pair each shown earclip estimate with the reference reading nearest in time (within maxDtMs).
 * Both sides average a few seconds (8 s window here, the oximeter its own), so they line up
 * without a lag correction.
 */
export function pairWithReference(
  estimates: ReadonlyArray<{ timestamp: number; value: Spo2Estimate }>,
  reference: ReadonlyArray<{ timestamp: number; spo2: number | null }>,
  maxDtMs = 1500,
): Array<{ r: number; ref: number }> {
  const ref = reference.filter((x) => x.spo2 !== null).sort((a, b) => a.timestamp - b.timestamp);
  const out: Array<{ r: number; ref: number }> = [];
  if (ref.length === 0) return out;
  let j = 0;
  for (const e of estimates) {
    if (e.value.reject !== null || !Number.isFinite(e.value.r)) continue;
    while (j + 1 < ref.length && Math.abs(ref[j + 1].timestamp - e.timestamp) <= Math.abs(ref[j].timestamp - e.timestamp)) j++;
    if (Math.abs(ref[j].timestamp - e.timestamp) <= maxDtMs) out.push({ r: e.value.r, ref: ref[j].spo2 as number });
  }
  return out;
}

/** Fit SpO2 = a − b·R to paired readings (null with too few); a and b rounded to 0.1. */
export function fitSpo2Cal(pairs: ReadonlyArray<{ r: number; ref: number }>, current: Spo2Cal): Spo2CalFit | null {
  const ok = pairs.filter((p) => Number.isFinite(p.r) && Number.isFinite(p.ref) && p.ref > 0 && p.ref <= 100);
  const n = ok.length;
  if (n < CAL_MIN_PAIRS) return null;
  let refMin = Infinity, refMax = -Infinity, mr = 0, my = 0;
  for (const p of ok) {
    refMin = Math.min(refMin, p.ref);
    refMax = Math.max(refMax, p.ref);
    mr += p.r;
    my += p.ref;
  }
  mr /= n;
  my /= n;
  let b = current.b;
  let mode: Spo2CalFit['mode'] = 'offset';
  if (refMax - refMin >= CAL_LINE_MIN_SPAN) {
    let sxy = 0, sxx = 0;
    for (const p of ok) {
      sxy += (p.r - mr) * (p.ref - my);
      sxx += (p.r - mr) ** 2;
    }
    const fitted = sxx > 0 ? -sxy / sxx : NaN;
    if (fitted >= CAL_B_RANGE[0] && fitted <= CAL_B_RANGE[1]) {
      b = fitted;
      mode = 'line';
    }
  }
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const cal = { a: round1(my + b * mr), b: round1(b) };
  let se = 0;
  for (const p of ok) se += (p.ref - (cal.a - cal.b * p.r)) ** 2;
  return { cal, n, mode, rmse: Math.sqrt(se / n), refMin, refMax };
}
