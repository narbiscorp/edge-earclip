/*
 * log.ts — the session record for the Respiration Analysis app.
 *
 * Logging is CONTINUOUS: every beat, every accelerometer sample, and every 1 Hz
 * metrics row is kept from the moment a device connects, at full rate, without
 * anyone pressing record. The charts only ever show a window into this; the CSV
 * export writes all of it. Nothing that arrives is thrown away silently — when
 * a cap is reached the log stops accepting and says so, rather than quietly
 * dropping the oldest rows and leaving a gap you'd never notice in the export.
 *
 * Columns are parallel arrays rather than an array of objects: an hour of 50 Hz
 * accelerometer is 180 000 samples per axis, and the per-object overhead of the
 * obvious representation is what makes the tab swap.
 */

export type BeatSource = 'h10' | 'earclip';

/** Which chest strap an accelerometer sample came from. 'main' is the strap that also drives
 * the HRV analysis; 'lower' is a second H10 worn further down the torso, logged for its
 * accelerometer only — comparing the two is how thoracic and abdominal movement are told
 * apart. */
export type StrapId = 'main' | 'lower';

export const STRAPS: readonly StrapId[] = ['main', 'lower'];

/** Caps chosen so a long session (~4 h) fits comfortably; hitting one sets
 * `truncated` and is surfaced in the UI instead of being absorbed. */
const MAX_ACC_SAMPLES = 800_000;
/* ECG is 130 Hz — 2.6x the accelerometer rate — so it gets its own, larger cap.
 * 1.5 M samples is a little over 3 hours. */
const MAX_ECG_SAMPLES = 1_500_000;
const MAX_BEATS = 60_000;
const MAX_METRICS = 40_000;

/** One 1 Hz analysis row. Written by the metrics runner; every field lands in
 * the metrics CSV whether or not it is currently drawn.
 *
 * Every metric is nullable and null means "not computed" — too few beats in the
 * window, or no engine running. It deliberately does NOT collapse to zero: a
 * column of zeros is indistinguishable from a real measurement of zero once it
 * is in a CSV, and would drag any average computed downstream toward it. */
export interface MetricRow {
  t: number;
  /** Beats the time-domain metrics were computed over. */
  beatCount: number;
  windowSec: number;
  meanHr: number | null;
  sdnn: number | null;
  rmssd: number | null;
  pnn50: number | null;
  lf: number | null;
  hf: number | null;
  lfHfRatio: number | null;
  totalPower: number | null;
  /** Coherence Engine (app-side) outputs. */
  engineCoherence: number | null;
  engineCr: number | null;
  engineRespHz: number | null;
  enginePacerBpm: number | null;
  breathHeartCoherence: number | null;
  breathHeartPhaseDeg: number | null;
  accRespBpm: number | null;
  accRespConfidence: number | null;
  /** Other coherence definitions, kept side by side for comparison. */
  hmCoherence: number | null;
  resonanceCoherence: number | null;
  resonanceFreqHz: number | null;
  firmwareCoherence: number | null;
  firmwareRespHz: number | null;
}

/** One device's beats. Kept per source rather than in one interleaved column:
 * each device has its own clock, so a merged column is only NEARLY sorted and a
 * binary search on it can silently drop a beat at the window edge — including
 * from the window the HRV metrics are computed over. Within a single source the
 * timestamps are monotonic by construction (the H10 beat clock walks forward by
 * RR; earclip beats are stamped on arrival), so searching per source is exact. */
interface BeatColumns {
  t: number[];
  ibi: number[];
  bpm: number[];
  artifact: boolean[];
}

function emptyBeats(): BeatColumns {
  return { t: [], ibi: [], bpm: [], artifact: [] };
}

export interface BeatRow {
  t: number;
  ibi: number;
  bpm: number;
  source: BeatSource;
  artifact: boolean;
}

const SOURCES: readonly BeatSource[] = ['h10', 'earclip'];

interface AccColumns {
  t: number[];
  x: number[];
  y: number[];
  z: number[];
}

function emptyAcc(): AccColumns {
  return { t: [], x: [], y: [], z: [] };
}

/** Raw ECG, one column of signed microvolts at 130 Hz. */
interface EcgColumns {
  t: number[];
  uv: number[];
}

