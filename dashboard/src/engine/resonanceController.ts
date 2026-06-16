/*
 * resonanceController.ts — Mode B "Find my resonance" controller (hill-climb + maintain).
 *
 * Faithful port of Swift `ResonanceController`. State machine: searching → maintaining
 * (lock is instantaneous; a clamp-edge lock sets `boundaryLimited`). Acquires RF by
 * finite-difference hill-climb with adaptive step + two-sided bracketing + parabolic
 * vertex; holds it with an extremum-seeking dither (demodulated, fatigue-immune) and a
 * sudden-loss re-probe. Per-dwell accept gate uses positive respiration verification +
 * artifact-clean. Output: `commandedBPM`, fed to the FollowPacer's slew limiter.
 */
import type { CoherenceTunables } from './tunables';

export type ModeBState = 'searching' | 'maintaining';

type SearchPhase = 'probe0' | 'findDir' | 'bracketOut' | 'refine';

/** Plain-language progress for the UI while the controller searches. */
export interface SearchProgress {
  phase: 'baseline' | 'climbing' | 'refining';
  breath: number; // breaths elapsed in the current dwell
  dwellBreaths: number; // breaths held per dwell
  bestRate: number | null; // strongest-response rate found so far (BPM)
  testedCount: number; // distinct rates tested so far
}

const PHASE_LABEL: Record<SearchPhase, SearchProgress['phase']> = {
  probe0: 'baseline',
  findDir: 'baseline',
  bracketOut: 'climbing',
  refine: 'refining',
};

interface Sample {
  bpm: number;
  amp: number;
}

export class ResonanceController {
  private readonly t: CoherenceTunables;
  state: ModeBState = 'searching';
  commandedBPM: number;
  lockedRF = 0;
  boundaryLimited = false; // RF locked at a search-range edge
  unverifiedDwells = 0; // measured-but-disagreed dwells ⇒ "hold still / follow the cue"
  unmeasuredDwells = 0; // ACC gave no usable estimate (warming up / dropout) — re-dwell, don't penalize
  searchAborted = false; // search gave up
  searchAbortReason: 'unverified' | 'unmeasured' | null = null; // why it gave up (drives the UI message)

  // dwell bookkeeping
  private breathsThisDwell = 0;
  private dwellAmps: number[] = [];
  private dwellArtifactOk = true; // no gated beats this dwell
  private dwellVerified = 0; // estimate-window breaths positively verified against ACC
  private dwellEstimate = 0; // estimate-window breaths total
  private dwellMeasured = 0; // estimate-window breaths with ANY usable ACC estimate (non-null)

  // search state — explicit bracket → golden-section → lock
  private phase: SearchPhase = 'probe0';
  private startRate = 0;
  private lo = 0;
  private mid = 0;
  private hi = 0;
  private probeDir = -1.0; // uphill direction, discovered in findDir
  private readonly gold = (Math.sqrt(5.0) - 1.0) / 2.0; // 0.618…
  private samples: Sample[] = [];

  // maintenance — extremum-seeking + sudden-loss detector
  private ditherT0 = 0;
  private escMeanA = 0; // high-pass reference → uniform-drift (fatigue) immunity
  private ampFast = 0;
  private ampSlow = 0;
  private lastReprobeS = 0;
  private lowSinceS: number | null = null;

  /** `startBPM` from cross-session RF prior → short confirmation instead of a cold hunt. */
  constructor(t: CoherenceTunables, startBPM?: number) {
    this.t = t;
    this.commandedBPM = startBPM ?? 6.0;
    // INVARIANT: the settling discard must outlast the pacer slew to a new commanded rate.
    const settle = Math.ceil(t.dwellBreaths * (1.0 - t.dwellEstimateFraction));
    const slewBreaths = t.probeStepInitBPM / (t.pacerSlewQuintet * 0.2);
    if (import.meta.env?.DEV && settle < slewBreaths) {
      // eslint-disable-next-line no-console
      console.warn(
        `Mode B settling (${settle} br) must cover the pacer slew (${slewBreaths} br): ` +
          'lower probeStepInitBPM or raise dwellBreaths / dwellEstimateFraction.',
      );
    }
  }

