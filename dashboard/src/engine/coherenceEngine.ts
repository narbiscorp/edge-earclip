/*
 * coherenceEngine.ts — main-thread orchestrator singleton for the app-side Coherence Engine.
 *
 * Adapts the Swift `CoherenceEngine` to the browser: single-threaded (no NSLock), self-driving
 * timers, and a `onDuty` output callback the host wires to the glasses' 0xA5 lens-duty opcode.
 * SessionLogger (offline research export) is intentionally omitted — the dashboard has its own
 * recording pipeline. Status is published via CustomEvents on this EventTarget.
 *
 * Cadences (mirrors the Swift orchestration note):
 *   • on each H10 RR notification  → onH10RR(...)        (ingest + artifact gate + Mode B cycle-clean tally)
 *   • on each H10 ACC packet       → onAccPacket(...)     [Mode B only]
 *   • 1 Hz                         → tick1Hz()            (LS → CR + resp readback → pacer.push)
 *   • per breathing-cycle boundary → onBreathBoundary()   (pacer.latch and/or Mode B controller)
 *   • ~lens rate (default ~12 Hz)  → emit 0–100 duty via onDuty
 */
import { type CoherenceTunables, DEFAULT_TUNABLES, gammaTable } from './tunables';
import { IBIIngest } from './ibiIngest';
import { LombScargleCore } from './lombScargleCore';
import { FollowPacer } from './followPacer';
import { FastAmplitudeTracker } from './fastAmplitude';
import { RespirationFromACC } from './respirationFromAcc';
import { ResonanceController, type ModeBState, type SearchProgress } from './resonanceController';
import { computeBreathHeartCoherence, GAMMA2_CONFOUND_FLOOR } from './breathHeartCoherence';

export type { EngineMode } from './tunables';

export type HRVSource = 'polarH10' | 'edgeRelay' | 'appleWatch';
export type ActiveEngineMode = 'modeA' | 'modeB' | 'modeC';
export type LensStyle = 'heartbeat' | 'breathingGuide' | 'coherenceLens' | 'breatheStrobe';

/** UI Standard-program numbers (1-4). Matches the firmware 0xB7 ordering
 * (1=Heartbeat, 2=Breathing Guide, 3=Coherence Lens, 4=Breath+Strobe). */
export type LensProgram = 1 | 2 | 3 | 4;
const PROGRAM_TO_STYLE: Record<LensProgram, LensStyle> = {
  1: 'heartbeat',
  2: 'breathingGuide',
  3: 'coherenceLens',
  4: 'breatheStrobe',
};

/** Desired lens state the engine emits each update. The host (edgeDevice.driveLens) coalesces it
 * into the firmware's breathe/strobe/static commands so the firmware renders the smooth cycle and
 * we never stream per-tick PWM. */
export interface LensState {
  style: LensStyle;
  bpm: number; // integer breaths/min (firmware 0xB1 is integer)
  depthPct: number; // 0..100 peak lens darkness (firmware brightness 0xA2 / static 0xA5)
  inhalePct: number;
  strobeHz: number;
  strobeDutyPct: number;
}

/** Mode C internal phase: Follow warm-up → seeded verified search → maintain. */
export type ModeCPhase = 'warmup' | 'searching' | 'maintaining';

/** Mode B (and the Mode C search) need validated RR + an independent respiration channel (H10 ACC). */
function allowsModeB(source: HRVSource): boolean {
  return source === 'polarH10';
}

export interface EngineStatus {
  running: boolean;
  mode: ActiveEngineMode;
  source: HRVSource;
  coherence: number; // squashed lens drive 0..100
  cr: number; // field-standard coherence ratio
  respHz: number; // LS resonance readback
  pacerBpm: number; // current pacer rate
  duty: number; // last lens duty sent 0..100
  beats: number; // beats currently in the analysis window
  // Mode A — real (cross-spectral) breath–heart coherence (null when no/short H10 ACC)
  breathHeartCoherence: number | null; // γ² (0..1) at the respiration peak — the literature's coherence
  breathHeartPhaseDeg: number | null; // HR–respiration phase there (degrees; ≈0 at resonance)
  coherenceConfounded: boolean; // the followed rhythm is NOT driven by the measured breathing
  // Mode B
  modeBState: ModeBState | null;
  /** The breathing rate (BPM) the controller is currently pacing/testing. */
  modeBCommandedBpm: number | null;
  /** Search progress (phase / dwell breath / best rate so far), or null when not searching. */
  modeBProgress: SearchProgress | null;
  lockedRF: number | null; // valid only when maintaining
  boundaryLimited: boolean;
  searchAborted: boolean;
  unverifiedDwells: number; // measured-but-disagreed dwells
  unmeasuredDwells: number; // ACC produced no usable estimate (warming up / dropout)
  searchAbortReason: 'unverified' | 'unmeasured' | null;
  /** ACC respiration estimate at the last breath boundary — the Mode B verification input. */
  accMeasuredBpm: number | null;
  accRespConfidence: number;
  /** Fraction of the current dwell's estimate-window breaths verified vs ACC, or null. */
  modeBVerifiedRatio: number | null;
  // Mode C
  /** Current Mode C phase, or null outside Mode C. In 'warmup' the Mode B fields above are all
   * defaulted (no controller exists yet) so the UI never renders stale resonance data. */
  modeCPhase: ModeCPhase | null;
  /** Warm-up gate telemetry (false outside Mode C warm-up). ACC confidence is MANDATORY for entry. */
  modeCAccConfident: boolean;
  modeCStable: boolean;
  /** Quiet initial settling for Mode C's Follow warm-up: sensors warm up while the UI cue/chime is
   * paused and the lens is held clear. (Mode B is now the Static Pacer and has no settling.) */
  settling: boolean;
  /** Mode B "Static Pacer": the fixed rate being paced (br/min), or null outside static mode. */
  staticPacerBpm: number | null;
  /** True in Mode B (Static Pacer) — a fixed user/clinician rate, Mode-A coherence feedback. */
  staticMode: boolean;
}

