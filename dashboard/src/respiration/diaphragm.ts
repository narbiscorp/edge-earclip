/*
 * diaphragm.ts — dual-strap diaphragmatic activation analysis.
 *
 * Two Polar H10s, one across the sternum and one across the epigastrium. Where
 * the chest and the belly move relative to each other is what separates
 * diaphragmatic breathing from shallow thoracic breathing, and — when the belly
 * moves the WRONG way on inhalation — paradoxical breathing.
 *
 * Everything here is pure. The pipeline is:
 *   clip to the overlapping span → resample both onto ONE common grid →
 *   remove the slow baseline → peak-to-peak per stream → ratio, phase, differential.
 *
 * The common grid is the part that is easy to get wrong. The two straps have
 * independent clocks and their frames arrive at different instants, so their raw
 * samples do not line up. Cross-correlating them as-is would measure the offset
 * between two BLE streams rather than between two parts of a torso.
 */
import { movingAverage, pchipResample, removeBaseline } from './dsp';

export type Classification =
  | 'DIAPHRAGMATIC'
  | 'BALANCED'
  | 'THORACIC'
  | 'PARADOXICAL'
  | 'UNKNOWN';

export interface DiaphragmOptions {
  /** Baseline-removal window, seconds — the high-pass half of the respiratory
   * band-pass. Removes gravity and posture drift. */
  detrendSec: number;
  /** Low-pass span, seconds — the other half. A centred moving average of this
   * span puts its first null at 1/lowpassSec Hz, so 2 s lands the null on
   * 0.5 Hz and removes the cardiac ballistogram (~1 Hz) that otherwise inflates
   * every peak-to-peak measurement. Breathing at 0.1 Hz is attenuated about
   * 6%, and identically on both straps, so the ratio is unaffected. */
  lowpassSec: number;
  /** Peak-to-peak window, seconds. The spec's 1.5x a breath cycle. */
  ptpWindowSec: number;
  /** Calibration scale factors from the deep-breath routine. */
  calibChest: number;
  calibAbdo: number;
  /** Common analysis grid, Hz. 20 Hz is far above the 0.5 Hz respiratory band
   * and keeps the cross-correlation lag resolution at 50 ms. */
  gridHz: number;
}

export const DEFAULT_DIAPHRAGM_OPTIONS: DiaphragmOptions = {
  detrendSec: 12,
  lowpassSec: 2,
  ptpWindowSec: 10,
  calibChest: 1,
  calibAbdo: 1,
  gridHz: 20,
};

/** Classification thresholds, from the engineering spec. */
export const RATIO_DIAPHRAGMATIC = 1.5;
export const RATIO_THORACIC = 0.7;
export const PHASE_SYNCHRONOUS_DEG = 45;
export const PHASE_PARADOXICAL_DEG = 135;

/** Breath periods the period estimator will consider (30 down to 4 breaths/min). */
const MIN_PERIOD_MS = 2000;
const MAX_PERIOD_MS = 15000;

/** Below this the streams are too short for any of it to mean anything. */
const MIN_ANALYSIS_SEC = 8;

export interface DiaphragmResult {
  /** Normalised abdominal / thoracic amplitude ratio. */
  ratio: number | null;
  /** Absolute phase difference in degrees, 0-180. */
  phaseAngleDeg: number | null;
  /** Signed lag of abdomen relative to chest, ms. Positive = belly lags. */
  lagMs: number | null;
  breathPeriodMs: number | null;
  chestPtP: number | null;
  abdoPtP: number | null;
  /** Peak normalised cross-correlation, -1..1. Low means the phase angle is
   * not describing a shared rhythm and should not be trusted. */
  correlation: number | null;
  classification: Classification;
  /** Time-aligned, baseline-removed traces on the common grid, for plotting. */
  t: number[];
  chest: number[];
  abdo: number[];
  /** Common-mode-rejected differential: abdomen minus chest. Posture tilts and
   * chair movement appear on BOTH straps, so subtracting removes them and
   * leaves the part of the motion that is genuinely differential. */
  differential: number[];
}