  /** Persist this per user (localStorage) for warm-start. */
  storedRF(): number {
    return this.lockedRF;
  }

  /** Fraction of the current dwell's estimate-window breaths positively verified against the ACC
   * respiration, or null before the estimate window has started. For the live diagnostics readout. */
  get verifiedRatio(): number | null {
    return this.dwellEstimate > 0 ? this.dwellVerified / this.dwellEstimate : null;
  }

  /** Plain-language progress snapshot for the UI (valid while searching). */
  searchProgress(): SearchProgress {
    const c = this.collapsed();
    return {
      phase: PHASE_LABEL[this.phase],
      breath: this.breathsThisDwell,
      dwellBreaths: this.t.dwellBreaths,
      bestRate: c.length > 0 ? this.bestRate() : null,
      testedCount: c.length,
    };
  }

  /**
   * Call once per completed breath cycle.
   * - cycleAmplitude: this cycle's peak-to-trough RR (from FastAmplitudeTracker), or null.
   * - measuredBPM/respConfidence: from RespirationFromACC.
   * - pacedBPM: the rate the user was ACTUALLY paced at this cycle (pacer's current rate).
   * - dwellArtifactClean: false if any beat in this cycle was gated.
   */
  onBreathCycle(args: {
    cycleAmplitude: number | null;
    measuredBPM: number | null;
    respConfidence: number;
    pacedBPM?: number;
    dwellArtifactClean: boolean;
    nowS: number;
  }): number {
    const { cycleAmplitude, measuredBPM, respConfidence, pacedBPM, dwellArtifactClean, nowS } = args;

    if (this.searchAborted) return this.commandedBPM; // gave up — hold a steady pace

    if (this.state === 'maintaining') {
      this.maintain(cycleAmplitude, nowS);
      return this.commandedBPM;
    }

    this.breathsThisDwell += 1;
    // Discard the settling transient (ceil so the discard outlasts the pacer slew).
    const settle = Math.ceil(this.t.dwellBreaths * (1.0 - this.t.dwellEstimateFraction));
    const verifyRate = pacedBPM ?? this.commandedBPM;

    // Collect + verify only in the estimate window (after settling).
    if (this.breathsThisDwell > settle) {
      // POSITIVE verification: a breath counts only if respiration is CONFIRMED at the paced
      // rate (ACC confidence high enough AND measured ≈ paced). Low confidence ⇒ unverifiable.
      this.dwellEstimate += 1;
      const measured = measuredBPM !== null && Number.isFinite(measuredBPM);
      if (measured) this.dwellMeasured += 1; // distinguishes "no ACC at all" from "ACC disagreed"
      const verified =
        measured &&
        respConfidence >= this.t.respConfidenceMin &&
        Math.abs((measuredBPM as number) - verifyRate) <= this.t.respVerifyToleranceBPM;
      if (verified) this.dwellVerified += 1;
      if (cycleAmplitude !== null && Number.isFinite(cycleAmplitude)) {
        this.dwellAmps.push(cycleAmplitude); // never let NaN into the estimate
      }
    }
    if (!dwellArtifactClean) this.dwellArtifactOk = false;

    if (this.breathsThisDwell < this.t.dwellBreaths) return this.commandedBPM;

    // ---- dwell complete ----
    const resetDwell = () => {
      this.breathsThisDwell = 0;
      this.dwellAmps = [];
      this.dwellArtifactOk = true;
      this.dwellVerified = 0;
      this.dwellEstimate = 0;
      this.dwellMeasured = 0;
    };

    // The ACC respiration channel produced NO usable estimate this whole dwell — the H10
    // accelerometer is still warming up (stream just started), dropped out, or is too noisy to
    // read. Re-dwell at the same rate WITHOUT charging the verification-failure budget: that
    // budget means "you breathed at the wrong rate," not "we couldn't see your breathing at all."
    if (this.dwellMeasured === 0) {
      this.unmeasuredDwells += 1;
      if (this.unmeasuredDwells >= this.t.maxUnverifiedDwells) {
        this.searchAborted = true; // ACC never came online — stop hunting blind
        this.searchAbortReason = 'unmeasured';
      }
      resetDwell();
      return this.commandedBPM;
    }
    this.unmeasuredDwells = 0;

    // A dwell counts if it was artifact-clean AND a MAJORITY of its estimate-window breaths
    // were positively verified against the ACC respiration — robust to the odd noisy breath,
    // while still rejecting a dwell the user clearly didn't follow.
    const verifiedEnough = this.dwellEstimate > 0 && this.dwellVerified * 2 >= this.dwellEstimate;
    if (!this.dwellArtifactOk || !verifiedEnough || this.dwellAmps.length === 0) {
      this.unverifiedDwells += 1; // discard → re-dwell at the same rate
      if (this.unverifiedDwells >= this.t.maxUnverifiedDwells) {
        this.searchAborted = true; // stop hunting on data we can never verify
        this.searchAbortReason = 'unverified';
      }
      resetDwell();
      return this.commandedBPM;
    }
    this.unverifiedDwells = 0;
    const amp = this.dwellAmps.reduce((s, v) => s + v, 0) / this.dwellAmps.length;
    const eps = Math.max(this.t.epsilonPctOfA * amp, this.stdev(this.dwellAmps));

    this.samples.push({ bpm: this.commandedBPM, amp });
    this.decideNextRate(eps, nowS);
    resetDwell();
    return this.commandedBPM;
  }