export interface StartOptions {
  mode: ActiveEngineMode;
  source: HRVSource;
  tunables: CoherenceTunables;
  /** 0..100 lens brightness ceiling. */
  brightness?: number;
  /** 0..3 difficulty (gamma curve on coherence → lens depth). */
  difficulty?: number;
  /** Standard program (1-4) to render. Takes precedence over `lensStyle`. */
  program?: LensProgram;
  lensStyle?: LensStyle;
  strobeHz?: number;
  strobeDutyPct?: number;
  /** Persisted per-user resonance frequency for a warm Mode B start. */
  priorRF?: number | null;
  /** Mode B (Static Pacer) initial rate (br/min). Defaults to 6.0; clamped to 4.0–10.0. */
  staticPacerBpm?: number;
  /** Sink for the desired lens state. The host (edgeDevice.driveLens) coalesces it into the
   * firmware's breathe/strobe/static commands — the firmware renders the smooth cycle, so we
   * never stream per-tick PWM. */
  onLens: (state: LensState) => void;
  /** Sink for breath-cycle phase sync. Fired at start, at each cycle boundary (= inhale start),
   * and on resync(), with the exact cycle length (ms) + inhale %. The host (edgeDevice.syncBreath)
   * forwards it as the firmware BREATHE_SYNC opcode so the glasses lens phase-locks to this clock. */
  onSync?: (cycleMs: number, inhalePct: number) => void;
}

const LENS_TICK_MS = 83; // ~12 Hz lens-duty stream (smooth breathing, BLE-friendly)
const BH_NULL_RESET_TICKS = 8; // ~8 s with no cross-spectral estimate ⇒ clear the smoothed breath–heart readout

// Mode B = "Static Pacer": a fixed user/clinician-set breathing rate (Mode-A coherence feedback, no
// follow). Bounds match the clinical slow-breathing band; default is the canonical 6 br/min.
export const STATIC_PACER_MIN_BPM = 4.0;
export const STATIC_PACER_MAX_BPM = 10.0;
export const STATIC_PACER_DEFAULT_BPM = 6.0;
const STATIC_PACER_STEP_BPM = 0.1;
// How long a Mode A / Mode C-warm-up manual nudge HOLDS the chosen pace before the auto-follow
// resumes ("pick up after a few cycles") — ~3 breaths at 6 br/min.
const MANUAL_NUDGE_HOLD_MS = 30_000;
export function clampStaticPacerBpm(b: number): number {
  if (!Number.isFinite(b)) return STATIC_PACER_DEFAULT_BPM;
  // Snap to the 0.1 grid so typed values like 6.05 land cleanly, then clamp to the band.
  const snapped = Math.round(b / STATIC_PACER_STEP_BPM) * STATIC_PACER_STEP_BPM;
  return Math.min(STATIC_PACER_MAX_BPM, Math.max(STATIC_PACER_MIN_BPM, snapped));
}

export class CoherenceEngine extends EventTarget {
  private t: CoherenceTunables = { ...DEFAULT_TUNABLES };
  private source: HRVSource = 'polarH10';
  private mode: ActiveEngineMode = 'modeA';
  private brightness = 100;
  private difficulty = 1;
  private lensStyle: LensStyle = 'breathingGuide';
  private strobeHz = 10;
  private strobeDutyPct = 50;
  private onLens: ((state: LensState) => void) | null = null;
  private onSync: ((cycleMs: number, inhalePct: number) => void) | null = null;

  private ingest = new IBIIngest(this.t);
  private ls = new LombScargleCore(this.t);
  private pacer = new FollowPacer(this.t);
  private amplitude = new FastAmplitudeTracker(this.t);
  private resp = new RespirationFromACC(this.t);
  private modeB: ResonanceController | null = null;

  private secTimer: ReturnType<typeof setInterval> | null = null;
  private lensTimer: ReturnType<typeof setInterval> | null = null;

  // breath-cycle clock
  private cycleMs = 10_000; // default 6 BPM
  private cycleStartMs = 0;

  // Mode B cycle-clean tally (engine-owned, derived from its own gate)
  private gatedBeatsThisCycle = 0;

  // Mode C "Settle & Find" warm-up state. While `mode === 'modeC'` and `modeB == null` the engine
  // runs the Mode A Follow path and accumulates these 1 Hz samples for the transition gate. The
  // detected rate is the UNSMOOTHED LS LF-readback peak (NOT the slew-limited pacer output).
  private warmupStartS = 0;
  private warmupResp: Array<{ s: number; bpm: number }> = [];
  private warmupAcc: Array<{ s: number; ok: boolean }> = [];
  private modeCAccConfident = false;
  private modeCStable = false;

  // Mode B = "Static Pacer": a fixed user/clinician rate with Mode-A coherence feedback (no follow,
  // no resonance search). `staticMode` is true only in Mode B; `staticPacerBpm` is the held rate.
  private staticMode = false;
  private staticPacerBpm = STATIC_PACER_DEFAULT_BPM;