function emptyResult(): DiaphragmResult {
  return {
    ratio: null,
    phaseAngleDeg: null,
    lagMs: null,
    breathPeriodMs: null,
    chestPtP: null,
    abdoPtP: null,
    correlation: null,
    classification: 'UNKNOWN',
    t: [],
    chest: [],
    abdo: [],
    differential: [],
  };
}

export function peakToPeak(y: readonly number[]): number | null {
  if (y.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of y) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

/**
 * Dominant period by normalised autocorrelation, searched over the plausible
 * breathing range. Returns null when no lag stands out, which is the honest
 * answer for a held breath or a subject who is not breathing rhythmically —
 * better than defaulting to a number that then feeds a phase angle.
 */
export function estimatePeriodMs(
  y: readonly number[],
  gridHz: number,
  minMs = MIN_PERIOD_MS,
  maxMs = MAX_PERIOD_MS,
): number | null {
  const n = y.length;
  const minLag = Math.max(1, Math.round((minMs / 1000) * gridHz));
  // Never search past half the window: a lag longer than that is estimated from
  // less than one full repetition, which is not evidence of a period.
  const maxLag = Math.min(Math.floor(n / 2), Math.round((maxMs / 1000) * gridHz));
  if (maxLag <= minLag + 1) return null;

  let mean = 0;
  for (const v of y) mean += v;
  mean /= n;
  let variance = 0;
  for (const v of y) variance += (v - mean) * (v - mean);
  variance /= n;
  if (variance <= 1e-12) return null;

  // UNBIASED normalisation — divide by the number of overlapping terms, not by
  // the whole window. The biased form (dividing by n) decays as lag grows, and
  // in a short window that decay outruns the real periodic peak: the maximum
  // then lands on the shortest lag searched, and the estimator confidently
  // returns its own lower bound. That produced a 2 s "breath period" from a
  // 10 s breath and, through the phase angle, a false paradoxical warning.
  const r = new Array<number>(maxLag + 1).fill(0);
  for (let lag = minLag - 1 >= 1 ? minLag - 1 : 1; lag <= maxLag; lag++) {
    let acc = 0;
    const count = n - lag;
    if (count < 2) continue;
    for (let i = 0; i < count; i++) acc += (y[i] - mean) * (y[i + lag] - mean);
    r[lag] = acc / count / variance;
  }

  // Require a genuine local maximum. A monotonically falling autocorrelation
  // has no period in range, and saying so beats returning an endpoint.
  const peaks: Array<{ lag: number; r: number }> = [];
  for (let lag = Math.max(minLag, 2); lag <= maxLag - 1; lag++) {
    if (r[lag] <= r[lag - 1] || r[lag] < r[lag + 1]) continue;
    peaks.push({ lag, r: r[lag] });
  }
  if (peaks.length === 0) return null;

  let bestR = -Infinity;
  for (const p of peaks) if (p.r > bestR) bestR = p.r;
  if (bestR < 0.3) return null;

  // Take the EARLIEST peak that is nearly as strong as the best one, not the
  // strongest. A periodic signal correlates just as well at 2x and 3x its
  // period, and with unbiased normalisation those harmonics can measure
  // marginally higher — picking the maximum then reports half the breathing
  // rate. The fundamental is the shortest lag at which the signal repeats.
  const HARMONIC_TOLERANCE = 0.85;
  for (const p of peaks) {
    if (p.r >= bestR * HARMONIC_TOLERANCE) return (p.lag / gridHz) * 1000;
  }
  return null;
}

export interface LagResult {
  lagSamples: number;
  correlation: number;
}

/**
 * Normalised cross-correlation lag of `b` relative to `a`, searched over
 * +/-maxLagSamples. Positive lag means `b` follows `a`.
 *
 * Both series are mean-removed and the correlation is divided by the product of
 * their norms, so the result is a shape comparison rather than an amplitude one
 * — which matters because the two straps sit on different amounts of tissue and
 * never have the same gain.
 */
export function crossCorrelationLag(
  a: readonly number[],
  b: readonly number[],
  maxLagSamples: number,
): LagResult | null {
  const n = Math.min(a.length, b.length);
  if (n < 4 || maxLagSamples < 1) return null;
  const meanOf = (v: readonly number[]): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += v[i];
    return s / n;
  };
  const ma = meanOf(a);
  const mb = meanOf(b);
  let bestLag = 0;
  let bestR = -Infinity;
  const maxLag = Math.min(maxLagSamples, n - 2);
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let num = 0;
    let da = 0;
    let db = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const j = i + lag;
      if (j < 0 || j >= n) continue;
      const va = a[i] - ma;
      const vb = b[j] - mb;
      num += va * vb;
      da += va * va;
      db += vb * vb;
      count++;
    }
    if (count < 4 || da <= 1e-12 || db <= 1e-12) continue;
    const r = num / Math.sqrt(da * db);
    if (r > bestR) {
      bestR = r;
      bestLag = lag;
    }
  }
  if (bestR === -Infinity) return null;
  return { lagSamples: bestLag, correlation: bestR };
}

