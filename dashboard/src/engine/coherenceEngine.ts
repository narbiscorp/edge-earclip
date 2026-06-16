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

export type { EngineMode } from './tunables';

export type HRVSource = 'polarH10' | 'edgeRelay' | 'appleWatch';
export type ActiveEngineMode = 'modeA' | 'modeB' | 'modeC';
export type LensStyle = 'breathingGuide' | 'coherenceLens' | 'breatheStrobe';

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
}

export interface StartOptions {
  mode: ActiveEngineMode;
  source: HRVSource;
  tunables: CoherenceTunables;
  /** 0..100 lens brightness ceiling. */
  brightness?: number;
  /** 0..3 difficulty (gamma curve on coherence → lens depth). */
  difficulty?: number;
  lensStyle?: LensStyle;
  strobeHz?: number;
  strobeDutyPct?: number;
  /** Persisted per-user resonance frequency for a warm Mode B start. */
  priorRF?: number | null;
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

  // published outputs
  private _coherence = 0;
  private _cr = 0;
  private _respHz = 0;
  private _lastDuty = 0;
  // ACC respiration estimate cached at each breath boundary (Mode B verification input), for status.
  private _accMeasuredBpm: number | null = null;
  private _accRespConfidence = 0;

  get running(): boolean {
    return this.secTimer !== null;
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
    this.lensStyle = opts.lensStyle ?? 'breathingGuide';
    this.strobeHz = opts.strobeHz ?? 10;
    this.strobeDutyPct = opts.strobeDutyPct ?? 50;
    this.onLens = opts.onLens;
    this.onSync = opts.onSync ?? null;
    this.rebuild();

    // Mode B creates its controller up front. Mode C does NOT — it starts in the Follow warm-up
    // (modeB == null) and the breath-boundary gate creates the controller later, seeded at the
    // settled rate. Mode A never has a controller.
    if (this.mode === 'modeB' && allowsModeB(this.source)) {
      this.modeB = new ResonanceController(this.t, opts.priorRF ?? undefined);
      // Snap the pacer to the controller's start rate so the first dwell isn't measured mid-slew.
      this.pacer.snapToBPM(this.modeB.commandedBPM);
    } else {
      this.modeB = null;
    }

    this.cycleMs = this.pacer.latch();
    this.cycleStartMs = nowMs();
    this._coherence = 0;
    this._cr = 0;
    this._respHz = 0;
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

    this.secTimer = setInterval(() => this.tick1Hz(), 1000);
    this.lensTimer = setInterval(() => this.lensTick(), LENS_TICK_MS);
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

  /** Converged Mode B RF (only when maintaining), for the host to persist. */
  storedRF(): number | null {
    return this.modeB?.state === 'maintaining' ? this.modeB.lockedRF : null;
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
      pacerBpm: this.pacer.currentQuintet / 5.0,
      duty: this._lastDuty,
      beats: this.ingest.window(this.t.coherenceWindowS).length,
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
    };
  }

  // --- timers ---

  /** 1 Hz tick — Mode A coherence + resonance readback. */
  private tick1Hz(): void {
    const r = this.ls.compute(this.ingest.window(this.t.coherenceWindowS));
    if (r) {
      // The detected rate feeds the Follow pacer ONLY while no controller exists (Mode A, and
      // Mode C before the gate fires). Once a controller exists (Mode B, or Mode C after handoff)
      // the controller is the sole pacer source via onBreathBoundary's setTargetBPM — guarding
      // here makes that source switch explicit instead of relying on the per-breath ring collapse.
      // (In Mode B this is a no-op: setTargetBPM overwrites the ring every breath regardless.)
      if (this.modeB == null) this.pacer.push(r.respPeakMhz);
      this._coherence = r.cohPercent;
      this._cr = r.cr;
      this._respHz = r.respPeakHz;
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
    this.cycleMs = this.pacer.latch();
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
    this.modeB = new ResonanceController(this.t, g.seedBPM);
    this.pacer.snapToBPM(g.seedBPM);
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

  /** Push the desired lens state to the host (coalesced into firmware commands downstream).
   * Called on start, ~1 Hz, and at each breath boundary — NOT per render tick. */
  private emitLens(): void {
    const depthPct = Math.round(this.depthFromCoherence());
    this._lastDuty = depthPct;
    this.onLens?.({
      style: this.lensStyle,
      bpm: Math.round(this.pacer.currentQuintet / 5.0),
      depthPct,
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