  // --- search decision: explicit bracket → golden-section → lock ---

  /** Snap a search command to the 0.2-BPM quintet grid (the pacer's native resolution). */
  private snapSearch(b: number): number {
    return this.clampSearch(Math.round(b / this.t.probeStepFloorBPM) * this.t.probeStepFloorBPM);
  }

  private decideNextRate(eps: number, nowS: number): void {
    // Boundary lock: the just-completed dwell sits at a search-range edge, is the best so
    // far, and an interior sample is lower — the true peak is at/beyond the clamp.
    const lastRate = this.commandedBPM;
    if (
      (lastRate <= this.t.searchLoBPM + 1e-6 || lastRate >= this.t.searchHiBPM - 1e-6) &&
      this.isBestSoFar(lastRate) &&
      this.hasLowerInteriorNeighbor(eps)
    ) {
      this.lockRF(lastRate, nowS, true);
      return;
    }

    switch (this.phase) {
      case 'probe0':
        this.startRate = lastRate;
        this.phase = 'findDir';
        this.commandedBPM = this.snapSearch(this.startRate - this.t.probeStepInitBPM); // probe one step down
        break;
      case 'findDir': {
        const aStart = this.ampAt(this.startRate) ?? -1;
        const aDown = this.ampAt(this.commandedBPM) ?? -1;
        if (aDown > aStart) {
          this.probeDir = -1;
          this.mid = this.commandedBPM;
          this.lo = this.startRate;
        } else {
          this.probeDir = +1;
          this.mid = this.startRate;
          this.lo = this.commandedBPM;
        }
        this.phase = 'bracketOut';
        this.commandedBPM = this.snapSearch(this.mid + this.probeDir * this.t.probeStepInitBPM);
        break;
      }
      case 'bracketOut': {
        const aNew = this.ampAt(this.commandedBPM);
        const aMid = this.ampAt(this.mid);
        if (aNew === null || aMid === null) return;
        if (aNew > aMid) {
          // still climbing → shift window
          this.lo = this.mid;
          this.mid = this.commandedBPM;
          const next = this.snapSearch(this.mid + this.probeDir * this.t.probeStepInitBPM);
          if (Math.abs(next - this.mid) < 1e-9) {
            // climbed into a clamp edge
            this.lockRF(this.mid, nowS, true);
            return;
          }
          this.commandedBPM = next;
        } else {
          // dropped → 3-point bracket
          this.hi = this.commandedBPM;
          this.phase = 'refine';
          this.refineStep(nowS);
        }
        break;
      }
      case 'refine':
        this.refineStep(nowS);
        break;
    }
  }