  // Mode C manual-nudge seed override: a rate set by nudgePacer during warm-up that the handoff uses
  // as the search's first rate instead of the windowed-mean seed. null = use the gate's seed.
  private seedOverrideBpm: number | null = null;

  // Manual nudge HOLD (Mode A / Mode C warm-up): a fixed pace the user dialled in with the ± arrows
  // that overrides the auto-follow for MANUAL_NUDGE_HOLD_MS, then auto-clears so following resumes.
  // Only consulted while no controller exists (modeB == null), so a Mode C search is never overridden.
  private manualBpm: number | null = null;
  private manualHoldUntilMs = 0;

  // published outputs
  private _coherence = 0;
  private _cr = 0;
  private _respHz = 0;
  private _breathHeartCoh: number | null = null; // EWMA-smoothed γ² (null until first estimate / after a sustained ACC gap)
  private _bhPhaseRe = 0; // γ²-weighted EWMA of cos(phase) — circular-mean accumulator (avoids ±180° wrap)
  private _bhPhaseIm = 0; // γ²-weighted EWMA of sin(phase)
  private _confounded = false;
  private _bhNullTicks = 0; // consecutive ticks with no cross-spectral estimate (decay-to-null guard)
  private _lastDuty = 0;
  // ACC respiration estimate cached at each breath boundary (Mode B verification input), for status.
  private _accMeasuredBpm: number | null = null;
  private _accRespConfidence = 0;

  // Lens depth + rate are LATCHED per breath: sampled once at each boundary (where frac ≈ 0) and held
  // for the whole breath. The firmware renders effective_duty = wave(frac) × depth; pushing a new
  // depth (0xA2) or rate (0xB1) mid-inhale makes that product non-monotonic — the lens darkens, clears
  // a bit, then darkens again (a visible stutter). Holding them constant within a breath kills it, on
  // any firmware. Updated in latchLensParams(); emitLens sends these, not the live values.
  private latchedDepthPct = 0;
  private latchedBpm = 6;

  get running(): boolean {
    return this.secTimer !== null;
  }

  /** True during Mode C's quiet Follow warm-up (before the controller exists): the host pauses the
   * cue/chime and the lens is held clear. Mode B (Static Pacer) and Mode A never settle. A manual
   * pace nudge OVERRIDES the settling pause — the user is actively dialling a rate, so the cue must
   * un-freeze and pace at it (the nudged rate also seeds where the search begins). */
  isSettling(): boolean {
    if (!this.running) return false;
    if (this.manualHoldActive()) return false;
    return this.mode === 'modeC' && this.modeB == null;
  }

  /** Exact breath-cycle length (ms) from a float rate, so the cue + BREATHE_SYNC honor 0.1-br/min
   * settings even though the pacer grid is 0.2 and 0xB1 is integer. Used by the Static Pacer and the
   * manual-nudge hold. */
  private bpmCycleMs(bpm: number): number {
    return Math.round(60_000 / bpm);
  }
  private staticCycleMs(): number {
    return this.bpmCycleMs(this.staticPacerBpm);
  }

  /** A Mode A / Mode C-warm-up manual nudge is currently holding the pace (auto-follow suspended).
   * Only true while no controller exists, so a live Mode C search is never overridden. Auto-expires. */
  private manualHoldActive(): boolean {
    if (this.manualBpm == null || this.modeB != null) return false;
    if (nowMs() >= this.manualHoldUntilMs) {
      this.manualBpm = null;
      return false;
    }
    return true;
  }

  /** Build/replace all sub-components against the current tunables object. */
  private rebuild(): void {
    this.ingest = new IBIIngest(this.t);
    this.ls = new LombScargleCore(this.t);
    this.pacer = new FollowPacer(this.t);
    this.amplitude = new FastAmplitudeTracker(this.t);
    this.resp = new RespirationFromACC(this.t);
  }

  start(opts: StartOptions): void {
    this.stop();
    // Copy tunables into our own object so sub-components share one live reference.
    this.t = { ...opts.tunables };
    this.source = opts.source;
    this.mode = opts.mode;
    this.brightness = opts.brightness ?? 100;
    this.difficulty = opts.difficulty ?? 1;
    this.lensStyle =
      opts.program != null ? PROGRAM_TO_STYLE[opts.program] : (opts.lensStyle ?? 'breathingGuide');
    this.strobeHz = opts.strobeHz ?? 10;
    this.strobeDutyPct = opts.strobeDutyPct ?? 50;
    this.onLens = opts.onLens;
    this.onSync = opts.onSync ?? null;
    this.rebuild();

    // Mode B is the Static Pacer: a FIXED user/clinician rate with Mode-A coherence feedback — no
    // ResonanceController, no follow. Mode A has no controller. Mode C starts in the Follow warm-up
    // (modeB == null) and the breath-boundary gate creates the controller later, seeded at the
    // settled rate. (priorRF is unused now — Mode B no longer searches.)
    this.staticMode = this.mode === 'modeB';
    this.modeB = null;
    this.seedOverrideBpm = null;
    this.manualBpm = null;
    this.manualHoldUntilMs = 0;
    if (this.staticMode) {
      this.staticPacerBpm = clampStaticPacerBpm(opts.staticPacerBpm ?? this.staticPacerBpm);
      this.pacer.snapToBPM(this.staticPacerBpm);
    }

    this.cycleMs = this.staticMode ? this.staticCycleMs() : this.pacer.latch();
    this.cycleStartMs = nowMs();
    this._coherence = 0;
    this._cr = 0;
    this._respHz = 0;
    this._breathHeartCoh = null;
    this._bhPhaseRe = 0;
    this._bhPhaseIm = 0;
    this._confounded = false;
    this._bhNullTicks = 0;
    this._lastDuty = 0;
    this._accMeasuredBpm = null;
    this._accRespConfidence = 0;
    this.gatedBeatsThisCycle = 0;
    // Mode C warm-up clock + sample windows start fresh (harmless/unused in Mode A/B).
    this.warmupStartS = this.cycleStartMs / 1000;
    this.warmupResp = [];
    this.warmupAcc = [];
    this.modeCAccConfident = false;
    this.modeCStable = false;

    // Start the timers BEFORE the first latch/emit so `running` (hence isSettling) is already true —
    // otherwise the initial lens state would skip the settling depth-0 hold.
    this.secTimer = setInterval(() => this.tick1Hz(), 1000);
    this.lensTimer = setInterval(() => this.lensTick(), LENS_TICK_MS);
    this.latchLensParams(); // seed the per-breath lens depth + rate from the initial state
    this.emitLens(); // push the initial lens state (firmware renders the cycle from here on)
    this.emitSync(); // anchor the glasses breathe phase to this cycle's start
    this.emitStatus();
  }