/**
 * Spec classification. Paradoxical outranks the ratio: a belly moving the wrong
 * way is the finding, whatever the amplitudes say.
 *
 * But it only outranks it when the two straps are actually tracking one rhythm.
 * A phase angle computed from a weak correlation is not a measurement of
 * anything, and PARADOXICAL is a clinical-sounding claim — firing it off
 * r = 0.5 at a nonsense lag is how the app told a normally-breathing subject
 * they had abdominal collapse. Below `MIN_CLASSIFY_CORRELATION` the phase is
 * ignored and the ratio alone decides.
 */
export function classify(
  ratio: number | null,
  phaseDeg: number | null,
  correlation: number | null = 1,
): Classification {
  const phaseTrusted =
    correlation == null ? false : Math.abs(correlation) >= MIN_CLASSIFY_CORRELATION;
  if (phaseTrusted && phaseDeg != null && phaseDeg > PHASE_PARADOXICAL_DEG) return 'PARADOXICAL';
  if (ratio == null || !Number.isFinite(ratio)) return 'UNKNOWN';
  if (ratio >= RATIO_DIAPHRAGMATIC) return 'DIAPHRAGMATIC';
  if (ratio < RATIO_THORACIC) return 'THORACIC';
  return 'BALANCED';
}

export type AccAxis = 'x' | 'y' | 'z' | 'mag';

/** How usable one accelerometer axis is for comparing the two straps. */
export interface AxisQuality {
  axis: AccAxis;
  /** Signed peak cross-correlation. Negative means the straps move oppositely
   * on this axis — either real paradox, or one strap mounted the other way up. */
  correlation: number;
  /** Band-passed amplitude (SD, mG) each strap sees on this axis. */
  chestAmp: number;
  abdoAmp: number;
  /**
   * How differently the two straps are ROTATED, measured as the difference in
   * this axis's gravity component (mG).
   *
   * This is the load-bearing number. An accelerometer axis is a direction in
   * the STRAP's frame, not the body's. If two straps sit at different rotations
   * about the torso, the same axis points different ways on each, and the chest
   * wall's movement projects onto it with different magnitudes — and possibly
   * different SIGNS. Comparing them then produces a phase difference that is
   * entirely an artifact of how the straps were put on.
   */
  gravityDeltaMg: number;
  /** Enough movement on both straps for the comparison to mean anything. */
  usable: boolean;
}

/** Minimum band-passed amplitude (mG) for an axis to be considered at all. */
const AXIS_MIN_AMPLITUDE_MG = 1.5;
/** Gravity-component difference above which the two straps are rotated too
 * differently for this axis to be comparable between them. */
export const AXIS_ORIENTATION_WARN_MG = 250;
/** Correlation magnitude below which the straps are not tracking one rhythm and
 * no phase-based claim should be made. */
export const MIN_CLASSIFY_CORRELATION = 0.5;

/** Mean of a series — the gravity component, once the breathing is averaged out. */
function meanOf(y: readonly number[]): number {
  if (y.length === 0) return 0;
  let s = 0;
  for (const v of y) s += v;
  return s / y.length;
}

