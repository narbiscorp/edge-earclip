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
export type ActiveEngineMode = 'modeA' | 'modeB';
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

/** Mode B needs validated RR + an independent respiration channel (H10 ACC). */
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
    this.rebuild();

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

    this.secTimer = setInterval(() => this.tick1Hz(), 1000);
    this.lensTimer = setInterval(() => this.lensTick(), LENS_TICK_MS);
    this.emitLens(); // push the initial lens state (firmware renders the cycle from here on)
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
    };
  }

  // --- timers ---

  /** 1 Hz tick — Mode A coherence + resonance readback. */
  private tick1Hz(): void {
    const r = this.ls.compute(this.ingest.window(this.t.coherenceWindowS));
    if (r) {
      this.pacer.push(r.respPeakMhz); // feeds the follow pacer
      this._coherence = r.cohPercent;
      this._cr = r.cr;
      this._respHz = r.respPeakHz;
    }
    this.emitLens();
    this.emitStatus();
  }

  /** Per breathing-cycle boundary. Advances the pacer (and Mode B controller), returns nothing. */
  private onBreathBoundary(nowS: number): void {
    const cycleClean = this.gatedBeatsThisCycle === 0;
    this.gatedBeatsThisCycle = 0;

    if (this.modeB) {
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
    }
    this.cycleMs = this.pacer.latch();
    this.emitStatus();
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

/** Shared singleton — mirrors `edgeDevice` / `polarH10`. */
export const coherenceEngine = new CoherenceEngine();