  stop(): void {
    if (this.secTimer) {
      clearInterval(this.secTimer);
      this.secTimer = null;
    }
    if (this.lensTimer) {
      clearInterval(this.lensTimer);
      this.lensTimer = null;
    }
    this.modeB = null;
    this.onLens = null;
    this.onSync = null;
    this.ingest.reset();
    this.resp.reset();
    this._accMeasuredBpm = null;
    this._accRespConfidence = 0;
    this.emitStatus();
  }

  /** Live-tune: apply changed tunable values without dropping engine state where possible. */
  setTunables(next: CoherenceTunables): void {
    const gridChanged =
      next.lsFreqLo !== this.t.lsFreqLo ||
      next.lsFreqHi !== this.t.lsFreqHi ||
      next.lsDf !== this.t.lsDf;
    // Mutate the shared object in place so every sub-component sees the new values.
    Object.assign(this.t, next);
    if (gridChanged) this.ls = new LombScargleCore(this.t);
  }

  setBrightness(b: number): void {
    this.brightness = Math.max(0, Math.min(100, b));
  }
  setDifficulty(d: number): void {
    this.difficulty = Math.max(0, Math.min(3, Math.round(d)));
  }

  /** Switch the rendered Standard program live (no engine restart). `p` is the UI's 1-4 number;
   * it maps to the lens style emitted to the host, which `edgeDevice.driveLens` renders
   * firmware-side. Re-emits immediately so the lens changes without waiting for the next tick. */
  setProgram(p: LensProgram): void {
    this.lensStyle = PROGRAM_TO_STYLE[p] ?? this.lensStyle;
    if (this.running) this.emitLens();
  }

  /** Converged Mode B RF (only when maintaining), for the host to persist. */
  storedRF(): number | null {
    return this.modeB?.state === 'maintaining' ? this.modeB.lockedRF : null;
  }

  /** Current Static Pacer rate (br/min) — for the host to read/persist. */
  get staticBpm(): number {
    return this.staticPacerBpm;
  }

  /** Live-set the Static Pacer rate (Mode B). Clamps to 4.0–10.0 on the 0.1 grid, retargets the
   * breath clock + cue + lens immediately, and re-anchors the cycle so the new rate starts a fresh
   * breath. When not running (or not in static mode) it just stores the value for the next start. */
  setStaticPacerBpm(bpm: number): void {
    this.staticPacerBpm = clampStaticPacerBpm(bpm);
    if (!this.running || !this.staticMode) return;
    this.pacer.snapToBPM(this.staticPacerBpm);
    this.cycleMs = this.staticCycleMs();
    this.cycleStartMs = nowMs(); // restart the breath cleanly at the new rate
    this.latchLensParams();
    this.emitLens();
    this.emitSync();
    this.emitStatus();
  }

  /** Manual ± pace nudge (the UI uses ±0.1 br/min). Behavior per mode:
   *  - Mode B (Static Pacer) → change the fixed rate (the host persists it).
   *  - Mode A → HOLD the nudged pace for ~a few cycles (auto-follow suspended), then following resumes.
   *  - Mode C, searching/locked → NEVER ignored: immediately restart a fresh dwell at the nudged rate
   *    (re-enters `searching` from a locked state).
   *  - Mode C, warm-up → hold the nudged pace now AND seed the search to begin there. */
  nudgePacer(deltaBpm: number): void {
    if (!this.running) return;
    if (this.staticMode) {
      this.setStaticPacerBpm(this.staticPacerBpm + deltaBpm);
      return;
    }
    // Mode C with a live controller: restart the resonance test at the nudged rate.
    if (this.mode === 'modeC' && this.modeB) {
      this.modeB.reseed(this.modeB.commandedBPM + deltaBpm);
      this.pacer.snapToBPM(this.modeB.commandedBPM);
      this.cycleMs = this.pacer.latch();
      this.latchLensParams();
      this.emitLens();
      this.emitSync();
      this.emitStatus();
      return;
    }
    // Mode A, or Mode C warm-up: hold the nudged pace (suspending auto-follow) so it visibly sticks,
    // then auto-follow resumes when the hold expires.
    const base = this.manualBpm ?? this.pacer.currentQuintet / 5.0;
    const lo = this.mode === 'modeC' ? this.t.searchLoBPM : this.t.quintetMin / 5.0;
    const hi = this.mode === 'modeC' ? this.t.searchHiBPM : this.t.quintetMax / 5.0;
    const next = Math.min(hi, Math.max(lo, Math.round((base + deltaBpm) / 0.1) * 0.1));
    this.manualBpm = next;
    this.manualHoldUntilMs = nowMs() + MANUAL_NUDGE_HOLD_MS;
    this.pacer.snapToBPM(next); // keep the pacer aligned for when the hold ends
    if (this.mode === 'modeC') this.seedOverrideBpm = next; // search begins here if the gate fires during the hold
    this.cycleMs = this.bpmCycleMs(next);
    this.latchLensParams();
    this.emitLens();
    this.emitSync();
    this.emitStatus();
  }