function sdOf(y: readonly number[]): number {
  const n = y.length;
  if (n < 2) return 0;
  const m = meanOf(y);
  let acc = 0;
  for (const v of y) acc += (v - m) * (v - m);
  return Math.sqrt(acc / n);
}

/** Assess one axis without running the full analysis. */
export function assessAxis(
  axis: AccAxis,
  chest: Series,
  abdo: Series,
  opts: DiaphragmOptions = DEFAULT_DIAPHRAGM_OPTIONS,
): AxisQuality {
  const empty: AxisQuality = {
    axis,
    correlation: 0,
    chestAmp: 0,
    abdoAmp: 0,
    gravityDeltaMg: Infinity,
    usable: false,
  };
  const r = analyseDualStreams(chest, abdo, opts);
  if (r.t.length === 0) return empty;
  const chestAmp = sdOf(r.chest);
  const abdoAmp = sdOf(r.abdo);
  return {
    axis,
    correlation: r.correlation ?? 0,
    chestAmp,
    abdoAmp,
    // Gravity is the mean of the RAW series, before the baseline was removed.
    gravityDeltaMg: Math.abs(meanOf(chest.y) - meanOf(abdo.y)),
    usable: chestAmp >= AXIS_MIN_AMPLITUDE_MG && abdoAmp >= AXIS_MIN_AMPLITUDE_MG,
  };
}

/**
 * Pick the axis on which the two straps are actually comparable.
 *
 * Defaulting to Z (as the spec does) assumes both straps are mounted the same
 * way up and the same way round. On real recordings they are not: a session
 * measured here had gravity on Z differing by 390 mG between the straps, so
 * their Z axes pointed in materially different directions. Comparing that axis
 * produced a weak correlation at a nonsense lag, which became a 180° phase and
 * a PARADOXICAL warning — from a subject whose Y axes correlated at 0.95 with
 * zero lag, i.e. who was breathing perfectly normally.
 *
 * Selection is by the strongest ABSOLUTE correlation among axes with enough
 * movement on both straps. Absolute, not signed, so a genuinely antiphase
 * (paradoxical) pattern is still selected rather than discarded in favour of a
 * weakly-correlated axis — the sign is reported, not optimised away.
 */
export function chooseAxis(
  candidates: ReadonlyArray<{ axis: AccAxis; chest: Series; abdo: Series }>,
  opts: DiaphragmOptions = DEFAULT_DIAPHRAGM_OPTIONS,
): AxisQuality | null {
  const scored = candidates.map((c) => assessAxis(c.axis, c.chest, c.abdo, opts));
  const usable = scored.filter((q) => q.usable);
  const pool = usable.length > 0 ? usable : scored;
  let best: AxisQuality | null = null;
  for (const q of pool) {
    if (!best || Math.abs(q.correlation) > Math.abs(best.correlation)) best = q;
  }
  return best;
}

export interface Series {
  x: number[];
  y: number[];
}

/** Clip a series to [t0, t1]. */
function clip(s: Series, t0: number, t1: number): Series {
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < s.x.length; i++) {
    if (s.x[i] < t0 || s.x[i] > t1) continue;
    x.push(s.x[i]);
    y.push(s.y[i]);
  }
  return { x, y };
}

/**
 * Full dual-stream analysis. `chest` and `abdo` are raw accelerometer series
 * (any axis) with absolute-ms timestamps; they need not be aligned or the same
 * length. Returns nulls rather than guesses when the streams do not overlap
 * enough to support a conclusion.
 */