  /** One golden-section step inside the bracket; locks (parabolic vertex) when it can't tighten on the grid. */
  private refineStep(nowS: number): void {
    let [a, b, c] = this.sortedTriple(this.lo, this.mid, this.hi); // a<b<c by rate, b = best
    // The tightest 3-point bracket on the grid is width 2·floor; lock there and let the
    // parabola give sub-grid RF.
    if (c - a <= 2 * this.t.probeStepFloorBPM + 1e-9) {
      this.lockRF(this.parabolicVertex(a, b, c) ?? b, nowS, false);
      return;
    }
    const probe =
      b - a > c - b
        ? this.snapSearch(b - (1 - this.gold) * (b - a))
        : this.snapSearch(b + (1 - this.gold) * (c - b));
    const ap = this.ampAt(probe);
    if (ap === null) {
      this.commandedBPM = probe; // not yet dwelled → wait
      return;
    }
    const ab = this.ampAt(b) ?? -1;
    if (ap > ab) {
      // probe is the new peak → drop b to the near-side bound
      if (probe < b) c = b;
      else a = b;
      b = probe;
    } else {
      // b stays the peak → shrink the side the probe is on
      if (probe < b) a = probe;
      else c = probe;
    }
    this.lo = a;
    this.mid = b;
    this.hi = c;
    this.commandedBPM =
      b - a > c - b
        ? this.snapSearch(b - (1 - this.gold) * (b - a))
        : this.snapSearch(b + (1 - this.gold) * (c - b));
  }

  // --- maintenance: extremum-seeking drift defense + sudden-loss re-probe ---
  private maintain(cycleAmplitude: number | null, nowS: number): void {
    const ditherPhase = mod(nowS - this.ditherT0, this.t.ditherPeriodS) / this.t.ditherPeriodS;
    const s = Math.sin(2 * Math.PI * ditherPhase);
    this.commandedBPM = this.clampSearch(this.lockedRF + this.t.ditherAmpBPM * s);

    if (cycleAmplitude === null || !Number.isFinite(cycleAmplitude)) return;
    const a = cycleAmplitude;

    // High-pass the objective (subtract its slow mean) so a UNIFORM amplitude drop —
    // fatigue — cancels and never looks like a gradient.
    if (this.escMeanA === 0) this.escMeanA = a;
    else this.escMeanA += (a - this.escMeanA) * this.t.escMeanAlpha;
    const aTilde = a - this.escMeanA;
    const grad = (aTilde / Math.max(this.escMeanA, 1e-6)) * s;
    const dRF = Math.max(-this.t.escMaxStepBPM, Math.min(this.t.escMaxStepBPM, this.t.escGainBPM * grad));
    this.lockedRF = this.clampSearch(this.lockedRF + dRF);

    // Sudden-loss detector: fast vs slow amplitude EWMA. Fatigue moves both together;
    // a sudden drop (rate slipped, strap moved) drops the fast EWMA first → trigger.
    if (this.ampSlow === 0) this.ampSlow = a;
    if (this.ampFast === 0) this.ampFast = a;
    this.ampFast += (a - this.ampFast) * this.t.decayFastAlpha;
    this.ampSlow += (a - this.ampSlow) * this.t.decaySlowAlpha;
    if (this.ampFast < this.ampSlow * (1.0 - this.t.reprobeDecayPct)) {
      if (this.lowSinceS === null) this.lowSinceS = nowS;
      else if (
        nowS - this.lowSinceS >= this.t.reprobeSustainS &&
        nowS - this.lastReprobeS >= this.t.reprobeCapS
      ) {
        this.restartSearchAroundLock(nowS);
      }
    } else {
      this.lowSinceS = null;
    }
  }

  private restartSearchAroundLock(nowS: number): void {
    this.state = 'searching';
    this.boundaryLimited = false;
    this.phase = 'probe0';
    this.probeDir = -1; // fresh bracket search from the locked RF
    this.samples = [];
    this.breathsThisDwell = 0;
    this.dwellAmps = [];
    this.dwellArtifactOk = true;
    this.dwellVerified = 0;
    this.dwellEstimate = 0;
    this.dwellMeasured = 0;
    this.commandedBPM = this.lockedRF;
    this.lastReprobeS = nowS;
    this.lowSinceS = null;
    this.escMeanA = 0;
    this.ampFast = 0;
    this.ampSlow = 0;
  }