  // --- input callbacks ---

  /** Primary H10 path. `rrsMs` straight from the BLE HR-Measurement parse (oldest-first). */
  onH10RR(rrsMs: number[], confidence: number, tArrivalS: number): void {
    const rr1024 = rrsMs.map((ms) => Math.max(0, Math.min(65535, Math.round((ms * 1024.0) / 1000.0))));
    const tally = this.ingest.pushH10(rr1024, confidence, tArrivalS);
    if (tally.rejected > 0) this.gatedBeatsThisCycle += tally.rejected;
  }

  /** Non-H10 single-beat path (e.g. edge relay / earclip). */
  onRR(rrMs: number, confidence: number, nowS: number): void {
    const ok = this.ingest.push(rrMs, confidence, nowS);
    if (!ok) this.gatedBeatsThisCycle += 1;
  }

  /** H10 ACC packet: a block of samples sharing one arrival time (Mode B only). */
  onAccPacket(samples: Array<{ x: number; y: number; z: number }>, tArrivalS: number): void {
    if (!allowsModeB(this.source)) return;
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const st = tArrivalS - (n - 1 - i) / Math.max(1.0, this.t.accSampleHz); // newest lands at tArrivalS
      this.resp.push(samples[i].x, samples[i].y, samples[i].z, st);
    }
  }

  /** Single ACC sample (non-batched sources). */
  onAcc(x: number, y: number, z: number, nowS: number): void {
    if (!allowsModeB(this.source)) return;
    this.resp.push(x, y, z, nowS);
  }

  /** Call on source disconnect so a new session never inherits stale state. */
  onDisconnect(): void {
    this.ingest.reset();
    this.resp.reset();
  }

  getStatus(): EngineStatus {
    return {
      running: this.running,
      mode: this.mode,
      source: this.source,
      coherence: this._coherence,
      cr: this._cr,
      respHz: this._respHz,
      // Static Pacer / manual-hold report their exact float rate (0.1); else the 0.2-grid pacer.
      pacerBpm: this.staticMode
        ? this.staticPacerBpm
        : this.manualHoldActive()
          ? (this.manualBpm as number)
          : this.pacer.currentQuintet / 5.0,
      duty: this._lastDuty,
      beats: this.ingest.window(this.t.coherenceWindowS).length,
      breathHeartCoherence: this._breathHeartCoh,
      // Phase is only meaningful when coherence is significant — hide it below the floor so a flailing
      // angle never shows. The value is the γ²-weighted circular mean of the per-tick phases.
      breathHeartPhaseDeg:
        this._breathHeartCoh != null && this._breathHeartCoh >= GAMMA2_CONFOUND_FLOOR
          ? (Math.atan2(this._bhPhaseIm, this._bhPhaseRe) * 180) / Math.PI
          : null,
      coherenceConfounded: this._confounded,
      modeBState: this.modeB?.state ?? null,
      modeBCommandedBpm: this.modeB ? this.modeB.commandedBPM : null,
      modeBProgress: this.modeB && this.modeB.state === 'searching' ? this.modeB.searchProgress() : null,
      lockedRF: this.modeB?.state === 'maintaining' ? this.modeB.lockedRF : null,
      boundaryLimited: this.modeB?.boundaryLimited ?? false,
      searchAborted: this.modeB?.searchAborted ?? false,
      unverifiedDwells: this.modeB?.unverifiedDwells ?? 0,
      unmeasuredDwells: this.modeB?.unmeasuredDwells ?? 0,
      searchAbortReason: this.modeB?.searchAbortReason ?? null,
      accMeasuredBpm: this._accMeasuredBpm,
      accRespConfidence: this._accRespConfidence,
      modeBVerifiedRatio: this.modeB?.verifiedRatio ?? null,
      // Mode C phase is derived from the controller's existence/state — in 'warmup' (modeB == null)
      // every Mode B field above is already null/defaulted, so no stale resonance data leaks out.
      modeCPhase:
        this.mode !== 'modeC'
          ? null
          : this.modeB == null
            ? 'warmup'
            : this.modeB.state === 'maintaining'
              ? 'maintaining'
              : 'searching',
      modeCAccConfident: this.mode === 'modeC' && this.modeB == null ? this.modeCAccConfident : false,
      modeCStable: this.mode === 'modeC' && this.modeB == null ? this.modeCStable : false,
      settling: this.isSettling(),
      staticPacerBpm: this.staticMode ? this.staticPacerBpm : null,
      staticMode: this.staticMode,
    };
  }

  // --- timers ---

  /** 1 Hz tick — Mode A coherence + resonance readback. */
  private tick1Hz(): void {
    const win = this.ingest.window(this.t.coherenceWindowS);
    const r = this.ls.compute(win);
    if (r) {
      // The detected rate feeds the Follow pacer ONLY while no controller exists (Mode A, and
      // Mode C before the gate fires). Once a controller exists (Mode B, or Mode C after handoff)
      // the controller is the sole pacer source via onBreathBoundary's setTargetBPM — guarding
      // here makes that source switch explicit instead of relying on the per-breath ring collapse.
      // (In Mode B this is a no-op: setTargetBPM overwrites the ring every breath regardless.)
      // Mode B (Static Pacer) NEVER follows; a manual-nudge hold also suspends following briefly.
      if (this.modeB == null && !this.staticMode && !this.manualHoldActive()) this.pacer.push(r.respPeakMhz);
      this._coherence = r.cohPercent; // single-signal CR squash — drives the lens (UNCHANGED)
      this._cr = r.cr;
      this._respHz = r.respPeakHz;
    }
    // Mode A's REAL coherence: cross-spectral γ² between the H10-ACC respiration and heart rate. Needs
    // an ACC stream (resp.estimate() non-null); null when absent/too short. Does NOT drive the lens —
    // it is surfaced honestly alongside the CR. The pacer/lens stay on the CR path above.
    const est = this.resp.estimate();
    const bh =
      r && est
        ? computeBreathHeartCoherence(win, this.resp.magnitudeWindow(), r.respPeakHz, est.bpm / 60, this.t)
        : null;
    // Temporal averaging makes the readout meaningful: a 1 Hz cross-spectrum from ~3 Welch segments is
    // high-variance, so EWMA the γ² and take a coherence-WEIGHTED circular mean of the phase (low-γ²
    // ticks barely move the angle). Brief gaps (bh == null) HOLD the last smoothed value; a SUSTAINED
    // gap (ACC truly gone) decays it to null so the UI falls back to "needs a Polar H10".
    if (bh) {
      const a = Math.max(0, Math.min(1, this.t.bhSmoothAlpha));
      this._breathHeartCoh =
        this._breathHeartCoh == null ? bh.gammaSq : a * bh.gammaSq + (1 - a) * this._breathHeartCoh;
      const th = (bh.phaseDeg * Math.PI) / 180;
      const w = bh.gammaSq; // weight the phase phasor by instantaneous coherence
      this._bhPhaseRe = a * (w * Math.cos(th)) + (1 - a) * this._bhPhaseRe;
      this._bhPhaseIm = a * (w * Math.sin(th)) + (1 - a) * this._bhPhaseIm;
      this._confounded = bh.rateMismatch || this._breathHeartCoh < GAMMA2_CONFOUND_FLOOR;
      this._bhNullTicks = 0;
    } else if (++this._bhNullTicks > BH_NULL_RESET_TICKS) {
      this._breathHeartCoh = null;
      this._bhPhaseRe = 0;
      this._bhPhaseIm = 0;
      this._confounded = false;
    }
    // Mode C warm-up: sample the UNSMOOTHED detected rate + the independent ACC respiration
    // confidence at 1 Hz for the transition gate (deliberately NOT the slew-limited pacer output,
    // which reads "stable" by construction even for an erratic breather).
    if (this.mode === 'modeC' && this.modeB == null) {
      this.collectWarmupSample(r ? r.respPeakHz : null, nowMs() / 1000);
    }
    this.emitLens();
    this.emitStatus();
  }

  /** Mode C warm-up: record one 1 Hz gate sample and refresh the gate readout. */
  private collectWarmupSample(respHz: number | null, nowS: number): void {
    if (respHz != null && respHz > 0) {
      this.warmupResp.push({ s: nowS, bpm: respHz * 60.0 });
    }
    const est = this.resp.estimate();
    this.warmupAcc.push({ s: nowS, ok: est != null && est.confidence >= this.t.respConfidenceMin });
    const cutoff = nowS - this.t.modeCStabilityWindowS;
    while (this.warmupResp.length > 0 && this.warmupResp[0].s < cutoff) this.warmupResp.shift();
    while (this.warmupAcc.length > 0 && this.warmupAcc[0].s < cutoff) this.warmupAcc.shift();
    const g = evaluateModeCGate(this.warmupResp, this.warmupAcc, nowS - this.warmupStartS, nowS, this.t);
    this.modeCAccConfident = g.accConfident;
    this.modeCStable = g.stable;
  }

  /** Per breathing-cycle boundary. Advances the pacer (and Mode B controller), returns nothing. */
  private onBreathBoundary(nowS: number): void {
    const cycleClean = this.gatedBeatsThisCycle === 0;
    this.gatedBeatsThisCycle = 0;

    // Mode C warm-up (no controller yet) → run the Follow path and evaluate the transition gate.
    // On a pass, hand off atomically THIS tick (create the seeded controller + hard-snap the
    // pacer). Until then this branch is byte-for-byte Mode A: it falls through to latch + emit.
    let handedOff = false;
    if (this.mode === 'modeC' && this.modeB == null) {
      handedOff = this.tryModeCHandoff(nowS);
    }

    // The resonance controller (Mode C after handoff) drives the dwell. Mode B is the Static Pacer
    // and has no controller, so this block never runs there.
    if (this.modeB && !handedOff) {
      const amp = this.amplitude.amplitude(
        this.ingest.window(this.t.coherenceWindowS),
        this.modeB.commandedBPM,
      );
      const r = this.resp.estimate();
      this._accMeasuredBpm = r ? r.bpm : null; // cache for the status readout + metrics record
      this._accRespConfidence = r ? r.confidence : 0;
      const pacedBPM = this.pacer.currentQuintet / 5.0;
      const bpm = this.modeB.onBreathCycle({
        cycleAmplitude: amp,
        measuredBPM: this._accMeasuredBpm,
        respConfidence: this._accRespConfidence,
        pacedBPM,
        dwellArtifactClean: cycleClean,
        nowS,
      });
      this.pacer.setTargetBPM(bpm); // Mode B drives; pacer slews smoothly

      // Mode C ONLY: a search that gives up (persistently unverifiable breathing) drops the
      // controller and returns to the honest Follow warm-up, re-running the gate — never sit
      // stuck in 'searching'. Mode B keeps its own searchAborted behavior unchanged.
      if (this.mode === 'modeC' && this.modeB.searchAborted) {
        this.enterModeCWarmup(nowS);
      }
    }
    // Static Pacer holds the fixed float rate; a manual-nudge hold holds its float rate; otherwise
    // advance the pacer's slew limiter.
    this.cycleMs = this.staticMode
      ? this.staticCycleMs()
      : this.manualHoldActive()
        ? this.bpmCycleMs(this.manualBpm as number)
        : this.pacer.latch();
    this.latchLensParams(); // re-sample depth + rate ONCE per breath, at the seam (frac ≈ 0)
    this.emitStatus();
  }

  /**
   * Mode C warm-up→search gate, evaluated once per breath. Returns true (and performs the atomic
   * handoff) when the gate passes:
   *   1. create the EXISTING Mode B controller seeded at the settled rate,
   *   2. HARD-snap the pacer to the seed (not a glide),
   * after which tick1Hz's `this.modeB == null` guard stops the detected-rate pushes and the
   * controller becomes the sole pacer source — i.e. "Mode A until the gate, then Mode B".
   */
  private tryModeCHandoff(nowS: number): boolean {
    const g = evaluateModeCGate(this.warmupResp, this.warmupAcc, nowS - this.warmupStartS, nowS, this.t);
    this.modeCAccConfident = g.accConfident;
    this.modeCStable = g.stable;
    if (!g.canTransition) return false;
    // A manual nudge during warm-up overrides where the search begins (the user's first cycle rate).
    const seed = this.seedOverrideBpm ?? g.seedBPM;
    this.seedOverrideBpm = null;
    this.modeB = new ResonanceController(this.t, seed);
    this.pacer.snapToBPM(seed);
    return true;
  }

  /** Mode C: drop any controller and reset the Follow warm-up (clock + gate windows). */
  private enterModeCWarmup(nowS: number): void {
    this.modeB = null;
    this.warmupStartS = nowS;
    this.warmupResp = [];
    this.warmupAcc = [];
    this.modeCAccConfident = false;
    this.modeCStable = false;
    this.seedOverrideBpm = null;
  }

  /** Breath-clock tick: detect cycle boundaries (pacer latch / Mode B controller). The lens
   * waveform is rendered by the firmware now — we only push high-level params (emitLens), so
   * there is no per-tick PWM stream. */
  private lensTick(): void {
    const now = nowMs();
    if (now - this.cycleStartMs >= this.cycleMs) {
      this.onBreathBoundary(now / 1000.0);
      this.cycleStartMs = now;
      this.emitLens(); // the latched rate may have changed at the boundary
      this.emitSync(); // re-anchor the glasses to this cycle (exact length may have changed)
    }
  }

  /** Peak lens darkness from the engine's (app-side) coherence + difficulty gamma. At difficulty
   * 0 (easy) this is linear: depth = brightness·(100−coh)/100 → 0%→full dark, 50%→half, 100%→clear. */
  private depthFromCoherence(): number {
    const s = Math.max(0, Math.min(100, this._coherence));
    const table = gammaTable(this.t);
    const g = table[Math.max(0, Math.min(table.length - 1, this.difficulty))];
    const clearPct = Math.pow(s / 100, g) * 100;
    return Math.max(0, Math.min(100, (this.brightness * (100 - clearPct)) / 100));
  }

  /** Latch the lens depth + rate for the whole upcoming breath. Sampled at start and at each breath
   * boundary (where frac ≈ 0, so the change is invisible). Holding them constant within a breath is
   * what keeps the firmware's effective_duty = wave×depth monotonic — pushing a new depth/rate
   * mid-inhale is what made the lens "darken → clear a bit → darken." */
  private latchLensParams(): void {
    // During the quiet settling the lens is held fully clear (no breathing/coherence fade) — the
    // depth-0 setpoint is sent to the firmware (0xA2/0xA5) so the glasses never modulate while the
    // user just settles in.
    this.latchedDepthPct = this.isSettling() ? 0 : Math.round(this.depthFromCoherence());
    // Firmware 0xB1 is integer BPM; the exact float cycle still rides BREATHE_SYNC (staticCycleMs).
    this.latchedBpm = Math.round(this.staticMode ? this.staticPacerBpm : this.pacer.currentQuintet / 5.0);
  }

  /** Push the desired lens state to the host (coalesced into firmware commands downstream). Sends the
   * LATCHED per-breath depth + rate, so the ~1 Hz calls never change a value mid-breath — only the
   * boundary re-latch does. Called on start, ~1 Hz, and at each breath boundary. */
  private emitLens(): void {
    this._lastDuty = this.latchedDepthPct;
    this.onLens?.({
      style: this.lensStyle,
      bpm: this.latchedBpm,
      depthPct: this.latchedDepthPct,
      inhalePct: Math.round(this.t.breatheInhalePct),
      strobeHz: this.strobeHz,
      strobeDutyPct: this.strobeDutyPct,
    });
  }

  /** Push the current breath cycle (exact length ms + inhale %) to the host so it can phase-lock
   * the glasses lens to this clock. Fired at start and at each cycle boundary (= inhale start), so
   * a re-anchor always lands where the waveform value is ~0 (smooth). */
  private emitSync(): void {
    this.onSync?.(Math.round(this.cycleMs), Math.round(this.t.breatheInhalePct));
  }

  /** Re-push lens state + breath sync immediately — e.g. when the glasses (re)connect while the
   * engine is already running, so they don't wait up to a full cycle to catch up. The next cycle
   * boundary then re-anchors precisely. No-op when not running. */
  resync(): void {
    if (!this.running) return;
    this.emitLens();
    this.emitSync();
  }

  /** Current breath-cycle position 0..1, for the on-screen cue + chime to lock to the engine
   * clock (the same clock that commands the firmware rate). null when not running. */
  breathCyclePos(): number | null {
    if (!this.running || this.cycleMs <= 0) return null;
    let p = (nowMs() - this.cycleStartMs) / this.cycleMs;
    p -= Math.floor(p);
    return p;
  }

  /** Engine pacer rate (BPM) for the on-screen cue. */
  get breathBpm(): number {
    if (this.staticMode) return this.staticPacerBpm;
    if (this.manualHoldActive()) return this.manualBpm as number;
    return this.pacer.currentQuintet / 5.0;
  }

  private emitStatus(): void {
    this.dispatchEvent(new CustomEvent<EngineStatus>('status', { detail: this.getStatus() }));
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export interface ModeCGateResult {
  /** ACC respiration confident across a rolling fraction of the stability window. MANDATORY. */
  accConfident: boolean;
  /** Detected-rate SD over the window is within modeCStabilityBpmSd. */
  stable: boolean;
  /** Windowed-mean detected rate, clamped to the resonance search band — seeds the controller. */
  seedBPM: number;
  /** accConfident && elapsed≥modeCWarmupS && (stable || elapsed≥modeCWarmupMaxS). */
  canTransition: boolean;
}

/** Fraction of the stability window's ACC samples that must be confident (NOT a single frame). */
const MODE_C_ACC_CONFIDENT_FRACTION = 0.6;

/**
 * Pure Mode C warm-up→search gate. Decides whether to leave the Follow warm-up and start the
 * seeded resonance search, from the UNSMOOTHED detected breathing rate (LS LF-readback peak, BPM)
 * and the independent ACC respiration confidence over the trailing stability window:
 *
 *   canTransition = accConfident && elapsed≥modeCWarmupS && (stable || elapsed≥modeCWarmupMaxS)
 *
 * ACC confidence is MANDATORY and is NEVER relaxed — the cap relaxes ONLY `stable`. With no
 * confident ACC the user simply stays in warm-up indefinitely (an honest wait, strictly better
 * than racking up unverifiable dwells). `seedBPM` is the windowed-mean detected rate (clamped to
 * the search band) so the search begins where the user actually settled.
 */
export function evaluateModeCGate(
  resp: ReadonlyArray<{ s: number; bpm: number }>,
  acc: ReadonlyArray<{ s: number; ok: boolean }>,
  elapsedS: number,
  nowS: number,
  t: CoherenceTunables,
): ModeCGateResult {
  const winLo = nowS - t.modeCStabilityWindowS;
  const respIn = resp.filter((e) => e.s >= winLo);
  const accIn = acc.filter((e) => e.s >= winLo);
  // Require the window to be populated (~1 Hz samples) so neither sub-gate fires on a sparse window.
  const minSamples = Math.max(2, Math.floor(t.modeCStabilityWindowS * 0.5));

  const accCount = accIn.length;
  const confidentCount = accIn.reduce((n, e) => n + (e.ok ? 1 : 0), 0);
  const accConfident =
    accCount >= minSamples && confidentCount >= MODE_C_ACC_CONFIDENT_FRACTION * accCount;

  let stable = false;
  let mean = 0;
  if (respIn.length >= minSamples) {
    mean = respIn.reduce((s, e) => s + e.bpm, 0) / respIn.length;
    const variance =
      respIn.reduce((s, e) => s + (e.bpm - mean) * (e.bpm - mean), 0) / (respIn.length - 1);
    stable = Math.sqrt(Math.max(0, variance)) <= t.modeCStabilityBpmSd;
  }
  // Seed at the windowed mean (fall back to the canonical 6.0 only if no detected-rate samples
  // exist at all — beats absent). Always clamp into the band the controller searches.
  const rawSeed = respIn.length > 0 ? mean : 6.0;
  const seedBPM = Math.min(t.searchHiBPM, Math.max(t.searchLoBPM, rawSeed));

  const canTransition =
    accConfident && elapsedS >= t.modeCWarmupS && (stable || elapsedS >= t.modeCWarmupMaxS);

  return { accConfident, stable, seedBPM, canTransition };
}

/** Shared singleton — mirrors `edgeDevice` / `polarH10`. */
export const coherenceEngine = new CoherenceEngine();