export function analyseDualStreams(
  chest: Series,
  abdo: Series,
  opts: DiaphragmOptions = DEFAULT_DIAPHRAGM_OPTIONS,
): DiaphragmResult {
  const out = emptyResult();
  if (chest.x.length < 4 || abdo.x.length < 4) return out;

  // 1. Overlapping span only. Anything outside it exists on one strap alone and
  //    would contribute a phase difference that is pure bookkeeping.
  const t0 = Math.max(chest.x[0], abdo.x[0]);
  const t1 = Math.min(chest.x[chest.x.length - 1], abdo.x[abdo.x.length - 1]);
  if (!(t1 - t0 >= MIN_ANALYSIS_SEC * 1000)) return out;

  const cClip = clip(chest, t0, t1);
  const aClip = clip(abdo, t0, t1);
  if (cClip.x.length < 4 || aClip.x.length < 4) return out;

  // 2. One common grid. Both clips start within the same span, so pchip's
  //    lattice (multiples of the step) is identical for both; truncate to the
  //    shorter one so sample i of each is the same instant.
  const cRes = pchipResample(cClip.x, cClip.y, opts.gridHz);
  const aRes = pchipResample(aClip.x, aClip.y, opts.gridHz);
  const n = Math.min(cRes.x.length, aRes.x.length);
  if (n < 4) return out;

  const t = cRes.x.slice(0, n);
  // 3. Band-pass each stream into the respiratory band independently.
  //    High-pass (baseline removal) alone is not enough: the cardiac
  //    ballistogram rides at ~1 Hz and, being a similar size to a shallow
  //    breath, it inflates peak-to-peak and drags the ratio toward 1 — the
  //    smaller signal is inflated proportionally more, so a genuinely
  //    belly-dominant pattern reads as merely balanced.
  const band = (raw: number[]): number[] => {
    const hp = removeBaseline(t, raw, opts.detrendSec);
    if (opts.lowpassSec <= 0) return hp;
    const span = Math.round(opts.lowpassSec * opts.gridHz);
    return span > 1 ? movingAverage(hp, span) : hp;
  };
  const chestClean = band(cRes.y.slice(0, n));
  const abdoClean = band(aRes.y.slice(0, n));

  // 4. Common-mode rejection: whatever moved both straps together was not breathing.
  const differential = new Array<number>(n);
  for (let i = 0; i < n; i++) differential[i] = abdoClean[i] - chestClean[i];

  out.t = t;
  out.chest = chestClean;
  out.abdo = abdoClean;
  out.differential = differential;

  // 5. Peak-to-peak over the trailing window.
  const ptpSamples = Math.max(4, Math.round(opts.ptpWindowSec * opts.gridHz));
  const from = Math.max(0, n - ptpSamples);
  const chestPtP = peakToPeak(chestClean.slice(from));
  const abdoPtP = peakToPeak(abdoClean.slice(from));
  out.chestPtP = chestPtP;
  out.abdoPtP = abdoPtP;

  // 6. Calibrated ratio.
  const cCal = opts.calibChest > 0 ? opts.calibChest : 1;
  const aCal = opts.calibAbdo > 0 ? opts.calibAbdo : 1;
  if (chestPtP != null && abdoPtP != null) {
    const normChest = chestPtP / cCal;
    const normAbdo = abdoPtP / aCal;
    out.ratio = normChest > 0 ? normAbdo / normChest : null;
  }

  // 7. Breath period, then phase over +/- half a period. Beyond half a period a
  //    lag is indistinguishable from the opposite lag one cycle away, so the
  //    search is bounded there and the angle lands in 0-180 by construction.
  const period = estimatePeriodMs(chestClean, opts.gridHz);
  out.breathPeriodMs = period;
  if (period != null) {
    const maxLagSamples = Math.max(1, Math.round(((period / 2) / 1000) * opts.gridHz));
    const lag = crossCorrelationLag(chestClean, abdoClean, maxLagSamples);
    if (lag) {
      out.lagMs = (lag.lagSamples / opts.gridHz) * 1000;
      out.correlation = lag.correlation;
      out.phaseAngleDeg = Math.min(180, (Math.abs(out.lagMs) / period) * 360);
    }
  }

  out.classification = classify(out.ratio, out.phaseAngleDeg, out.correlation);
  return out;
}

/** Where the balance bar's marker sits, 0 (all thoracic) to 1 (all diaphragmatic).
 * Log-scaled around R = 1 so that R = 0.5 and R = 2 sit symmetrically either
 * side of centre — on a linear scale everything below 1 is crushed into the
 * left eighth of the bar. */
export function balancePosition(ratio: number | null): number | null {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return null;
  const clamped = Math.min(4, Math.max(0.25, ratio));
  return (Math.log2(clamped) + 2) / 4;
}