/** First index whose value is >= `target`, over a sorted-ascending array. */
function lowerBound(arr: readonly number[], target: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface WindowedXY {
  x: number[];
  y: number[];
}

export class SessionLog extends EventTarget {
  readonly beats: Record<BeatSource, BeatColumns> = {
    h10: emptyBeats(),
    earclip: emptyBeats(),
  };
  readonly acc: Record<StrapId, AccColumns> = { main: emptyAcc(), lower: emptyAcc() };
  readonly ecg: EcgColumns = { t: [], uv: [] };
  readonly metrics: MetricRow[] = [];

  /** Wall-clock ms of the first sample of any kind, or null when empty. */
  private _startedAt: number | null = null;
  private _truncated = false;
  /** Bumped on every append so charts can skip a redraw when nothing changed. */
  private _seq = 0;

  get startedAt(): number | null {
    return this._startedAt;
  }

  get truncated(): boolean {
    return this._truncated;
  }

  get seq(): number {
    return this._seq;
  }

  /** Total beats logged across every source. */
  get beatCount(): number {
    return this.beats.h10.t.length + this.beats.earclip.t.length;
  }

  /** Accelerometer samples logged for one strap. */
  accCount(strap: StrapId): number {
    return this.acc[strap].t.length;
  }

  /** Beats flagged by the plausibility gate or the earclip's own artifact bits. */
  get artifactCount(): number {
    let n = 0;
    for (const s of SOURCES) {
      for (const f of this.beats[s].artifact) if (f) n++;
    }
    return n;
  }

  get isEmpty(): boolean {
    return (
      this.beatCount === 0 &&
      this.accCount('main') === 0 &&
      this.accCount('lower') === 0 &&
      this.ecg.t.length === 0 &&
      this.metrics.length === 0
    );
  }

  /** Session length in ms from the first sample to the newest one. */
  get durationMs(): number {
    if (this._startedAt == null) return 0;
    const tail = (a: readonly number[]): number => (a.length ? a[a.length - 1] : 0);
    const last = Math.max(
      tail(this.beats.h10.t),
      tail(this.beats.earclip.t),
      tail(this.acc.main.t),
      tail(this.acc.lower.t),
      tail(this.ecg.t),
      this.metrics.length ? this.metrics[this.metrics.length - 1].t : 0,
    );
    return Math.max(0, last - this._startedAt);
  }

  /** Newest accelerometer sample for a strap, for the live readouts. */
  lastAcc(strap: StrapId, axis: 'x' | 'y' | 'z' | 'mag'): number | null {
    const c = this.acc[strap];
    const i = c.t.length - 1;
    if (i < 0) return null;
    if (axis !== 'mag') return c[axis][i];
    return Math.sqrt(c.x[i] * c.x[i] + c.y[i] * c.y[i] + c.z[i] * c.z[i]);
  }

  /** Newest non-artifact IBI from a source, for the live readouts. */
  lastIbi(source: BeatSource): number | null {
    const c = this.beats[source];
    for (let i = c.t.length - 1; i >= 0; i--) {
      if (!c.artifact[i]) return c.ibi[i];
    }
    return null;
  }

  private touch(t: number): void {
    if (this._startedAt == null) this._startedAt = t;
    this._seq++;
  }

  addBeat(t: number, ibiMs: number, bpm: number, source: BeatSource, artifact: boolean): void {
    if (this.beatCount >= MAX_BEATS) {
      this.markTruncated();
      return;
    }
    const c = this.beats[source];
    c.t.push(t);
    c.ibi.push(ibiMs);
    c.bpm.push(bpm);
    c.artifact.push(artifact);
    this.touch(t);
  }

  /** Append one accelerometer packet. `lastSampleMs` is the timestamp of the
   * NEWEST sample (the H10 gives us a device-clock frame timestamp, so we space
   * the rest of the block backwards from it rather than using BLE arrival). */
  addAccBlock(
    strap: StrapId,
    samples: ReadonlyArray<{ x: number; y: number; z: number }>,
    lastSampleMs: number,
    sampleRateHz: number,
  ): void {
    const n = samples.length;
    if (n === 0) return;
    const c = this.acc[strap];
    if (c.t.length + n > MAX_ACC_SAMPLES) {
      this.markTruncated();
      return;
    }
    const dt = 1000 / Math.max(1, sampleRateHz);
    for (let i = 0; i < n; i++) {
      const t = lastSampleMs - (n - 1 - i) * dt;
      c.t.push(t);
      c.x.push(samples[i].x);
      c.y.push(samples[i].y);
      c.z.push(samples[i].z);
    }
    this.touch(lastSampleMs);
  }

  /** Append one ECG frame. Like the accelerometer, `lastSampleMs` is the NEWEST
   * sample's device-clock time and the rest of the block is spaced backwards from it. */
  addEcgBlock(samples: ArrayLike<number>, lastSampleMs: number, sampleRateHz: number): void {
    const n = samples.length;
    if (n === 0) return;
    if (this.ecg.t.length + n > MAX_ECG_SAMPLES) {
      this.markTruncated();
      return;
    }
    const dt = 1000 / Math.max(1, sampleRateHz);
    for (let i = 0; i < n; i++) {
      this.ecg.t.push(lastSampleMs - (n - 1 - i) * dt);
      this.ecg.uv.push(samples[i]);
    }
    this.touch(lastSampleMs);
  }

  /** ECG over the trailing window, in microvolts. `maxRaw` strides the same way
   * accWindow does — at 130 Hz an hour is 468 000 samples. */
  ecgWindow(windowSec: number, nowMs: number, maxRaw = 60_000): WindowedXY {
    const from = nowMs - windowSec * 1000;
    const start = lowerBound(this.ecg.t, from);
    const len = this.ecg.t.length;
    const count = Math.max(0, len - start);
    const stride = count > maxRaw ? Math.ceil(count / maxRaw) : 1;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = start; i < len; i += stride) {
      x.push(this.ecg.t[i]);
      y.push(this.ecg.uv[i]);
    }
    if (stride > 1 && len > start && x[x.length - 1] !== this.ecg.t[len - 1]) {
      x.push(this.ecg.t[len - 1]);
      y.push(this.ecg.uv[len - 1]);
    }
    return { x, y };
  }

  addMetric(row: MetricRow): void {
    if (this.metrics.length >= MAX_METRICS) {
      this.markTruncated();
      return;
    }
    this.metrics.push(row);
    this.touch(row.t);
  }

  private markTruncated(): void {
    if (this._truncated) return;
    this._truncated = true;
    this.dispatchEvent(new CustomEvent('truncated'));
  }

  clear(): void {
    for (const s of SOURCES) {
      const c = this.beats[s];
      c.t.length = 0;
      c.ibi.length = 0;
      c.bpm.length = 0;
      c.artifact.length = 0;
    }
    for (const st of STRAPS) {
      const c = this.acc[st];
      c.t.length = 0;
      c.x.length = 0;
      c.y.length = 0;
      c.z.length = 0;
    }
    this.ecg.t.length = 0;
    this.ecg.uv.length = 0;
    this.metrics.length = 0;
    this._startedAt = null;
    this._truncated = false;
    this._seq++;
    this.dispatchEvent(new CustomEvent('cleared'));
  }

  /** One source's beats in the trailing window, matching `keep`. */
  private sourceWindow(
    source: BeatSource,
    from: number,
    keep: (artifact: boolean) => boolean,
  ): WindowedXY {
    const c = this.beats[source];
    const x: number[] = [];
    const y: number[] = [];
    for (let i = lowerBound(c.t, from); i < c.t.length; i++) {
      if (!keep(c.artifact[i])) continue;
      x.push(c.t[i]);
      y.push(c.ibi[i]);
    }
    return { x, y };
  }

  /** Beats within the trailing `windowSec`, optionally restricted to one source.
   * `includeArtifacts = false` drops flagged beats from the plotted/analysed
   * series — they are still in the log and still in the CSV. */
  beatWindow(
    windowSec: number,
    nowMs: number,
    source: BeatSource | 'both',
    includeArtifacts: boolean,
  ): WindowedXY {
    const from = nowMs - windowSec * 1000;
    const keep = (a: boolean): boolean => includeArtifacts || !a;
    if (source !== 'both') return this.sourceWindow(source, from, keep);
    return mergeByTime(
      this.sourceWindow('h10', from, keep),
      this.sourceWindow('earclip', from, keep),
    );
  }

  /** Artifact-flagged beats in the window, for the rejected-beat overlay. */
  artifactWindow(windowSec: number, nowMs: number, source: BeatSource | 'both'): WindowedXY {
    const from = nowMs - windowSec * 1000;
    const keep = (a: boolean): boolean => a;
    if (source !== 'both') return this.sourceWindow(source, from, keep);
    return mergeByTime(
      this.sourceWindow('h10', from, keep),
      this.sourceWindow('earclip', from, keep),
    );
  }

  /** Rejected beats in the trailing window, across the given source(s). */
  artifactCountInWindow(windowSec: number, nowMs: number, source: BeatSource | 'both'): number {
    return this.artifactWindow(windowSec, nowMs, source).x.length;
  }

  /** Every beat from every source, in time order. Used by the CSV export, which
   * wants one chronological file rather than one per device. */
  allBeatsSorted(): BeatRow[] {
    const rows: BeatRow[] = [];
    for (const s of SOURCES) {
      const c = this.beats[s];
      for (let i = 0; i < c.t.length; i++) {
        rows.push({ t: c.t[i], ibi: c.ibi[i], bpm: c.bpm[i], source: s, artifact: c.artifact[i] });
      }
    }
    rows.sort((a, b) => a.t - b.t);
    return rows;
  }

  /**
   * Accelerometer axis over the trailing window. `axis` 'mag' is the vector
   * magnitude, which is orientation-independent and so survives the strap
   * sitting at a different angle on a different subject.
   *
   * `maxRaw` caps how many samples are materialised. An hour at 50 Hz is
   * 180 000 samples per axis, and building three of those arrays several times
   * a second is enough to make the page stutter. Above the cap we take every
   * n-th sample — deliberately leaving far more points than the chart will draw
   * (the caller's budget is ~2500), so the largest-triangle reduction that runs
   * afterwards still has a dense field to pick its peaks from. This affects
   * DRAWING only; the log and the CSV export always see every sample.
   */
  accWindow(
    strap: StrapId,
    windowSec: number,
    nowMs: number,
    axis: 'x' | 'y' | 'z' | 'mag',
    maxRaw = 60_000,
  ): WindowedXY {
    const c = this.acc[strap];
    const from = nowMs - windowSec * 1000;
    const start = lowerBound(c.t, from);
    const len = c.t.length;
    const count = Math.max(0, len - start);
    const stride = count > maxRaw ? Math.ceil(count / maxRaw) : 1;
    const x: number[] = [];
    const y: number[] = [];
    const at = (i: number): number => {
      if (axis !== 'mag') return c[axis][i];
      const ax = c.x[i];
      const ay = c.y[i];
      const az = c.z[i];
      return Math.sqrt(ax * ax + ay * ay + az * az);
    };
    for (let i = start; i < len; i += stride) {
      x.push(c.t[i]);
      y.push(at(i));
    }
    // Always end on the newest sample so a live trace reaches the right edge.
    if (stride > 1 && len > start && x[x.length - 1] !== c.t[len - 1]) {
      x.push(c.t[len - 1]);
      y.push(at(len - 1));
    }
    return { x, y };
  }

  /** One numeric metric column over the trailing window. */
  metricWindow(
    windowSec: number,
    nowMs: number,
    pick: (row: MetricRow) => number | null,
  ): WindowedXY {
    const from = nowMs - windowSec * 1000;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = this.metrics.length - 1; i >= 0; i--) {
      const row = this.metrics[i];
      if (row.t < from) break;
      const v = pick(row);
      if (v == null || !Number.isFinite(v)) continue;
      x.push(row.t);
      y.push(v);
    }
    x.reverse();
    y.reverse();
    return { x, y };
  }

  /** IBIs (ms) and their timestamps for the analysis window, artifact-filtered.
   * This is what the metrics runner hands to the worker. */
  analysisWindow(
    windowSec: number,
    nowMs: number,
    source: BeatSource,
  ): { times_s: Float64Array; ibis_ms: Float64Array; beat_ms: Float64Array } {
    const w = this.beatWindow(windowSec, nowMs, source, false);
    const n = w.x.length;
    const times_s = new Float64Array(n);
    const ibis_ms = new Float64Array(n);
    const beat_ms = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      // Absolute epoch seconds — same convention as metrics/windowing.ts, so the
      // Lomb-Scargle grid sees identical inputs to the main dashboard.
      times_s[i] = w.x[i] / 1000;
      ibis_ms[i] = w.y[i];
      beat_ms[i] = w.x[i];
    }
    return { times_s, ibis_ms, beat_ms };
  }
}

/** Merge two time-ordered windows into one. Both inputs come from per-source
 * columns that are individually sorted, so a two-pointer merge is exact. */
function mergeByTime(a: WindowedXY, b: WindowedXY): WindowedXY {
  if (a.x.length === 0) return b;
  if (b.x.length === 0) return a;
  const x: number[] = [];
  const y: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.x.length && j < b.x.length) {
    if (a.x[i] <= b.x[j]) {
      x.push(a.x[i]);
      y.push(a.y[i]);
      i++;
    } else {
      x.push(b.x[j]);
      y.push(b.y[j]);
      j++;
    }
  }
  while (i < a.x.length) {
    x.push(a.x[i]);
    y.push(a.y[i]);
    i++;
  }
  while (j < b.x.length) {
    x.push(b.x[j]);
    y.push(b.y[j]);
    j++;
  }
  return { x, y };
}

export const sessionLog = new SessionLog();