  private lockRF(rf: number, nowS: number, boundary: boolean): void {
    this.lockedRF = this.clampSearch(rf);
    this.commandedBPM = this.lockedRF;
    this.state = 'maintaining';
    this.boundaryLimited = boundary;
    this.ditherT0 = nowS;
    this.lastReprobeS = nowS;
    this.lowSinceS = null;
    this.escMeanA = 0;
    this.ampFast = 0;
    this.ampSlow = 0;
  }

  // --- helpers on collapsed (best-amp-per-rate) samples ---
  private collapsed(): Sample[] {
    const best = new Map<number, number>();
    for (const s of this.samples) {
      const key = Math.round(s.bpm / 0.1) * 0.1;
      best.set(key, Math.max(best.get(key) ?? -Infinity, s.amp));
    }
    return Array.from(best.entries())
      .map(([bpm, amp]) => ({ bpm, amp }))
      .sort((x, y) => x.bpm - y.bpm);
  }
  private bestRate(): number {
    const c = this.collapsed();
    if (c.length === 0) return this.commandedBPM;
    return c.reduce((a, b) => (b.amp > a.amp ? b : a)).bpm;
  }
  private bestAmp(): number {
    const c = this.collapsed();
    if (c.length === 0) return -1;
    return Math.max(...c.map((s) => s.amp));
  }
  /** Best amplitude recorded for `bpm`'s 0.1-BPM bin, or null if that rate hasn't been dwelled yet. */
  private ampAt(bpm: number): number | null {
    const key = Math.round(bpm / 0.1) * 0.1;
    const hit = this.collapsed().find((s) => Math.abs(s.bpm - key) < 1e-6);
    return hit ? hit.amp : null;
  }
  private isBestSoFar(rate: number): boolean {
    const key = Math.round(rate / 0.1) * 0.1;
    return Math.abs(this.bestRate() - key) < 1e-6;
  }
  private sortedTriple(x: number, y: number, z: number): [number, number, number] {
    const s = [x, y, z].sort((a, b) => a - b);
    return [s[0], s[1], s[2]];
  }
  /** Any sampled rate lower than the best by > eps. */
  private hasLowerInteriorNeighbor(eps: number): boolean {
    const ba = this.bestAmp();
    const br = this.bestRate();
    return this.collapsed().some((s) => Math.abs(s.bpm - br) > 1e-6 && s.amp < ba - eps);
  }
  /** Vertex of the parabola through three (rate, amp) points; null unless it's a max inside [x0,x2]. */
  private parabolicVertex(x0: number, x1: number, x2: number): number | null {
    const y0 = this.ampAt(x0);
    const y1 = this.ampAt(x1);
    const y2 = this.ampAt(x2);
    if (y0 === null || y1 === null || y2 === null) return null;
    const d = (x0 - x1) * (x0 - x2) * (x1 - x2);
    if (Math.abs(d) <= 1e-9) return null;
    const A = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / d;
    const B = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / d;
    if (A >= 0) return null; // must be a maximum
    const v = -B / (2 * A);
    const loX = Math.min(x0, x2);
    const hiX = Math.max(x0, x2);
    return v >= loX && v <= hiX ? v : null;
  }
  private clampSearch(b: number): number {
    return Math.min(this.t.searchHiBPM, Math.max(this.t.searchLoBPM, b));
  }
  private stdev(x: number[]): number {
    if (x.length <= 1) return 0;
    const m = x.reduce((s, v) => s + v, 0) / x.length;
    return Math.sqrt(x.reduce((s, v) => s + (v - m) * (v - m), 0) / (x.length - 1));
  }
}

/** Swift's truncatingRemainder — JS `%` already matches for non-negative dividend. */
function mod(a: number, n: number): number {
  return a - Math.trunc(a / n) * n;
}
